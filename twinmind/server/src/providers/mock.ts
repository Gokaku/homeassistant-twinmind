import { randomUUID } from "node:crypto";
import type { AuthState, ModeInfo, ModelInfo } from "../protocol.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Provider, TurnContext } from "./types.js";

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))), { once: true });
  });

/** A fake provider for UI development and tests. Enabled with TWINMIND_ENABLE_MOCK=1. */
export class MockProvider implements Provider {
  readonly id = "mock" as const;
  readonly label = "Mock";
  readonly defaultMode = "ask";
  readonly modes: ModeInfo[] = [
    { id: "ask", label: "Ask", description: "Asks before running tools", risk: "normal" },
    { id: "auto", label: "Auto", description: "Runs tools without asking", risk: "danger" },
  ];

  constructor(private readonly delayMs = 25) {}

  async models(): Promise<ModelInfo[]> {
    return [{ id: "mock-1", label: "Mock 1" }];
  }

  async auth(): Promise<AuthState> {
    return { state: "signed-in", account: "mock@example.com" };
  }

  async run(ctx: TurnContext): Promise<{ status: "completed" | "interrupted" }> {
    const { emit, signal } = ctx;
    emit({ type: "native-id", id: ctx.nativeId ?? `mock-${randomUUID()}` });
    const stream = async (kind: "text-delta" | "reasoning-delta", partId: string, text: string) => {
      for (const word of text.split(/(?<= )/)) {
        await sleep(this.delayMs, signal);
        emit({ type: kind, partId, delta: word });
      }
    };
    await stream("reasoning-delta", randomUUID(), "The user wants a demo. I'll look at the configuration first, then answer. ");

    // "plan" exercises a todo list and a plan approval (Claude's TodoWrite / ExitPlanMode).
    if (/\bplan\b/i.test(ctx.prompt)) {
      emit({
        type: "part",
        part: {
          type: "todo",
          id: "todo",
          items: [
            { text: "Find the hallway light and motion sensor", status: "completed" },
            { text: "Draft the automation", status: "in_progress" },
            { text: "Check the configuration", status: "pending" },
          ],
        },
      });
      const id = randomUUID();
      const plan = "## Hallway night light\n\n1. Trigger on `binary_sensor.hallway_motion` after sunset\n2. Turn on `light.hallway` at 30 %\n3. Turn it off after 2 minutes without motion";
      const input = { plan };
      emit({ type: "part", part: { type: "tool", id, name: "ExitPlanMode", kind: "other", title: "Plan ready", input, state: "running" } });
      const d = await ctx.requestApproval({ toolPartId: id, name: "ExitPlanMode", kind: "other", title: "Plan ready", input });
      emit({ type: "part", part: { type: "tool", id, name: "ExitPlanMode", kind: "other", title: "Plan ready", input, state: d === "deny" ? "denied" : "completed" } });
      await stream("text-delta", randomUUID(), d === "deny" ? "Okay, I'll keep planning." : "Great, building it now.");
      return { status: "completed" };
    }

    // "ask me" exercises questions (Claude's AskUserQuestion / Codex's requestUserInput).
    if (/\bask me\b/i.test(ctx.prompt)) {
      const answers = await ctx.requestInput({
        partId: randomUUID(),
        questions: [
          {
            id: "room",
            header: "Room",
            question: "Which room should the automation control?",
            options: [
              { label: "Kitchen", description: "light.kitchen" },
              { label: "Hallway", description: "light.hallway" },
            ],
            multiSelect: false,
            allowOther: true,
          },
          {
            id: "when",
            header: "When",
            question: "When should it run?",
            options: [{ label: "Sunset" }, { label: "Motion" }, { label: "At a fixed time" }],
            multiSelect: true,
            allowOther: false,
          },
        ],
      });
      await stream("text-delta", randomUUID(), answers ? `Got it: ${Object.entries(answers).map(([k, v]) => `${k} = ${v.join(" + ")}`).join("; ")}.` : "No problem, we can do that later.");
      return { status: "completed" };
    }

    // "rename" exercises the Home Assistant tools end to end (MCP + approval gate).
    if (/\brename\b/i.test(ctx.prompt) && ctx.mcp) {
      const id = randomUUID();
      const name = "mcp__homeassistant__ha_update_entity";
      const input = { entity_id: "light.kitchen", name: "Kitchen island" };
      const title = "light.kitchen → “Kitchen island”";
      emit({ type: "part", part: { type: "tool", id, name, kind: "ha", title, input, state: "running" } });
      const client = new Client({ name: "twinmind-mock", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(ctx.mcp.url), { requestInit: { headers: { Authorization: `Bearer ${ctx.mcp.secret}` } } }),
      );
      try {
        const r: any = await client.callTool({ name: "ha_update_entity", arguments: input });
        const output = (r.content ?? []).map((c: any) => c.text).join("");
        emit({ type: "part", part: { type: "tool", id, name, kind: "ha", title, input, output, state: r.isError ? "error" : "completed" } });
        await stream("text-delta", randomUUID(), r.isError ? `That did not work: ${output}` : "Renamed **light.kitchen** to *Kitchen island*.");
      } finally {
        await client.close();
      }
      return { status: "completed" };
    }

    const tool = randomUUID();
    const title = "grep -rn 'light.' /config/automations.yaml";
    emit({ type: "part", part: { type: "tool", id: tool, name: "Bash", kind: "command", title, input: { command: title }, state: "running" } });
    if (ctx.mode === "ask") {
      const d = await ctx.requestApproval({ toolPartId: tool, name: "Bash", kind: "command", title, input: { command: title } });
      if (d === "deny") {
        emit({ type: "part", part: { type: "tool", id: tool, name: "Bash", kind: "command", title, input: { command: title }, state: "denied" } });
        await stream("text-delta", randomUUID(), "Okay, I won't run that. ");
        return { status: "completed" };
      }
    }
    await sleep(this.delayMs * 4, signal);
    emit({
      type: "part",
      part: {
        type: "tool",
        id: tool,
        name: "Bash",
        kind: "command",
        title,
        input: { command: title },
        output: "12:    entity_id: light.kitchen\n31:    entity_id: light.hallway",
        state: "completed",
      },
    });
    const files = ctx.attachments.length ? ` I also received ${ctx.attachments.map((a) => a.name).join(", ")}.` : "";
    await stream(
      "text-delta",
      randomUUID(),
      `You said: **${ctx.prompt.slice(0, 200)}**.${files}\n\nTwo automations touch lights:\n\n- \`light.kitchen\`\n- \`light.hallway\`\n\n\`\`\`yaml\nalias: Hallway at night\ntrigger:\n  - platform: sun\n    event: sunset\n\`\`\`\n`,
    );
    return { status: "completed" };
  }
}
