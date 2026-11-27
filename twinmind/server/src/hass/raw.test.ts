import { describe, expect, it } from "vitest";
import { classifyRaw } from "./raw.js";

const ws = (type: string) => classifyRaw("ha_websocket", { type })?.kind;
const rest = (method: string, path: string) => classifyRaw("ha_rest", { method, path })?.kind;

describe("classifyRaw", () => {
  it("recognises reads, including the ones Codex used", () => {
    for (const t of [
      "config_entries/get",
      "lovelace/config",
      "lovelace/dashboards/list",
      "config/entity_registry/list_for_display",
      "config/floor_registry/list",
      "get_states",
      "manifest/get",
      "repairs/list_issues",
      "system_health/info",
      "backup/info",
    ])
      expect(ws(t), t).toBe("read");
    expect(rest("GET", "/config/automation/config/1700")).toBe("read");
  });

  it("treats ordinary writes as changes that follow the mode", () => {
    for (const t of ["config_entries/delete", "config/area_registry/create", "lovelace/config/save", "config/entity_registry/update", "execute_script"])
      expect(ws(t), t).toBe("change");
    expect(rest("POST", "/services/light/turn_on")).toBe("change");
    expect(rest("DELETE", "/config/scene/config/123")).toBe("change");
  });

  it("marks users, tokens, Supervisor, backups, cloud and OAuth credentials as sensitive, even reads", () => {
    for (const t of [
      "auth/long_lived_access_token",
      "auth/current_user",
      "config/auth/list",
      "config/auth/delete",
      "config/auth_provider/homeassistant/create",
      "hassio/addon/info",
      "supervisor/api",
      "backup/generate",
      "backup/restore",
      "cloud/status",
      "application_credentials/list",
    ])
      expect(ws(t), t).toBe("sensitive");
    for (const p of ["/auth/token", "/hassio/addons", "/cloud/login", "/onboarding/users", "/backup/upload"]) expect(rest("POST", p), p).toBe("sensitive");
    expect(rest("GET", "/hassio/info")).toBe("sensitive");
  });

  it("does not let a path step around the checks", () => {
    expect(rest("GET", "/config/../hassio/info")).toBe("sensitive");
    expect(rest("GET", "/%2e%2e/hassio")).toBe("sensitive");
    expect(rest("POST", "/AUTH/token")).toBe("sensitive");
    expect(rest("GET", "//hassio/info")).toBe("sensitive");
    expect(rest("POST", "/config//auth/x")).toBe("sensitive");
  });

  it("remembers \"Always\" per command, not for every raw call", () => {
    expect(classifyRaw("ha_websocket", { type: "config_entries/delete" })?.key).toBe("ha_websocket config_entries/delete");
    expect(classifyRaw("ha_call_service", {})).toBeNull();
  });
});
