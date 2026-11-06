import WebSocket from "ws";

/** The subset of a Home Assistant user record that Twinmind cares about. */
export interface HaUser {
  id: string;
  name: string | null;
  username?: string | null;
  is_owner: boolean;
  is_active: boolean;
  system_generated: boolean;
  group_ids: string[];
}

export type UserLister = () => Promise<HaUser[]>;

/**
 * Lists Home Assistant users through the Core WebSocket API (`config/auth/list`),
 * reached via the Supervisor proxy with the add-on's SUPERVISOR_TOKEN.
 * Needs `homeassistant_api: true` in config.yaml.
 */
export function coreUserLister(url: string, token: string, timeoutMs = 5000): UserLister {
  return () =>
    new Promise<HaUser[]>((resolve, reject) => {
      const ws = new WebSocket(url);
      let settled = false;
      const finish = (err: Error | null, users?: HaUser[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.removeAllListeners();
        ws.on("error", () => {});
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        if (err) reject(err);
        else resolve(users ?? []);
      };
      const timer = setTimeout(() => finish(new Error("Home Assistant user lookup timed out")), timeoutMs);
      ws.on("error", (e) => finish(e instanceof Error ? e : new Error(String(e))));
      ws.on("close", () => finish(new Error("Home Assistant WebSocket closed before answering")));
      ws.on("message", (raw) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return finish(new Error("Invalid message from Home Assistant"));
        }
        if (msg.type === "auth_required") {
          ws.send(JSON.stringify({ type: "auth", access_token: token }));
        } else if (msg.type === "auth_ok") {
          ws.send(JSON.stringify({ id: 1, type: "config/auth/list" }));
        } else if (msg.type === "auth_invalid") {
          finish(new Error("Home Assistant rejected the Supervisor token"));
        } else if (msg.type === "result" && msg.id === 1) {
          if (msg.success && Array.isArray(msg.result)) finish(null, msg.result as HaUser[]);
          else finish(new Error(`config/auth/list failed: ${msg.error?.message ?? "unknown error"}`));
        }
      });
    });
}
