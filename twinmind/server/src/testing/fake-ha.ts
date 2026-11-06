import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

/** A tiny in-memory Home Assistant (Core WS + REST + Supervisor) for tests. */
export function createFakeHa(token = "good-token") {
  const state = {
    states: [
      { entity_id: "light.kitchen", state: "on", attributes: { friendly_name: "Kitchen Light", brightness: 200 }, last_changed: "2026-11-05T10:00:00Z" },
      { entity_id: "light.hallway", state: "off", attributes: { friendly_name: "Hallway" }, last_changed: "2026-11-05T09:00:00Z" },
      { entity_id: "sensor.temp", state: "21.5", attributes: { friendly_name: "Living Temperature", unit_of_measurement: "°C" }, last_changed: "2026-11-05T09:30:00Z" },
      { entity_id: "automation.night", state: "on", attributes: { friendly_name: "Night mode", id: "1700" }, last_changed: "2026-11-05T08:00:00Z" },
    ] as any[],
    entities: [
      { entity_id: "light.kitchen", name: null, original_name: "Kitchen Light", platform: "hue", device_id: "dev1", area_id: null, disabled_by: null, hidden_by: null, icon: null },
      { entity_id: "light.hallway", name: "Hallway", original_name: "Light 2", platform: "hue", device_id: "dev2", area_id: "hall", disabled_by: null, hidden_by: null, icon: null },
      { entity_id: "sensor.temp", name: null, original_name: "Temperature", platform: "zha", device_id: null, area_id: "living", disabled_by: null, hidden_by: null, icon: null },
    ] as any[],
    devices: [
      { id: "dev1", name: "Hue bulb 1", name_by_user: null, area_id: "kitchen", manufacturer: "Signify", model: "LCT015" },
      { id: "dev2", name: "Hue bulb 2", name_by_user: null, area_id: "hall", manufacturer: "Signify", model: "LCT015" },
    ] as any[],
    areas: [
      { area_id: "kitchen", name: "Kitchen" },
      { area_id: "hall", name: "Hallway" },
      { area_id: "living", name: "Living room" },
    ] as any[],
    automations: { "1700": { id: "1700", alias: "Night mode", triggers: [], actions: [] } } as Record<string, any>,
    scripts: { morning_routine: { alias: "Morning routine", sequence: [] } } as Record<string, any>,
    serviceCalls: [] as any[],
    requests: [] as string[],
    wsCommands: [] as any[],
  };

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { message: "Unauthorized" });
    let body = "";
    for await (const c of req) body += c;
    const data = body ? JSON.parse(body) : undefined;
    const url = new URL(req.url!, "http://x");
    state.requests.push(req.url!);
    const p = url.pathname;
    if (p === "/core/api/states") return json(res, 200, state.states);
    let m = p.match(/^\/core\/api\/states\/(.+)$/);
    if (m) {
      const s = state.states.find((x) => x.entity_id === m![1]);
      return s ? json(res, 200, s) : json(res, 404, { message: "Entity not found." });
    }
    m = p.match(/^\/core\/api\/services\/(\w+)\/(\w+)$/);
    if (m && req.method === "POST") {
      state.serviceCalls.push({ domain: m[1], service: m[2], data });
      return json(res, 200, url.search.includes("return_response") ? { changed_states: [], service_response: { ok: true } } : []);
    }
    m = p.match(/^\/core\/api\/config\/(automation|script)\/config\/(.+)$/);
    if (m) {
      const store = m[1] === "automation" ? state.automations : state.scripts;
      const key = decodeURIComponent(m[2]);
      if (req.method === "GET") return store[key] ? json(res, 200, store[key]) : json(res, 404, { message: "Resource not found" });
      if (req.method === "POST") return (store[key] = data), json(res, 200, { result: "ok" });
      if (req.method === "DELETE") return delete store[key], json(res, 200, { result: "ok" });
    }
    if (p === "/core/api/template" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(`rendered:${data.template}`);
    }
    if (p === "/core/api/config/core/check_config") return json(res, 200, { result: "valid", errors: null });
    if (p === "/core/api/history/period/2026-11-05T00:00:00.000Z" || p.startsWith("/core/api/history/period/")) {
      return json(res, 200, [[{ entity_id: "light.kitchen", state: "off", last_changed: "2026-11-05T07:00:00Z" }, { entity_id: "light.kitchen", state: "on", last_changed: "2026-11-05T10:00:00Z" }]]);
    }
    if (p.startsWith("/core/api/logbook/")) return json(res, 200, [{ when: "2026-11-05T10:00:00Z", name: "Kitchen Light", message: "turned on", entity_id: "light.kitchen" }]);
    if (p === "/core/logs") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(Array.from({ length: 50 }, (_, i) => `2026-11-05 10:${String(i).padStart(2, "0")} ${i % 10 === 0 ? "ERROR" : "INFO"} line ${i}`).join("\n"));
    }
    if (p === "/supervisor/info") return json(res, 200, { result: "ok", data: { version: "2026.11.0" } });
    json(res, 404, { message: "Not found" });
  });

  const wss = new WebSocketServer({ server, path: "/core/websocket" });
  wss.on("connection", (ws) => {
    let authed = false;
    ws.send(JSON.stringify({ type: "auth_required" }));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "auth") {
        authed = m.access_token === token;
        ws.send(JSON.stringify({ type: authed ? "auth_ok" : "auth_invalid" }));
        return;
      }
      if (!authed) return;
      state.wsCommands.push(m);
      const ok = (result: unknown) => ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result }));
      const err = (message: string) => ws.send(JSON.stringify({ id: m.id, type: "result", success: false, error: { code: "not_found", message } }));
      switch (m.type) {
        case "get_config":
          return ok({ version: "2026.11.1", location_name: "Home", time_zone: "Europe/Berlin", unit_system: { temperature: "°C" }, components: ["hue", "zha", "automation"] });
        case "get_states":
          return ok(state.states);
        case "config/entity_registry/list":
          return ok(state.entities);
        case "config/device_registry/list":
          return ok(state.devices);
        case "config/area_registry/list":
          return ok(state.areas);
        case "get_services":
          return ok({ light: { turn_on: { name: "Turn on", fields: {} }, turn_off: { name: "Turn off", fields: {} } }, automation: { reload: {} } });
        case "system_log/list":
          return ok([{ name: "homeassistant.components.hue", message: ["Bridge unreachable"], level: "ERROR", source: ["hue/bridge.py", 10], timestamp: 1793900000, count: 3, first_occurred: 1793800000 }]);
        case "config/entity_registry/get": {
          const e = state.entities.find((x) => x.entity_id === m.entity_id);
          return e ? ok(e) : err("Entity not found");
        }
        case "config/entity_registry/update": {
          const e = state.entities.find((x) => x.entity_id === m.entity_id);
          if (!e) return err("Entity not found");
          if ("name" in m) e.name = m.name;
          if ("area_id" in m) e.area_id = m.area_id;
          if ("icon" in m) e.icon = m.icon;
          if (m.new_entity_id) {
            const s = state.states.find((x) => x.entity_id === e.entity_id);
            if (s) s.entity_id = m.new_entity_id;
            e.entity_id = m.new_entity_id;
          }
          return ok({ entity_entry: e });
        }
        case "config/device_registry/update": {
          const d = state.devices.find((x) => x.id === m.device_id);
          if (!d) return err("Device not found");
          if ("name_by_user" in m) d.name_by_user = m.name_by_user;
          if ("area_id" in m) d.area_id = m.area_id;
          return ok(d);
        }
        case "config/area_registry/create":
          state.areas.push({ area_id: String(m.name).toLowerCase().replace(/\W+/g, "_"), name: m.name });
          return ok(state.areas[state.areas.length - 1]);
        default:
          return err(`Unknown command ${m.type}`);
      }
    });
  });

  return {
    state,
    token,
    async listen() {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as AddressInfo).port;
      return {
        wsUrl: `ws://127.0.0.1:${port}/core/websocket`,
        restUrl: `http://127.0.0.1:${port}/core/api`,
        supervisorUrl: `http://127.0.0.1:${port}`,
      };
    },
    close() {
      wss.close();
      server.close();
    },
  };
}
