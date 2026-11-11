import { CipherKey, IV_BYTES, KEY_BYTES } from "opengr8on-node/client";

/** CLU private key = the 8-character PIN printed on the CLU, as ASCII (docs/UDP.md in opengr8on-node). */
export const PRIVATE_KEY_BYTES = 8;

/** Validates a CLU PIN and returns it as the private key. Never echoes the PIN in errors. */
export function pinToPrivateKey(pin: string): Buffer {
  const p = pin.trim();
  if (!/^[\x21-\x7e]{8}$/.test(p)) throw new Error(`PIN must be ${PRIVATE_KEY_BYTES} printable ASCII characters`);
  return Buffer.from(p, "ascii");
}

/** The subset of vscode.SecretStorage the key store needs (kept vscode-free for tests). */
export interface SecretBackend {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

/** Keys of one CLU. All optional: a CLU may only have its private key (not adopted yet). */
export interface CluKeys {
  /** Device private key = PIN as ASCII (8 bytes; OM `privateKey`); derives the initial device key. */
  privateKey?: Buffer;
  /** Explicit key/iv for this CLU, overriding the project key (CLU adopted by another project). */
  key?: Buffer;
  iv?: Buffer;
}

export type KeySource = "clu" | "project" | "none";

/**
 * `.opengr8on/keys.json`: opengr8on-node's keys.json (project `key`/`iv`, base64; `defaultIV` and
 * `pin` are accepted and ignored at top level: they describe a vCLU itself) plus an optional
 * per-CLU map keyed by decimal serial: `privateKey` (base64 of 8 bytes) or `pin` (the 8 characters
 * as printed), and optionally the CLU's own `key`/`iv`.
 */
export interface KeysFile {
  key?: string;
  iv?: string;
  defaultIV?: string;
  pin?: string;
  clus?: Record<string, { privateKey?: string; key?: string; iv?: string; pin?: string }>;
}

const b64 = (value: unknown, bytes: number, what: string): Buffer => {
  if (typeof value !== "string") throw new Error(`${what}: expected a base64 string`);
  const buf = Buffer.from(value, "base64");
  // Error messages name the field, never the value.
  if (buf.length !== bytes || buf.toString("base64") !== value.replace(/\s/g, "")) {
    throw new Error(`${what}: expected ${bytes} bytes of base64`);
  }
  return buf;
};

export interface ParsedKeysFile {
  project?: CipherKey;
  clus: Map<number, CluKeys>;
}

/** Validates a keys.json document. Throws with the offending field name (never the value). */
export function parseKeysFile(json: string): ParsedKeysFile {
  let doc: KeysFile;
  try {
    doc = JSON.parse(json) as KeysFile;
  } catch {
    throw new Error("keys.json: not valid JSON");
  }
  if (!doc || typeof doc !== "object") throw new Error("keys.json: expected an object");
  const result: ParsedKeysFile = { clus: new Map() };
  if (doc.key !== undefined || doc.iv !== undefined) {
    result.project = new CipherKey(b64(doc.key, KEY_BYTES, "key"), b64(doc.iv, IV_BYTES, "iv"));
  }
  for (const [serial, c] of Object.entries(doc.clus ?? {})) {
    if (!/^\d+$/.test(serial)) throw new Error(`clus.${serial}: key must be a decimal serial`);
    const keys: CluKeys = {};
    if (c.privateKey !== undefined) keys.privateKey = b64(c.privateKey, PRIVATE_KEY_BYTES, `clus.${serial}.privateKey`);
    else if (c.pin !== undefined) {
      try {
        keys.privateKey = pinToPrivateKey(String(c.pin));
      } catch (e) {
        throw new Error(`clus.${serial}.pin: ${(e as Error).message}`);
      }
    }
    if (c.key !== undefined || c.iv !== undefined) {
      keys.key = b64(c.key, KEY_BYTES, `clus.${serial}.key`);
      keys.iv = b64(c.iv, IV_BYTES, `clus.${serial}.iv`);
    }
    result.clus.set(Number(serial), keys);
  }
  return result;
}

const projectId = (scope: string) => `opengr8on.project:${scope}`;
const cluId = (serial: number) => `opengr8on.clu:${serial}`;
const INDEX = "opengr8on.clus";

type StoredClu = { privateKey?: string; key?: string; iv?: string };

/**
 * Cipher keys in SecretStorage. The project key is stored per project scope (the workspace folder
 * URI); CLU keys per serial (they belong to the device, not to a workspace). Nothing here logs or
 * returns key material as text.
 */
export class KeyStore {
  constructor(private readonly secrets: SecretBackend) {}

