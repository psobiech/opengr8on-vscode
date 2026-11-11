import { randomBytes } from "node:crypto";
import { CipherKey } from "opengr8on-node/client";
import { KeyStore, parseKeysFile, pinToPrivateKey, type SecretBackend } from "../../src/device/keyStore";

class MemorySecrets implements SecretBackend {
  readonly data = new Map<string, string>();
  async get(k: string) { return this.data.get(k); }
  async store(k: string, v: string) { this.data.set(k, v); }
  async delete(k: string) { this.data.delete(k); }
}

const b64 = (n = 16) => randomBytes(n).toString("base64");
const SCOPE = "file:///home/user/project";

describe("parseKeysFile", () => {
  it("reads the opengr8on-node project key and the per-CLU map", () => {
    const [key, iv, pk] = [b64(), b64(), b64(8)];
    const parsed = parseKeysFile(JSON.stringify({ key, iv, defaultIV: b64(), pin: "QUJDRA==", clus: { "100000013": { privateKey: pk }, "100000014": { pin: "TESTPIN1" } } }));
    expect(parsed.project?.getSecretKey().toString("base64")).toBe(key);
    expect(parsed.project?.getIV().toString("base64")).toBe(iv);
    expect(parsed.clus.get(100000013)?.privateKey?.toString("base64")).toBe(pk);
    expect(parsed.clus.get(100000014)?.privateKey?.toString("ascii")).toBe("TESTPIN1");
  });

  it("accepts a file with only CLU keys", () => {
    expect(parseKeysFile(JSON.stringify({ clus: { "1": { privateKey: b64(8) } } })).project).toBeUndefined();
  });

  it("names the bad field without echoing the value", () => {
    const bad = b64(8);
    let message = "";
    try {
      parseKeysFile(JSON.stringify({ key: bad, iv: b64() }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe("key: expected 16 bytes of base64");
    expect(message).not.toContain(bad);
    expect(() => parseKeysFile(JSON.stringify({ key: b64() }))).toThrow(/^iv:/);
    expect(() => parseKeysFile(JSON.stringify({ clus: { CLU_1: {} } }))).toThrow(/decimal serial/);
    expect(() => parseKeysFile(JSON.stringify({ clus: { "5": { key: b64() } } }))).toThrow(/^clus\.5\.iv:/);
    expect(() => parseKeysFile("{")).toThrow(/not valid JSON/);
    expect(() => parseKeysFile(JSON.stringify({ clus: { "5": { privateKey: b64(16) } } }))).toThrow(/privateKey: expected 8 bytes/);
    expect(() => parseKeysFile(JSON.stringify({ clus: { "5": { pin: "SECRET" } } }))).toThrow(/^clus\.5\.pin: PIN must be 8/);
  });
});

describe("KeyStore", () => {
  it("resolves CLU key, then project key, then none", async () => {
    const store = new KeyStore(new MemorySecrets());
    const project = CipherKey.random();
    await store.setProjectKey(SCOPE, project);
    expect((await store.cipherKeyFor(7, SCOPE)).source).toBe("project");
    expect((await store.cipherKeyFor(7, SCOPE)).key?.getIV().equals(project.getIV())).toBe(true);
    expect((await store.cipherKeyFor(7)).source).toBe("none");
    expect((await store.cipherKeyFor(7, "file:///other")).source).toBe("none");

    const own = CipherKey.random();
    await store.setCluKeys(7, { key: own.getSecretKey(), iv: own.getIV() });
    const r = await store.cipherKeyFor(7, SCOPE);
    expect(r.source).toBe("clu");
    expect(r.key?.getSecretKey().equals(own.getSecretKey())).toBe(true);
  });

  it("merges CLU keys, indexes serials and builds the discovery privateKeys map", async () => {
    const secrets = new MemorySecrets();
    const store = new KeyStore(secrets);
    const pk = randomBytes(8);
    const own = CipherKey.random();
    await store.setCluKeys(20, { privateKey: pk });
    await store.setCluKeys(10, { key: own.getSecretKey(), iv: own.getIV() });
    await store.setCluKeys(20, { key: own.getSecretKey(), iv: own.getIV() });
    expect(await store.serials()).toEqual([10, 20]);
    expect((await store.getCluKeys(20))?.privateKey?.equals(pk)).toBe(true); // merged, not replaced
    expect((await store.getCluKeys(20))?.key?.equals(own.getSecretKey())).toBe(true);
    expect(Object.keys(await store.privateKeys())).toEqual(["20"]);

    await store.deleteCluKeys(20);
    expect(await store.serials()).toEqual([10]);
    expect(await store.getCluKeys(20)).toBeUndefined();
    expect([...secrets.data.keys()].every((k) => k.startsWith("opengr8on."))).toBe(true);
  });

  it("imports a keys.json", async () => {
    const store = new KeyStore(new MemorySecrets());
    const parsed = parseKeysFile(JSON.stringify({ key: b64(), iv: b64(), clus: { "3": { privateKey: b64(8) } } }));
    expect(await store.importKeys(parsed, SCOPE)).toEqual({ project: true, clus: [3] });
    expect(await store.getProjectKey(SCOPE)).toBeDefined();
    expect(await store.serials()).toEqual([3]);
  });
});

describe("pinToPrivateKey", () => {
  it("takes the 8 printed characters as ASCII", () => {
    expect(pinToPrivateKey(" ABCD1234 ").toString("ascii")).toBe("ABCD1234");
    expect(() => pinToPrivateKey("ABC")).toThrow(/8 printable ASCII/);
    expect(() => pinToPrivateKey("ABCD 234")).toThrow(/8 printable ASCII/);
  });
});
