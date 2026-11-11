import { readFile, writeFile } from "node:fs/promises";
import { CLUDevice, CLUFiles, CipherKey } from "opengr8on-node/client";
import { CluRunner, type RunnerClient } from "../../src/device/cluRunner";
import { KeyStore, type SecretBackend } from "../../src/device/keyStore";

class MemorySecrets implements SecretBackend {
  readonly data = new Map<string, string>();
  async get(k: string) { return this.data.get(k); }
  async store(k: string, v: string) { this.data.set(k, v); }
  async delete(k: string) { this.data.delete(k); }
}

const SCOPE = "file:///project";
const device = (serial = 100000013) => new CLUDevice({ serialNumber: serial, address: "10.0.0.13" });

const stored = new Map<string, Buffer>();

function fake(overrides: Partial<RunnerClient> = {}) {
  const log: string[] = [];
  const client = (): RunnerClient => ({
    checkAlive: async () => (log.push("alive"), true),
    reset: async () => true,
    setAddress: async (a) => a,
    refreshModules: async () => "resp_refresh_modules",
    startTFTPdServer: async () => (log.push("start"), true),
    stopTFTPdServer: async () => (log.push("stop"), true),
    downloadFile: async (loc, path) => (log.push(`get ${loc}`), await writeFile(path, "-- OM"), path),
    execute: async (s) => `ran ${s}`,
    uploadFile: async (src, loc) => {
      log.push(`put ${loc}`);
      stored.set(loc, await readFile(src));
    },
    close: () => void log.push("close"),
    ...overrides,
  });
  return { log, client };
}

async function runner(f = fake()) {
  const keys = new KeyStore(new MemorySecrets());
  await keys.setProjectKey(SCOPE, CipherKey.random());
  const used: CipherKey[] = [];
  const r = new CluRunner(keys, () => SCOPE, (_a, _d, k) => (used.push(k), f.client()));
  return { r, keys, used, log: f.log };
}

describe("CluRunner", () => {
  it("refuses without a key", async () => {
    const r = new CluRunner(new KeyStore(new MemorySecrets()), () => SCOPE, () => fake().client());
    await expect(r.checkAlive("x", device())).rejects.toThrow(/no key for CLU100000013/);
  });

  it("uses the project key and closes the client", async () => {
    const { r, keys, used, log } = await runner();
    expect(await r.checkAlive("x", device())).toBe(true);
    expect(used[0].getIV().equals((await keys.getProjectKey(SCOPE))!.getIV())).toBe(true);
    expect(log).toEqual(["alive", "close"]);
  });

  it("downloads over TFTP with start/stop around it", async () => {
    const { r, log } = await runner();
    const buf = await r.download("x", device(), CLUFiles.OM_LUA);
    expect(buf?.toString()).toBe("-- OM");
    expect(log).toEqual(["start", "get a:\\OM.LUA", "stop", "close"]);
  });

  it("stops TFTP even when the download fails", async () => {
    const f = fake({ downloadFile: async () => { throw new Error("timeout"); } });
    const { r, log } = await runner(f);
    await expect(r.download("x", device(), CLUFiles.OM_LUA)).rejects.toThrow("timeout");
    expect(log).toEqual(["start", "stop", "close"]);
  });

  it("serialises operations per CLU, and a failure does not block the queue", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const f = fake({
      execute: async (s) => {
        order.push(`begin ${s}`);
        if (s === "slow") await gate;
        if (s === "bad") throw new Error("bad");
        order.push(`end ${s}`);
        return s;
      },
    });
    const { r } = await runner(f);
    const a = r.execute("x", device(), "slow");
    const b = r.execute("x", device(), "bad");
    const c = r.execute("x", device(), "fast");
    const other = r.execute("x", device(7), "other"); // different CLU: not queued behind
    await other;
    expect(order).toEqual(["begin slow", "begin other", "end other"]);
    release();
    await a;
    await expect(b).rejects.toThrow("bad");
    expect(await c).toBe("fast");
    expect(order).toEqual(["begin slow", "begin other", "end other", "end slow", "begin bad", "begin fast", "end fast"]);
  });

  it("uploads, verifies by reading back, and stops TFTP", async () => {
    stored.clear();
    const f = fake({
      downloadFile: async (loc, path) => {
        log2.push(`get ${loc}`);
        const b = stored.get(loc);
        if (!b) return null;
        await writeFile(path, b);
        return path;
      },
    });
    const log2 = f.log;
    const { r } = await runner(f);
    await r.upload("x", device(), [{ file: CLUFiles.OM_LUA, content: Buffer.from("-- OM\r\n") }, { file: CLUFiles.USER_LUA, content: Buffer.from("") }]);
    expect(f.log).toEqual(["start", "put a:\\OM.LUA", "get a:\\OM.LUA", "put a:\\USER.LUA", "get a:\\USER.LUA", "stop", "close"]);
  });

  it("fails the upload when the read-back differs, and refuses read-only files", async () => {
    const f = fake({ uploadFile: async () => undefined }); // CLU silently ignores the write
    const { r } = await runner(f);
    await expect(r.upload("x", device(), [{ file: CLUFiles.OM_LUA, content: Buffer.from("new") }])).rejects.toThrow(/OM.LUA verification failed \(5 bytes read back, 3 sent\)/);
    expect(f.log.at(-2)).toBe("stop");
    await expect(r.upload("x", device(), [{ file: CLUFiles.CONFIG_JSON, content: Buffer.from("{}") }])).rejects.toThrow(/not writable/);
  });

  it("validates set IP input", async () => {
    const { r } = await runner();
    await expect(r.setAddress("x", device(), "10.0.0.300", "10.0.0.1")).rejects.toThrow(/not an IPv4 address/);
    expect(await r.setAddress("x", device(), "10.0.0.20", "10.0.0.1")).toBe("10.0.0.20");
  });
});
