import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChatService } from "./chat.js";
import { HA_TOOLS } from "./hass/tools.js";
import type { ServerEvent } from "./protocol.js";
import type { Provider, TurnContext } from "./providers/types.js";
import { ConversationStore } from "./store.js";
import { UploadStore } from "./uploads.js";

/** A provider whose turn runs whatever the test hands it. */
class ScriptedProvider implements Provider {
  readonly id = "mock" as const;
  readonly label = "Scripted";
  readonly defaultMode = "ask";
  readonly modes = [
    { id: "ask", label: "Ask", description: "", risk: "normal" as const },
    { id: "auto", label: "Auto", description: "", risk: "danger" as const },
  ];
  script: (ctx: TurnContext) => Promise<void> = async () => {};
  async models() {
    return [];
  }
  async auth() {
    return { state: "signed-in" as const };
  }
  async run(ctx: TurnContext) {
    await this.script(ctx);
    return { status: "completed" as const };
  }
}

const tool = (name: string) => HA_TOOLS.find((t) => t.name === name)!;
const tokenOf = (ctx: TurnContext) => ctx.mcp!.url.split("/").pop()!;

let dir = "";
let chat: ChatService;
let store: ConversationStore;
const provider = new ScriptedProvider();
const events: ServerEvent[] = [];
const ended = new Map<string, () => void>();

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "twinmind-chat-"));
  store = new ConversationStore(dir);
  const uploads = new UploadStore(dir, 1024);
  await store.init();
  await uploads.init();
  chat = new ChatService(store, uploads, new Map([["mock", provider]]), dir, (e) => {
    events.push(e);
    if (e.type === "turn.end") ended.get(e.conversationId)?.();
  });
  chat.attachMcp({ secret: "s", url: (t) => `http://127.0.0.1:1/mcp/${t}`, close: async () => {} });
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Run one turn; resolves with the conversation id once it ended. */
async function turn(mode: string, script: (ctx: TurnContext) => Promise<void>, conversationId?: string): Promise<string> {
  provider.script = script;
  const before = events.length;
  await chat.send({ type: "send", clientRequestId: "r", provider: "mock", mode, text: "go", conversationId });
  const cid = conversationId ?? (events.slice(before).find((e) => e.type === "conversation") as any).meta.id;
  await new Promise<void>((r) => {
    ended.set(cid, r);
    if (events.slice(before).some((e) => e.type === "turn.end" && e.conversationId === cid)) r();
  });
  return cid;
}

/** Answer the next approval card with `decision`; returns how many cards were shown. */
function autoAnswer(decision: "allow" | "allow-session" | "deny") {
  let asked = 0;
  const seen = new Set<string>();
  const timer = setInterval(() => {
    for (const e of events) {
      if (e.type !== "part" || e.part.type !== "tool" || !e.part.approval || e.part.approval.decision) continue;
      if (seen.has(e.part.approval.id)) continue;
      seen.add(e.part.approval.id);
      asked++;
      chat.approve(e.part.approval.id, decision);
    }
  }, 5);
  return { asked: () => asked, stop: () => clearInterval(timer) };
}

describe("Home Assistant approval gate", () => {
  it("remembers 'Always' for one raw command only, and never for sensitive ones", async () => {
    const answer = autoAnswer("allow-session");
    const results: boolean[] = [];
    const calls: [string, any][] = [
      ["ha_websocket", { type: "config_entries/delete" }],
      ["ha_websocket", { type: "config_entries/delete" }], // remembered
      ["ha_websocket", { type: "config/area_registry/create" }], // another command: asks
      ["ha_websocket", { type: "auth/long_lived_access_token" }],
      ["ha_websocket", { type: "auth/long_lived_access_token" }], // sensitive: asks again
      ["ha_rest", { method: "POST", path: "/hassio/addons/x/start" }],
      ["ha_rest", { method: "POST", path: "/hassio/addons/x/start" }], // sensitive: asks again
      ["ha_update_entity", {}],
      ["ha_update_entity", {}], // remembered
    ];
    await turn("ask", async (ctx) => {
      const s = chat.session(tokenOf(ctx))!;
      for (const [name, args] of calls) results.push((await s.decide(tool(name), args, name)).ok);
    });
    answer.stop();
    expect(results.every(Boolean)).toBe(true);
    expect(answer.asked()).toBe(7);
  });

  it("refuses a change from a turn that has already ended", async () => {
    let stale: ReturnType<ChatService["session"]> = null;
    const cid = await turn("auto", async (ctx) => {
      stale = chat.session(tokenOf(ctx));
    });
    expect(stale).not.toBeNull();
    expect(chat.isRunning(cid)).toBe(false);
    const d = await stale!.decide(tool("ha_call_service"), {}, "light.turn_on");
    expect(d.ok).toBe(false);
  });

  it("does not decide a request from an earlier turn with that turn's mode", async () => {
    // Turn 1 runs in "auto" (changes allowed); the request is decided only during turn 2 ("ask").
    let stale: ReturnType<ChatService["session"]> = null;
    const cid = await turn("auto", async (ctx) => {
      stale = chat.session(tokenOf(ctx));
    });
    const answer = autoAnswer("deny");
    let result: boolean | undefined;
    await turn(
      "ask",
      async () => {
        result = (await stale!.decide(tool("ha_call_service"), {}, "light.turn_on")).ok;
      },
      cid,
    );
    answer.stop();
    expect(result).toBe(false);
  });
});

