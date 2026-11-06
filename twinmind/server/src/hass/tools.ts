import { z } from "zod";
import type { HassClient } from "./client.js";

/**
 * Home Assistant tools offered to both assistants (over MCP).
 * `readOnly` tools never need approval; every other tool goes through
 * Twinmind's approval policy before it runs.
 */
export interface HaTool<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  input: S;
  /** One line shown on the approval card, e.g. "light.turn_on → light.kitchen". */
  summary(args: z.infer<z.ZodObject<S>>): string;
  run(ha: HassClient, args: z.infer<z.ZodObject<S>>): Promise<unknown>;
}

const MAX_RESULT_CHARS = 60_000;

function tool<S extends z.ZodRawShape>(t: HaTool<S>): HaTool<S> {
  return t;
}

const lower = (s: unknown) => String(s ?? "").toLowerCase();

interface Registries {
  states: any[];
  entities: any[];
  devices: any[];
  areas: any[];
}

async function registries(ha: HassClient): Promise<Registries> {
  const [states, entities, devices, areas] = await Promise.all([
    ha.command<any[]>("get_states"),
    ha.command<any[]>("config/entity_registry/list"),
    ha.command<any[]>("config/device_registry/list"),
    ha.command<any[]>("config/area_registry/list"),
  ]);
  return { states, entities, devices, areas };
}

function describeEntities(r: Registries) {
  const ent = new Map(r.entities.map((e) => [e.entity_id, e]));
  const dev = new Map(r.devices.map((d) => [d.id, d]));
  const area = new Map(r.areas.map((a) => [a.area_id, a.name]));
  const ids = new Set([...r.states.map((s) => s.entity_id), ...r.entities.map((e) => e.entity_id)]);
  const state = new Map(r.states.map((s) => [s.entity_id, s]));
  return [...ids].map((id) => {
    const s = state.get(id);
    const e = ent.get(id);
    const d = e?.device_id ? dev.get(e.device_id) : undefined;
    const areaId = e?.area_id ?? d?.area_id ?? null;
    return {
      entity_id: id,
      name: e?.name ?? s?.attributes?.friendly_name ?? e?.original_name ?? null,
      state: s?.state ?? null,
      unit: s?.attributes?.unit_of_measurement,
      area: areaId ? (area.get(areaId) ?? areaId) : null,
      device: d ? (d.name_by_user ?? d.name) : null,
      device_id: e?.device_id ?? null,
      platform: e?.platform ?? null,
      disabled: e?.disabled_by ? true : undefined,
      hidden: e?.hidden_by ? true : undefined,
    };
  });
}

