import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, Conversation, ConversationMeta, ProviderId } from "./protocol.js";

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

export function toMeta(c: Conversation): ConversationMeta {
  return {
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    provider: c.provider,
    native: c.native,
    messageCount: c.messages.length,
  };
}

async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, data, { mode: 0o600 });
  await fs.rename(tmp, file);
}

/** Conversation transcripts, one JSON file each, under <dataDir>/conversations. */
export class ConversationStore {
  private readonly dir: string;
  private cache = new Map<string, Conversation>();
  private loaded = false;
  private writes = new Map<string, Promise<void>>();

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "conversations");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (this.loaded) return;
    for (const f of await fs.readdir(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const c = JSON.parse(await fs.readFile(path.join(this.dir, f), "utf8")) as Conversation;
        if (isValidId(c.id)) {
          // A turn that was streaming when the add-on stopped will never finish.
          for (const m of c.messages) if (m.status === "streaming") m.status = "interrupted";
          this.cache.set(c.id, c);
        }
      } catch {
        /* skip corrupt files */
      }
    }
    this.loaded = true;
  }

  list(): ConversationMeta[] {
    return [...this.cache.values()].map(toMeta).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Conversation | undefined {
    return isValidId(id) ? this.cache.get(id) : undefined;
  }

  create(provider: ProviderId, title = "New chat"): Conversation {
    const now = Date.now();
    const c: Conversation = {
      id: randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      provider,
      native: {},
      seen: {},
      messageCount: 0,
      messages: [],
    };
    this.cache.set(c.id, c);
    return c;
  }

  addMessage(c: Conversation, m: ChatMessage): void {
    c.messages.push(m);
    c.updatedAt = Date.now();
  }

  /** Persist a conversation. Writes for the same id are serialized. */
  save(c: Conversation): Promise<void> {
    c.messageCount = c.messages.length;
    const prev = this.writes.get(c.id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => writeAtomic(path.join(this.dir, `${c.id}.json`), JSON.stringify(c)));
    this.writes.set(c.id, next);
    return next;
  }

  async rename(id: string, title: string): Promise<Conversation | undefined> {
    const c = this.get(id);
    if (!c) return undefined;
    c.title = title.slice(0, 200);
    c.updatedAt = Date.now();
    await this.save(c);
    return c;
  }

  async delete(id: string): Promise<boolean> {
    const c = this.get(id);
    if (!c) return false;
    this.cache.delete(id);
    await (this.writes.get(id) ?? Promise.resolve()).catch(() => {});
    await fs.rm(path.join(this.dir, `${id}.json`), { force: true });
    return true;
  }
}