describe("messages sent while a reply is running", () => {
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(cond()).toBe(true);
  };
  const send = (text: string, conversationId?: string) =>
    chat.send({ type: "send", clientRequestId: "r", provider: "mock", mode: "ask", text, conversationId });
  /** Starts a turn that runs until release() is called; returns its conversation id. */
  async function startBlocked(onCtx: (ctx: TurnContext) => void = () => {}) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const prompts: string[] = [];
    provider.script = async (ctx) => {
      prompts.push(ctx.prompt);
      ctx.emit({ type: "native-id", id: "native-1" });
      onCtx(ctx);
      if (prompts.length === 1) await gate;
    };
    const before = events.length;
    await send("first");
    const cid = (events.slice(before).find((e) => e.type === "conversation") as any).meta.id as string;
    await until(() => prompts.length === 1);
    return { cid, release, prompts };
  }
  const messages = (cid: string) => store.get(cid)!.messages;
  const textOf = (m: any) => m.parts.find((p: any) => p.type === "text")?.text;

  it("queues a message and sends it when the reply ends", async () => {
    const { cid, release, prompts } = await startBlocked();
    await send("second", cid);
    expect(messages(cid).map((m) => [m.role, textOf(m) ?? "", !!m.queued])).toEqual([
      ["user", "first", false],
      ["assistant", "", false],
      ["user", "second", true],
    ]);
    release();
    await until(() => prompts.length === 2 && !chat.isRunning(cid));
    expect(prompts[1]).toBe("second");
    expect(messages(cid).map((m) => [m.role, !!m.queued])).toEqual([
      ["user", false],
      ["assistant", false],
      ["user", false],
      ["assistant", false],
    ]);
    expect(messages(cid).at(-1)!.status).toBe("completed");
  });

  it("sends several queued messages together, as one turn", async () => {
    const { cid, release, prompts } = await startBlocked();
    await send("second", cid);
    await send("third", cid);
    release();
    await until(() => prompts.length === 2 && !chat.isRunning(cid));
    await new Promise((r) => setTimeout(r, 20));
    expect(prompts).toEqual(["first", "second\n\nthird"]);
    expect(messages(cid).map((m) => m.role)).toEqual(["user", "assistant", "user", "user", "assistant"]);
  });

  it("steers a message into the running reply; later output goes below it", async () => {
    const steered: string[] = [];
    let ctxRef!: TurnContext;
    const { cid, release } = await startBlocked((ctx) => {
      ctxRef = ctx;
      ctx.setSteer?.(async ({ text }) => (steered.push(text), true));
      ctx.emit({ type: "part", part: { type: "text", id: "t1", text: "before" } });
    });
    await send("steer me", cid);
    expect(steered).toEqual(["steer me"]);
    ctxRef.emit({ type: "part", part: { type: "text", id: "t2", text: "after" } });
    // A part from before the steered message is still updated in place.
    ctxRef.emit({ type: "part", part: { type: "text", id: "t1", text: "before, updated" } });
    release();
    await until(() => !chat.isRunning(cid));
    expect(messages(cid).map((m) => [m.role, m.parts.map((p: any) => p.text ?? "").join("|"), m.queued ?? false, m.status ?? ""])).toEqual([
      ["user", "first", false, ""],
      ["assistant", "before, updated", false, "completed"],
      ["user", "steer me", false, ""],
      ["assistant", "after", false, "completed"],
    ]);
  });

  it("drops the part of a reply that a steered message split off before anything was said", async () => {
    const { cid, release } = await startBlocked((ctx) => ctx.setSteer?.(async () => true));
    await send("right away", cid);
    release();
    await until(() => !chat.isRunning(cid));
    expect(messages(cid).map((m) => m.role)).toEqual(["user", "user", "assistant"]);
  });

  it("queues instead when the provider does not take the message", async () => {
    const { cid, release, prompts } = await startBlocked((ctx) => ctx.setSteer?.(async () => false));
    await send("second", cid);
    expect(messages(cid).at(-1)!.queued).toBe(true);
    release();
    await until(() => prompts.length === 2);
  });

  it("drops queued messages when the reply is stopped, and can unqueue one", async () => {
    const { cid, release } = await startBlocked();
    await send("second", cid);
    await send("third", cid);
    const third = messages(cid).at(-1)!;
    expect(chat.unqueue(cid, third.id)).toBe(true);
    expect(chat.unqueue(cid, third.id)).toBe(false);
    expect(messages(cid).some((m) => m.id === third.id)).toBe(false);
    const before = events.length;
    chat.interrupt(cid);
    release();
    await until(() => !chat.isRunning(cid));
    expect(messages(cid).map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(events.slice(before).some((e) => e.type === "message.removed")).toBe(true);
  });
});
