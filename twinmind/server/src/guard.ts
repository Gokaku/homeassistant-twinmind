import type { IncomingMessage } from "node:http";
import type { HaUser, UserLister } from "./ha.js";

/**
 * Admin-only access control.
 *
 * 1. Only the Supervisor ingress proxy may connect at all (loopback only in dev). The
 *    check uses the TCP peer address, never a forwarded header.
 * 2. The ingress proxy sets X-Remote-User-Id. It is trusted only because of (1).
 * 3. That user must be an active Home Assistant owner or member of
 *    `system-admin`. If Home Assistant cannot be asked, access is denied.
 */

export interface Principal {
  id: string;
  name: string;
  isOwner: boolean;
}

export type GuardResult =
  | { ok: true; user: Principal }
  | { ok: false; status: 401 | 403 | 503; reason: string };

export function normalizeAddress(addr: string | undefined | null): string {
  if (!addr) return "";
  const a = addr.trim().toLowerCase();
  return a.startsWith("::ffff:") && a.includes(".") ? a.slice(7) : a;
}

export function isAllowedAddress(addr: string | undefined | null, allowed: string[]): boolean {
  const a = normalizeAddress(addr);
  return a !== "" && allowed.map(normalizeAddress).includes(a);
}

const LOOPBACK = new Set(["127.0.0.1", "::1"]);
export function isLoopback(addr: string | undefined | null): boolean {
  return LOOPBACK.has(normalizeAddress(addr));
}

export function isAdminUser(u: HaUser): boolean {
  return u.is_active && !u.system_generated && (u.is_owner || u.group_ids?.includes("system-admin"));
}

function header(req: Pick<IncomingMessage, "headers">, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export interface GuardOptions {
  allowedAddresses: string[];
  listUsers: UserLister | null;
  cacheMs: number;
  /** Development only: every request from an allowed address is this admin. */
  devAdminUser?: string | null;
  now?: () => number;
}

export class AdminGuard {
  private cache: { at: number; users: Map<string, HaUser> } | null = null;
  private inflight: Promise<Map<string, HaUser>> | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: GuardOptions) {
    this.now = opts.now ?? Date.now;
  }

  private async users(): Promise<Map<string, HaUser>> {
    if (this.cache && this.now() - this.cache.at < this.opts.cacheMs) return this.cache.users;
    if (!this.opts.listUsers) throw new Error("No Home Assistant connection configured");
    if (!this.inflight) {
      this.inflight = this.opts
        .listUsers()
        .then((list) => {
          const map = new Map(list.map((u) => [u.id, u]));
          this.cache = { at: this.now(), users: map };
          return map;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  /** Forget cached users, e.g. after a failed lookup or for tests. */
  invalidate(): void {
    this.cache = null;
  }

  async check(req: Pick<IncomingMessage, "headers" | "socket">): Promise<GuardResult> {
    const remote = req.socket?.remoteAddress;
    if (!isAllowedAddress(remote, this.opts.allowedAddresses)) {
      return { ok: false, status: 403, reason: "Connections are only accepted through Home Assistant ingress" };
    }
    if (this.opts.devAdminUser) {
      return { ok: true, user: { id: this.opts.devAdminUser, name: this.opts.devAdminUser, isOwner: true } };
    }
    const userId = header(req, "x-remote-user-id")?.trim();
    if (!userId) return { ok: false, status: 401, reason: "No Home Assistant user on this request" };

    let users: Map<string, HaUser>;
    try {
      users = await this.users();
    } catch {
      // Fail closed: if we cannot confirm admin rights, nobody gets in.
      return { ok: false, status: 503, reason: "Could not verify your Home Assistant permissions" };
    }
    const u = users.get(userId);
    if (!u || !isAdminUser(u)) {
      return { ok: false, status: 403, reason: "Twinmind is only available to Home Assistant administrators" };
    }
    const display = header(req, "x-remote-user-display-name") || u.name || u.username || "Admin";
    return { ok: true, user: { id: u.id, name: display, isOwner: u.is_owner } };
  }
}
