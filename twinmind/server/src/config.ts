import path from "node:path";

/** Runtime configuration, read once from the environment (set by run.sh). */
export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  workDir: string;
  webDir: string;
  /** Remote addresses allowed to talk to the server at all. */
  allowedAddresses: string[];
  /** Development only: skip the HA admin lookup and treat everyone as this admin. */
  devAdminUser: string | null;
  supervisorToken: string | null;
  coreWebsocketUrl: string;
  coreRestUrl: string;
  supervisorUrl: string;
  adminCacheMs: number;
  maxUploadBytes: number;
  enableMock: boolean;
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The Supervisor ingress proxy: the only peer allowed to talk to the UI/API in production. */
export const INGRESS_PROXY = "172.30.32.2";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = env.TWINMIND_DATA_DIR ?? "/data";
  const devAdminUser = env.TWINMIND_DEV_ADMIN_USER || null;
  return {
    port: Number(env.TWINMIND_PORT ?? 8099),
    host: env.TWINMIND_HOST ?? "0.0.0.0",
    dataDir,
    workDir: env.TWINMIND_WORKDIR ?? "/config",
    webDir: env.TWINMIND_WEB_DIR ?? path.resolve(import.meta.dirname, "../../web/dist"),
    // Never loopback in production: the assistants run commands inside this container and must
    // not be able to reach the API as a user. The health check has its own loopback-only route.
    allowedAddresses: list(env.TWINMIND_ALLOWED_ADDRESSES, devAdminUser ? ["127.0.0.1", "::1"] : [INGRESS_PROXY]),
    devAdminUser,
    supervisorToken: env.SUPERVISOR_TOKEN || null,
    coreWebsocketUrl: env.TWINMIND_CORE_WS ?? "ws://supervisor/core/websocket",
    coreRestUrl: env.TWINMIND_CORE_API ?? "http://supervisor/core/api",
    supervisorUrl: env.TWINMIND_SUPERVISOR_API ?? "http://supervisor",
    adminCacheMs: Number(env.TWINMIND_ADMIN_CACHE_MS ?? 60_000),
    maxUploadBytes: Number(env.TWINMIND_MAX_UPLOAD_MB ?? 20) * 1024 * 1024,
    enableMock: env.TWINMIND_ENABLE_MOCK === "1",
  };
}
