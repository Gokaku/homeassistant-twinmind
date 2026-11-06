import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { AdminGuard } from "./guard.js";
import { coreUserLister } from "./ha.js";
import { HassClient } from "./hass/client.js";
import { startMcpEndpoint } from "./hass/mcp.js";
import { ClaudeProvider } from "./providers/claude.js";
import { CodexProvider } from "./providers/codex.js";
import { MockProvider } from "./providers/mock.js";
import type { Provider } from "./providers/types.js";
import { ConversationStore } from "./store.js";
import { UploadStore } from "./uploads.js";

// Log stray promise rejections instead of exiting (Node's default), so one bad event cannot
// kill every running chat. Real crashes still exit; the Supervisor watchdog restarts us.
process.on("unhandledRejection", (e) => console.error("[twinmind] unhandled rejection:", e));

const config = loadConfig();

const listUsers = config.supervisorToken ? coreUserLister(config.coreWebsocketUrl, config.supervisorToken) : null;
if (!listUsers && !config.devAdminUser) {
  console.warn("[twinmind] SUPERVISOR_TOKEN is missing: every request will be refused (fail closed).");
}
if (config.devAdminUser) console.warn(`[twinmind] DEV MODE: admin checks disabled, everyone is "${config.devAdminUser}".`);

const guard = new AdminGuard({
  allowedAddresses: config.allowedAddresses,
  listUsers,
  cacheMs: config.adminCacheMs,
  devAdminUser: config.devAdminUser,
});

const store = new ConversationStore(config.dataDir);
const uploads = new UploadStore(config.dataDir, config.maxUploadBytes);
await store.init();
await uploads.init();

const providers: Provider[] = [
  new ClaudeProvider({ cwd: config.workDir }),
  new CodexProvider({ cwd: config.workDir }),
];
if (config.enableMock) providers.push(new MockProvider());

const { server, chat, shutdown } = createApp({ config, guard, store, uploads, providers });

// Home Assistant tools for the assistants, on a loopback-only MCP endpoint.
let hass = config.supervisorToken
  ? new HassClient({ wsUrl: config.coreWebsocketUrl, restUrl: config.coreRestUrl, supervisorUrl: config.supervisorUrl, token: config.supervisorToken })
  : null;
if (!hass && config.devAdminUser && process.env.TWINMIND_DEV_FAKE_HA === "1") {
  // Development only: an in-memory Home Assistant (not part of the production build).
  const { createFakeHa } = await import("./testing/fake-ha.js");
  const fake = createFakeHa();
  hass = new HassClient({ ...(await fake.listen()), token: fake.token });
  console.warn("[twinmind] DEV MODE: using a fake Home Assistant.");
}
if (!hass) console.warn("[twinmind] No Supervisor token: Home Assistant tools will report that the API is unavailable.");
const mcp = await startMcpEndpoint({ ha: hass, gate: chat });
chat.attachMcp(mcp);
// Codex reads the MCP bearer secret from its environment (bearer_token_env_var).
process.env.TWINMIND_MCP_SECRET = mcp.secret;
server.listen(config.port, config.host, () => {
  console.log(`[twinmind] listening on ${config.host}:${config.port}, working in ${config.workDir}`);
});

const stop = async () => {
  console.log("[twinmind] shutting down");
  shutdown();
  hass?.close();
  await mcp.close();
  await Promise.all(providers.map((p) => p.dispose?.().catch(() => {})));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
