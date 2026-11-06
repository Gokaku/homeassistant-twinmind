import { describe, expect, it, vi } from "vitest";
import { AdminGuard, isAllowedAddress, normalizeAddress } from "./guard.js";
import type { HaUser } from "./ha.js";

const INGRESS = "172.30.32.2";
const ALLOWED = [INGRESS, "127.0.0.1", "::1"];

const users: HaUser[] = [
  { id: "owner", name: "Olivia", is_owner: true, is_active: true, system_generated: false, group_ids: [] },
  { id: "admin", name: "Adam", is_owner: false, is_active: true, system_generated: false, group_ids: ["system-admin"] },
  { id: "user", name: "Uma", is_owner: false, is_active: true, system_generated: false, group_ids: ["system-users"] },
  { id: "inactive", name: "Ian", is_owner: false, is_active: false, system_generated: false, group_ids: ["system-admin"] },
  { id: "system", name: "Supervisor", is_owner: false, is_active: true, system_generated: true, group_ids: ["system-admin"] },
];

function req(remoteAddress: string, headers: Record<string, string> = {}) {
  return { socket: { remoteAddress }, headers } as any;
}

function guard(listUsers: (() => Promise<HaUser[]>) | null = async () => users, extra = {}) {
  return new AdminGuard({ allowedAddresses: ALLOWED, listUsers, cacheMs: 60_000, ...extra });
}

describe("address gate", () => {
  it("normalizes IPv4-mapped IPv6", () => {
    expect(normalizeAddress("::ffff:172.30.32.2")).toBe(INGRESS);
    expect(isAllowedAddress("::ffff:172.30.32.2", ALLOWED)).toBe(true);
  });

  it("rejects other containers on the hassio network", async () => {
    const r = await guard().check(req("172.30.33.5", { "x-remote-user-id": "owner" }));
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("ignores spoofed forwarding headers", async () => {
    const r = await guard().check(
      req("172.30.33.5", { "x-forwarded-for": INGRESS, "x-real-ip": INGRESS, "x-remote-user-id": "owner" }),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a missing peer address", async () => {
    const r = await guard().check({ socket: {}, headers: { "x-remote-user-id": "owner" } } as any);
    expect(r.ok).toBe(false);
  });
});

describe("admin check", () => {
  it("rejects a request with no user header", async () => {
    expect(await guard().check(req(INGRESS))).toMatchObject({ ok: false, status: 401 });
  });

  it("accepts the owner and system-admin members", async () => {
    const g = guard();
    expect(await g.check(req(INGRESS, { "x-remote-user-id": "owner" }))).toMatchObject({ ok: true, user: { id: "owner" } });
    expect(await g.check(req(INGRESS, { "x-remote-user-id": "admin" }))).toMatchObject({ ok: true, user: { id: "admin" } });
  });

  it("rejects non-admin, inactive, system-generated and unknown users", async () => {
    const g = guard();
    for (const id of ["user", "inactive", "system", "nobody"]) {
      expect(await g.check(req(INGRESS, { "x-remote-user-id": id }))).toMatchObject({ ok: false, status: 403 });
    }
  });

  it("fails closed when Home Assistant is unreachable", async () => {
    const g = guard(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await g.check(req(INGRESS, { "x-remote-user-id": "owner" }))).toMatchObject({ ok: false, status: 503 });
  });

  it("fails closed when no Supervisor token is configured", async () => {
    expect(await guard(null).check(req(INGRESS, { "x-remote-user-id": "owner" }))).toMatchObject({ ok: false, status: 503 });
  });

  it("caches the user list and refreshes after the TTL", async () => {
    let t = 0;
    const list = vi.fn(async () => users);
    const g = guard(list, { now: () => t });
    await g.check(req(INGRESS, { "x-remote-user-id": "owner" }));
    await g.check(req(INGRESS, { "x-remote-user-id": "admin" }));
    expect(list).toHaveBeenCalledTimes(1);
    t = 61_000;
    await g.check(req(INGRESS, { "x-remote-user-id": "owner" }));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("picks up a demotion after the cache expires", async () => {
    let t = 0;
    let current = users;
    const g = guard(async () => current, { now: () => t });
    expect((await g.check(req(INGRESS, { "x-remote-user-id": "admin" }))).ok).toBe(true);
    current = users.map((u) => (u.id === "admin" ? { ...u, group_ids: ["system-users"] } : u));
    t = 61_000;
    expect((await g.check(req(INGRESS, { "x-remote-user-id": "admin" }))).ok).toBe(false);
  });

  it("does not cache a failed lookup", async () => {
    let fail = true;
    const g = guard(async () => {
      if (fail) throw new Error("down");
      return users;
    });
    expect((await g.check(req(INGRESS, { "x-remote-user-id": "owner" }))).ok).toBe(false);
    fail = false;
    expect((await g.check(req(INGRESS, { "x-remote-user-id": "owner" }))).ok).toBe(true);
  });

  it("dev mode still enforces the address gate", async () => {
    const g = guard(null, { devAdminUser: "dev" });
    expect((await g.check(req("127.0.0.1"))).ok).toBe(true);
    expect((await g.check(req("10.0.0.9"))).ok).toBe(false);
  });
});

describe("default configuration", () => {
  it("trusts only the ingress proxy, not loopback", async () => {
    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig({});
    expect(cfg.allowedAddresses).toEqual([INGRESS]);
    const g = new AdminGuard({ allowedAddresses: cfg.allowedAddresses, listUsers: async () => users, cacheMs: 60_000 });
    // A process inside the container (e.g. a command run by an assistant) forging the ingress header.
    expect(await g.check(req("127.0.0.1", { "x-remote-user-id": "owner" }))).toMatchObject({ ok: false, status: 403 });
    expect(await g.check(req("::1", { "x-remote-user-id": "owner" }))).toMatchObject({ ok: false, status: 403 });
    expect((await g.check(req(INGRESS, { "x-remote-user-id": "owner" }))).ok).toBe(true);
  });
});