function tail(text: string, lines: number, filter?: string): string {
  let all = String(text ?? "").split("\n");
  if (filter) {
    let re: RegExp;
    try {
      re = new RegExp(filter, "i");
    } catch {
      re = new RegExp(filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    all = all.filter((l) => re.test(l));
  }
  return all.slice(-lines).join("\n");
}

const target = z
  .object({
    entity_id: z.union([z.string(), z.array(z.string())]).optional(),
    device_id: z.union([z.string(), z.array(z.string())]).optional(),
    area_id: z.union([z.string(), z.array(z.string())]).optional(),
    label_id: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .optional();

export const HA_TOOLS: HaTool<any>[] = [
  /* ---------------- read ---------------- */
  tool({
    name: "ha_overview",
    title: "Home Assistant overview",
    description:
      "Version, location, time zone, loaded integrations, areas and entity counts per domain. Call this first to get oriented.",
    readOnly: true,
    input: {},
    summary: () => "overview",
    async run(ha) {
      const [config, r] = await Promise.all([ha.command("get_config"), registries(ha)]);
      const domains: Record<string, number> = {};
      for (const s of r.states) {
        const d = s.entity_id.split(".")[0];
        domains[d] = (domains[d] ?? 0) + 1;
      }
      return {
        version: config.version,
        location_name: config.location_name,
        time_zone: config.time_zone,
        unit_system: config.unit_system,
        integrations: [...new Set((config.components ?? []).map((c: string) => c.split(".")[0]))].sort(),
        areas: r.areas.map((a) => ({ area_id: a.area_id, name: a.name })),
        entity_counts: domains,
        device_count: r.devices.length,
      };
    },
  }),
  tool({
    name: "ha_search_entities",
    title: "Search entities",
    description:
      "Find entities by text (matches entity_id, name, area, device), domain and/or area. Returns id, name, state, area, device and platform.",
    readOnly: true,
    input: {
      query: z.string().optional().describe("Text to look for, e.g. 'kitchen' or 'temperature'"),
      domain: z.string().optional().describe("Domain filter, e.g. 'light'"),
      area: z.string().optional().describe("Area name or id"),
      include_disabled: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    summary: (a) => [a.query, a.domain, a.area].filter(Boolean).join(" · ") || "all entities",
    async run(ha, a) {
      const words = lower(a.query).split(/\s+/).filter(Boolean);
      const list = describeEntities(await registries(ha)).filter((e) => {
        if (!a.include_disabled && e.disabled) return false;
        if (a.domain && !e.entity_id.startsWith(`${a.domain}.`)) return false;
        if (a.area && !lower(e.area).includes(lower(a.area))) return false;
        const hay = lower([e.entity_id, e.name, e.area, e.device, e.platform].join(" "));
        return words.every((w) => hay.includes(w));
      });
      const limit = a.limit ?? 100;
      return { total: list.length, entities: list.slice(0, limit), truncated: list.length > limit || undefined };
    },
  }),
  tool({
    name: "ha_get_entity",
    title: "Get entity",
    description: "Full state, attributes and registry entry (name, area, device, icon, platform) for one entity.",
    readOnly: true,
    input: { entity_id: z.string() },
    summary: (a) => a.entity_id,
    async run(ha, a) {
      const [state, entry] = await Promise.all([
        ha.rest("GET", `/states/${encodeURIComponent(a.entity_id)}`).catch(() => null),
        ha.command("config/entity_registry/get", { entity_id: a.entity_id }).catch(() => null),
      ]);
      if (!state && !entry) throw new Error(`Entity ${a.entity_id} not found`);
      return { state, registry: entry };
    },
  }),
  tool({
    name: "ha_list_areas_devices",
    title: "List areas and devices",
    description: "All areas, and devices (optionally filtered by text) with manufacturer, model, area and their entities.",
    readOnly: true,
    input: { query: z.string().optional(), limit: z.number().int().min(1).max(500).optional() },
    summary: (a) => a.query || "areas and devices",
    async run(ha, a) {
      const r = await registries(ha);
      const area = new Map(r.areas.map((x) => [x.area_id, x.name]));
      const q = lower(a.query);
      const devices = r.devices
        .map((d) => ({
          device_id: d.id,
          name: d.name_by_user ?? d.name,
          original_name: d.name,
          manufacturer: d.manufacturer,
          model: d.model,
          area: d.area_id ? (area.get(d.area_id) ?? d.area_id) : null,
          entities: r.entities.filter((e) => e.device_id === d.id).map((e) => e.entity_id),
        }))
        .filter((d) => !q || lower([d.name, d.original_name, d.manufacturer, d.model, d.area].join(" ")).includes(q));
      const limit = a.limit ?? 100;
      return { areas: r.areas.map((x) => ({ area_id: x.area_id, name: x.name })), devices: devices.slice(0, limit), device_total: devices.length };
    },
  }),
  tool({
    name: "ha_get_logs",
    title: "Read logs",
    description:
      "Read Home Assistant logs. source 'errors' = recent warnings/errors collected by HA (system_log, structured); 'core' = the raw Home Assistant log; 'supervisor' = Supervisor log. Use 'filter' (regex or text) to narrow it down.",
    readOnly: true,
    input: {
      source: z.enum(["errors", "core", "supervisor"]).default("errors"),
      lines: z.number().int().min(1).max(2000).optional(),
      filter: z.string().optional(),
    },
    summary: (a) => `${a.source ?? "errors"}${a.filter ? ` · ${a.filter}` : ""}`,
    async run(ha, a) {
      const lines = a.lines ?? 200;
      if ((a.source ?? "errors") === "errors") {
        const list: any[] = await ha.command("system_log/list");
        const f = a.filter ? lower(a.filter) : "";
        return list
          .filter((e) => !f || lower(JSON.stringify(e)).includes(f))
          .slice(0, lines)
          .map((e) => ({
            level: e.level,
            logger: e.name,
            message: Array.isArray(e.message) ? e.message.join("\n") : e.message,
            source: e.source,
            count: e.count,
            last: e.timestamp ? new Date(e.timestamp * 1000).toISOString() : undefined,
            exception: e.exception ? String(e.exception).slice(-4000) : undefined,
          }));
      }
      const path = a.source === "supervisor" ? "/supervisor/logs" : "/core/logs";
      try {
        return tail(await ha.supervisor("GET", path, undefined, "text/plain"), lines, a.filter);
      } catch (e: any) {
        if (a.source === "core") return tail(await ha.rest("GET", "/error_log"), lines, a.filter);
        if (e?.code === 403 || e?.code === 401)
          throw new Error("Supervisor logs are not available: Twinmind does not request the Supervisor 'manager' role. Use source 'core' or 'errors'.");
        throw e;
      }
    },
  }),
  tool({
    name: "ha_history",
    title: "State history",
    description: "State changes of one or more entities over the last N hours (default 24).",
    readOnly: true,
    input: { entity_ids: z.array(z.string()).min(1).max(20), hours: z.number().min(0.1).max(24 * 30).optional() },
    summary: (a) => `${a.entity_ids.join(", ")} · ${a.hours ?? 24} h`,
    async run(ha, a) {
      const start = new Date(Date.now() - (a.hours ?? 24) * 3600_000).toISOString();
      const q = new URLSearchParams({ filter_entity_id: a.entity_ids.join(","), minimal_response: "", no_attributes: "" });
      const data: any[][] = await ha.rest("GET", `/history/period/${encodeURIComponent(start)}?${q}`);
      return data.map((series) => ({
        entity_id: series[0]?.entity_id,
        changes: series.slice(-300).map((s) => ({ state: s.state, at: s.last_changed })),
      }));
    },
  }),
  tool({
    name: "ha_logbook",
    title: "Logbook",
    description: "Logbook entries (what happened, triggered by what) for the last N hours, optionally for one entity.",
    readOnly: true,
    input: { hours: z.number().min(0.1).max(24 * 7).optional(), entity_id: z.string().optional(), limit: z.number().int().max(1000).optional() },
    summary: (a) => `${a.entity_id ?? "all"} · ${a.hours ?? 6} h`,
    async run(ha, a) {
      const start = new Date(Date.now() - (a.hours ?? 6) * 3600_000).toISOString();
      const q = a.entity_id ? `?entity=${encodeURIComponent(a.entity_id)}` : "";
      const data: any[] = await ha.rest("GET", `/logbook/${encodeURIComponent(start)}${q}`);
      return data.slice(-(a.limit ?? 200));
    },
  }),
  tool({
    name: "ha_render_template",
    title: "Render template",
    description: "Render a Jinja2 template in Home Assistant, e.g. to test a condition or compute a value.",
    readOnly: true,
    input: { template: z.string().max(20_000) },
    summary: (a) => a.template.replace(/\s+/g, " ").slice(0, 120),
    async run(ha, a) {
      return ha.rest("POST", "/template", { template: a.template });
    },
  }),
  tool({
    name: "ha_check_config",
    title: "Check configuration",
    description: "Validate the YAML configuration. Always run this after editing configuration files and before a restart.",
    readOnly: true,
    input: {},
    summary: () => "check configuration",
    async run(ha) {
      return ha.rest("POST", "/config/core/check_config");
    },
  }),
  tool({
    name: "ha_list_services",
    title: "List services",
    description: "Available actions (services) with their fields, optionally for one domain.",
    readOnly: true,
    input: { domain: z.string().optional() },
    summary: (a) => a.domain ?? "all domains",
    async run(ha, a) {
      const all = await ha.command<Record<string, any>>("get_services");
      if (a.domain) return { [a.domain]: all[a.domain] ?? {} };
      return Object.fromEntries(Object.entries(all).map(([d, s]) => [d, Object.keys(s)]));
    },
  }),
  tool({
    name: "ha_get_automation",
    title: "Get automation or script",
    description:
      "The stored configuration of an automation or script, by entity_id (automation.x / script.x) or by its config id. Only works for automations/scripts managed by the UI editor (automations.yaml / scripts.yaml).",
    readOnly: true,
    input: { entity_id: z.string().optional(), kind: z.enum(["automation", "script"]).optional(), id: z.string().optional() },
    summary: (a) => a.entity_id ?? `${a.kind ?? "automation"} ${a.id}`,
    async run(ha, a) {
      const kind = a.entity_id?.startsWith("script.") ? "script" : (a.kind ?? "automation");
      let id = a.id;
      if (!id && a.entity_id) {
        if (kind === "script") id = a.entity_id.slice("script.".length);
        else id = (await ha.rest("GET", `/states/${encodeURIComponent(a.entity_id)}`))?.attributes?.id;
      }
      if (!id) throw new Error("This automation has no config id (it is probably defined in YAML outside automations.yaml).");
      return { kind, id, config: await ha.rest("GET", `/config/${kind}/config/${encodeURIComponent(id)}`) };
    },
  }),

  /* ---------------- write ---------------- */
  tool({
    name: "ha_call_service",
    title: "Call service",
    description:
      "Perform an action (call a service), e.g. light.turn_on, automation.trigger, homeassistant.reload_all, notify.mobile_app_x. Set return_response for services that return data.",
    readOnly: false,
    input: {
      domain: z.string(),
      service: z.string(),
      target,
      data: z.record(z.string(), z.unknown()).optional(),
      return_response: z.boolean().optional(),
    },
    summary: (a) => {
      const t = a.target ? Object.values(a.target).flat().filter(Boolean).join(", ") : "";
      return `${a.domain}.${a.service}${t ? ` → ${t}` : ""}`;
    },
    async run(ha, a) {
      if (!/^\w+$/.test(a.domain) || !/^\w+$/.test(a.service)) throw new Error("Invalid domain or service");
      const body = { ...(a.data ?? {}), ...(a.target ?? {}) };
      return ha.rest("POST", `/services/${a.domain}/${a.service}${a.return_response ? "?return_response" : ""}`, body);
    },
  }),
  tool({
    name: "ha_update_entity",
    title: "Rename / update entity",
    description:
      "Change an entity in the entity registry: display name, entity_id (rename), icon, area, or hide/disable it. Pass name: null to reset to the default name.",
    readOnly: false,
    input: {
      entity_id: z.string(),
      name: z.string().nullable().optional(),
      new_entity_id: z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/).optional(),
      icon: z.string().nullable().optional(),
      area_id: z.string().nullable().optional(),
      hidden: z.boolean().optional(),
      disabled: z.boolean().optional(),
    },
    summary: (a) => {
      const parts = [a.new_entity_id && `→ ${a.new_entity_id}`, a.name !== undefined && `name “${a.name ?? "default"}”`, a.area_id !== undefined && `area ${a.area_id}`, a.icon !== undefined && `icon ${a.icon}`, a.hidden !== undefined && (a.hidden ? "hide" : "unhide"), a.disabled !== undefined && (a.disabled ? "disable" : "enable")].filter(Boolean);
      return `${a.entity_id} ${parts.join(", ")}`;
    },
    async run(ha, a) {
      const payload: Record<string, unknown> = { entity_id: a.entity_id };
      if (a.name !== undefined) payload.name = a.name;
      if (a.new_entity_id) payload.new_entity_id = a.new_entity_id;
      if (a.icon !== undefined) payload.icon = a.icon;
      if (a.area_id !== undefined) payload.area_id = a.area_id;
      if (a.hidden !== undefined) payload.hidden_by = a.hidden ? "user" : null;
      if (a.disabled !== undefined) payload.disabled_by = a.disabled ? "user" : null;
      return ha.command("config/entity_registry/update", payload);
    },
  }),
  tool({
    name: "ha_update_device",
    title: "Rename / move device",
    description: "Rename a device (name_by_user; null resets it) and/or assign it to an area.",
    readOnly: false,
    input: { device_id: z.string(), name_by_user: z.string().nullable().optional(), area_id: z.string().nullable().optional() },
    summary: (a) => `${a.device_id}${a.name_by_user !== undefined ? ` name “${a.name_by_user ?? "default"}”` : ""}${a.area_id !== undefined ? ` area ${a.area_id}` : ""}`,
    async run(ha, a) {
      const payload: Record<string, unknown> = { device_id: a.device_id };
      if (a.name_by_user !== undefined) payload.name_by_user = a.name_by_user;
      if (a.area_id !== undefined) payload.area_id = a.area_id;
      return ha.command("config/device_registry/update", payload);
    },
  }),
  tool({
    name: "ha_create_area",
    title: "Create area",
    description: "Create a new area.",
    readOnly: false,
    input: { name: z.string().min(1).max(100) },
    summary: (a) => a.name,
    async run(ha, a) {
      return ha.command("config/area_registry/create", { name: a.name });
    },
  }),
  tool({
    name: "ha_save_automation",
    title: "Save automation or script",
    description:
      "Create or replace an automation or script through Home Assistant's config API (the same way the UI editor does). It is written to automations.yaml / scripts.yaml and reloaded automatically. For a new automation, omit id and one is generated. Use the modern format: triggers / conditions / actions.",
    readOnly: false,
    input: {
      kind: z.enum(["automation", "script"]).default("automation"),
      id: z.string().regex(/^[\w-]+$/).optional(),
      config: z.record(z.string(), z.unknown()),
    },
    summary: (a) => `${a.id ? "update" : "create"} ${a.kind ?? "automation"} “${String((a.config as any)?.alias ?? a.id ?? "")}”`,
    async run(ha, a) {
      const kind = a.kind ?? "automation";
      const id = a.id ?? (kind === "automation" ? String(Date.now()) : String((a.config as any)?.alias ?? "script").toLowerCase().replace(/\W+/g, "_").slice(0, 60) || `script_${Date.now()}`);
      await ha.rest("POST", `/config/${kind}/config/${encodeURIComponent(id)}`, kind === "automation" ? { id, ...a.config } : a.config);
      return { saved: true, kind, id, entity_hint: kind === "script" ? `script.${id}` : "automation.<derived from alias>" };
    },
  }),
  tool({
    name: "ha_delete_automation",
    title: "Delete automation or script",
    description: "Delete an automation or script that is managed by the UI editor (by config id).",
    readOnly: false,
    input: { kind: z.enum(["automation", "script"]).default("automation"), id: z.string().regex(/^[\w-]+$/) },
    summary: (a) => `delete ${a.kind ?? "automation"} ${a.id}`,
    async run(ha, a) {
      return ha.rest("DELETE", `/config/${a.kind ?? "automation"}/config/${encodeURIComponent(a.id)}`);
    },
  }),
  tool({
    name: "ha_websocket",
    title: "Raw WebSocket command",
    description:
      "Admin escape hatch: send any Home Assistant WebSocket API command (e.g. 'config/label_registry/create', 'config/floor_registry/list', 'backup/info'). Prefer the specific tools when they fit.",
    readOnly: false,
    input: { type: z.string().regex(/^[\w/.-]+$/), payload: z.record(z.string(), z.unknown()).optional() },
    summary: (a) => a.type,
    async run(ha, a) {
      const { id: _id, type: _type, ...rest } = (a.payload ?? {}) as Record<string, unknown>;
      return ha.command(a.type, rest);
    },
  }),
  tool({
    name: "ha_rest",
    title: "Raw REST call",
    description: "Admin escape hatch: call the Home Assistant Core REST API (path relative to /api, e.g. '/config/scene/config/123').",
    readOnly: false,
    input: { method: z.enum(["GET", "POST", "DELETE"]), path: z.string().startsWith("/"), body: z.unknown().optional() },
    summary: (a) => `${a.method} ${a.path}`,
    async run(ha, a) {
      return ha.rest(a.method, a.path, a.body);
    },
  }),
];

export function formatResult(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…(truncated, narrow the request)` : text;
}

export const HA_READ_ONLY = new Set(HA_TOOLS.filter((t) => t.readOnly).map((t) => t.name));
