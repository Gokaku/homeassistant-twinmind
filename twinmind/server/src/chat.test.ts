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
const provider = new ScriptedProvider();
const events: ServerEvent[] = [];
const ended = new Map<string, () => void>();

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "twinmind-chat-"));
  const store = new ConversationStore(dir);
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
  it("never remembers 'Always' for the raw WebSocket/REST tools", async () => {
    const answer = autoAnswer("allow-session");
    const results: boolean[] = [];
    await turn("ask", async (ctx) => {
      const s = chat.session(tokenOf(ctx))!;
      for (const name of ["ha_websocket", "ha_websocket", "ha_rest", "ha_rest", "ha_update_entity", "ha_update_entity"]) {
        results.push((await s.decide(tool(name), {}, name)).ok);
      }
    });
    answer.stop();
    expect(results.every(Boolean)).toBe(true);
    // Raw tools: asked every time (2 + 2). Specific tool: asked once, then remembered.
    expect(answer.asked()).toBe(5);
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