  async setProjectKey(scope: string, key: CipherKey): Promise<void> {
    await this.secrets.store(projectId(scope), JSON.stringify({ key: key.getSecretKey().toString("base64"), iv: key.getIV().toString("base64") }));
  }

  async getProjectKey(scope: string): Promise<CipherKey | undefined> {
    const raw = await this.secrets.get(projectId(scope));
    if (!raw) return undefined;
    const { key, iv } = JSON.parse(raw) as { key: string; iv: string };
    return new CipherKey(Buffer.from(key, "base64"), Buffer.from(iv, "base64"));
  }

  async deleteProjectKey(scope: string): Promise<void> {
    await this.secrets.delete(projectId(scope));
  }

  /** Merges `keys` into what is stored for `serial`. */
  async setCluKeys(serial: number, keys: CluKeys): Promise<void> {
    const merged = { ...(await this.getCluKeys(serial)), ...keys };
    const stored: StoredClu = {};
    if (merged.privateKey) stored.privateKey = merged.privateKey.toString("base64");
    if (merged.key && merged.iv) {
      stored.key = merged.key.toString("base64");
      stored.iv = merged.iv.toString("base64");
    }
    await this.secrets.store(cluId(serial), JSON.stringify(stored));
    const index = await this.serials();
    if (!index.includes(serial)) await this.secrets.store(INDEX, JSON.stringify([...index, serial].sort((a, b) => a - b)));
  }

  async getCluKeys(serial: number): Promise<CluKeys | undefined> {
    const raw = await this.secrets.get(cluId(serial));
    if (!raw) return undefined;
    const s = JSON.parse(raw) as StoredClu;
    const keys: CluKeys = {};
    if (s.privateKey) keys.privateKey = Buffer.from(s.privateKey, "base64");
    if (s.key && s.iv) {
      keys.key = Buffer.from(s.key, "base64");
      keys.iv = Buffer.from(s.iv, "base64");
    }
    return keys;
  }

  async deleteCluKeys(serial: number): Promise<void> {
    await this.secrets.delete(cluId(serial));
    await this.secrets.store(INDEX, JSON.stringify((await this.serials()).filter((s) => s !== serial)));
  }

  /** Serials with stored CLU keys (SecretStorage cannot enumerate, so an index is kept). */
  async serials(): Promise<number[]> {
    const raw = await this.secrets.get(INDEX);
    return raw ? (JSON.parse(raw) as number[]) : [];
  }

  /** The key to talk to a CLU: its own key/iv, else the project key of `scope`. */
  async cipherKeyFor(serial: number, scope?: string): Promise<{ source: KeySource; key?: CipherKey }> {
    const clu = await this.getCluKeys(serial);
    if (clu?.key && clu.iv) return { source: "clu", key: new CipherKey(clu.key, clu.iv) };
    const project = scope ? await this.getProjectKey(scope) : undefined;
    return project ? { source: "project", key: project } : { source: "none" };
  }

  /** Private keys of all known CLUs, in the shape `Client.discover` takes. */
  async privateKeys(): Promise<Record<number, Buffer>> {
    const out: Record<number, Buffer> = {};
    for (const serial of await this.serials()) {
      const k = await this.getCluKeys(serial);
      if (k?.privateKey) out[serial] = k.privateKey;
    }
    return out;
  }

  /** Imports a parsed keys.json; the project key goes to `scope`. Returns what was imported. */
  async importKeys(parsed: ParsedKeysFile, scope: string): Promise<{ project: boolean; clus: number[] }> {
    if (parsed.project) await this.setProjectKey(scope, parsed.project);
    for (const [serial, keys] of parsed.clus) await this.setCluKeys(serial, keys);
    return { project: !!parsed.project, clus: [...parsed.clus.keys()] };
  }
}
