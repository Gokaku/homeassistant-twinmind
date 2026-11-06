import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { isLoopback } from "../guard.js";
import type { HassClient } from "./client.js";
import { HA_TOOLS, formatResult, type HaTool } from "./tools.js";

export const MCP_SERVER_NAME = "homeassistant";

export type GateDecision = { ok: true } | { ok: false; reason: string };

/** Links an MCP token to a conversation and decides whether a write tool may run. */
export interface ToolGate {
  /** Returns null if the token is unknown (then the request is refused). */
  session(token: string): {
    /** `signal` aborts when the MCP request goes away (client timeout/disconnect): cancel the approval. */
    decide(tool: HaTool, args: unknown, summary: string, signal?: AbortSignal): Promise<GateDecision>;
  } | null;
}

export interface McpEndpoint {
  /** Bearer secret every MCP request must carry. */
  readonly secret: string;
  url(conversationToken: string): string;
  close(): Promise<void>;
}

const MAX_BODY = 2 * 1024 * 1024;

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Serves the Home Assistant tools to the assistants over MCP (streamable HTTP),
 * on a loopback-only port that the ingress never reaches.
 * URL: http://127.0.0.1:<port>/mcp/<conversation token>, header Authorization: Bearer <secret>.
 */
export async function startMcpEndpoint(opts: { ha: HassClient | null; gate: ToolGate; port?: number }): Promise<McpEndpoint> {
  const secret = randomBytes(32).toString("hex");

  const server = http.createServer(async (req, res) => {
    const deny = (code: number, msg: string) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: msg }, id: null }));
    };
    if (!isLoopback(req.socket.remoteAddress)) return deny(403, "Forbidden");
    const m = (req.url ?? "").match(/^\/mcp\/([A-Za-z0-9_-]{16,128})$/);
    if (!m) return deny(404, "Not found");
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || !sameSecret(auth.slice(7), secret)) return deny(401, "Unauthorized");
    const session = opts.gate.session(m[1]);
    if (!session) return deny(403, "Unknown conversation");
    if (req.method !== "POST") return deny(405, "Method not allowed");

    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) return deny(413, "Too large");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return deny(400, "Invalid JSON");
    }

    // Aborted if the client gives up before we answered: a pending approval must not
    // still apply a change after the assistant was told the call failed.
    const gone = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) gone.abort();
    });
    const mcp = new McpServer({ name: MCP_SERVER_NAME, version: "0.1.0" });
    for (const t of HA_TOOLS) {
      mcp.registerTool(
        t.name,
        {
          title: t.title,
          description: t.description,
          inputSchema: t.input,
          annotations: { readOnlyHint: t.readOnly, destructiveHint: !t.readOnly, openWorldHint: false },
        },
        async (args: any) => {
          try {
            if (!opts.ha) throw new Error("The Home Assistant API is not available (no Supervisor token).");
            if (!t.readOnly) {
              const d = await session.decide(t, args, t.summary(args), gone.signal);
              if (!d.ok) return { content: [{ type: "text" as const, text: d.reason }], isError: true };
              if (gone.signal.aborted) throw new Error("The request was cancelled.");
            }
            const result = await t.run(opts.ha, args);
            return { content: [{ type: "text" as const, text: formatResult(result ?? { ok: true }) }] };
          } catch (e: any) {
            return { content: [{ type: "text" as const, text: `Error: ${e?.message ?? e}` }], isError: true };
          }
        },
      );
    }
    // Stateless: a fresh server and transport per request.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (e: any) {
      if (!res.headersSent) deny(500, e?.message ?? "MCP error");
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    secret,
    url: (token) => `http://127.0.0.1:${port}/mcp/${token}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
