import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { UploadInfo } from "./protocol.js";
import { isValidId } from "./store.js";

const SAFE_TYPES = /^(image\/(png|jpeg|gif|webp|heic|heif)|text\/[a-z0-9.+-]+|application\/(json|pdf|x-yaml|yaml|xml|zip|octet-stream)|audio\/[a-z0-9.+-]+)$/;

export interface StoredUpload extends UploadInfo {
  path: string;
}

export function sanitizeName(name: string): string {
  const base = path.basename(name || "file").normalize("NFKC");
  const clean = base.replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/^\.+/, "").trim();
  return (clean || "file").slice(0, 120);
}

/** Uploaded attachments in <dataDir>/uploads. Files are created with O_EXCL and random names. */
export class UploadStore {
  readonly dir: string;
  constructor(dataDir: string, private readonly maxBytes: number) {
    this.dir = path.join(dataDir, "uploads");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  async save(name: string, mediaType: string, data: Buffer): Promise<StoredUpload> {
    if (data.length === 0) throw new Error("Empty upload");
    if (data.length > this.maxBytes) throw new Error("Upload is too large");
    const type = (mediaType || "application/octet-stream").split(";")[0].trim().toLowerCase();
    const finalType = SAFE_TYPES.test(type) ? type : "application/octet-stream";
    const id = randomUUID();
    const safe = sanitizeName(name);
    const ext = path.extname(safe).slice(0, 12);
    const file = path.join(this.dir, `${id}${ext}`);
    const fh = await fs.open(file, "wx", 0o600);
    try {
      await fh.writeFile(data);
    } finally {
      await fh.close();
    }
    const info: StoredUpload = { id, name: safe, mediaType: finalType, size: data.length, path: file };
    await fs.writeFile(path.join(this.dir, `${id}.meta.json`), JSON.stringify(info), { flag: "wx", mode: 0o600 });
    return info;
  }

  async get(id: string): Promise<StoredUpload | null> {
    if (!isValidId(id)) return null;
    try {
      const info = JSON.parse(await fs.readFile(path.join(this.dir, `${id}.meta.json`), "utf8")) as StoredUpload;
      // Never trust a stored path blindly.
      if (path.dirname(info.path) !== this.dir) return null;
      return info;
    } catch {
      return null;
    }
  }
}
