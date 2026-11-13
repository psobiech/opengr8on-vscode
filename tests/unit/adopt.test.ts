import { randomBytes } from "node:crypto";
import { CLUDevice, CipherKey, CipherType } from "opengr8on-node/client";
import { adoptClu, adoptionCandidates, dropAnswering, type AdoptClient } from "../../src/device/adopt";
import { KeyStore, type SecretBackend } from "../../src/device/keyStore";

class MemorySecrets implements SecretBackend {
  readonly data = new Map<string, string>();
  async get(k: string) { return this.data.get(k); }
  async store(k: string, v: string) { this.data.set(k, v); }
  async delete(k: string) { this.data.delete(k); }
}

const SCOPE = "file:///project";
const device = () => new CLUDevice({ serialNumber: 100000013, address: "10.0.0.13", iv: randomBytes(16), macAddress: "aabbcc001122" });

function fakeClient(accept: boolean) {
  const calls: { device?: CLUDevice; key?: CipherKey; closed: boolean } = { closed: false };
  const create = (_addr: string, d: CLUDevice): AdoptClient => {
    calls.device = d;
    return {
      updateCipherKey: async (k) => ((calls.key = k), accept ? true : null),
      checkAlive: async () => true,
      close: () => void (calls.closed = true),
    };
  };
  return { calls, create };
}

describe("adoptClu", () => {
  it("generates + stores the project key first, sends it with the device key, stores the PIN", async () => {
    const keys = new KeyStore(new MemorySecrets());
    const pin = Buffer.from("TESTPIN1", "ascii");
    const { calls, create } = fakeClient(true);
    const d = device();

    const r = await adoptClu({ device: d, privateKey: pin, scope: SCOPE, keys, localAddress: "10.0.0.2", createClient: create });

    expect(r).toEqual({ generatedProjectKey: true, alive: true });
    const project = await keys.getProjectKey(SCOPE);
    expect(calls.key?.getSecretKey().equals(project!.getSecretKey())).toBe(true);
    // client talks with the initial device key derived from discovery iv + PIN
    expect(calls.device?.getCipherKey()?.getSecretKey().equals(CipherKey.getInitialCipherKey(d.iv!, pin).getSecretKey())).toBe(true);
    expect((await keys.getCluKeys(100000013))?.privateKey?.equals(pin)).toBe(true);
    expect(calls.closed).toBe(true);
  });

  it("reuses an existing project key", async () => {
    const keys = new KeyStore(new MemorySecrets());
    const existing = CipherKey.random();
    await keys.setProjectKey(SCOPE, existing);
    const { calls, create } = fakeClient(true);
    const r = await adoptClu({ device: device(), privateKey: Buffer.from("TESTPIN1"), scope: SCOPE, keys, localAddress: "x", createClient: create });
    expect(r.generatedProjectKey).toBe(false);
    expect(calls.key?.getIV().equals(existing.getIV())).toBe(true);
  });

  it("keeps the project key but not the PIN when the CLU refuses", async () => {
    const keys = new KeyStore(new MemorySecrets());
    const { calls, create } = fakeClient(false);
    await expect(
      adoptClu({ device: device(), privateKey: Buffer.from("WRONGPIN"), scope: SCOPE, keys, localAddress: "x", createClient: create }),
    ).rejects.toThrow(/did not accept the key/);
    expect(await keys.getProjectKey(SCOPE)).toBeDefined();
    expect(await keys.getCluKeys(100000013)).toBeUndefined();
    expect(calls.closed).toBe(true);
  });

  it("needs the discovery iv", async () => {
    const keys = new KeyStore(new MemorySecrets());
    const d = new CLUDevice({ serialNumber: 1, address: "10.0.0.1" });
    await expect(adoptClu({ device: d, privateKey: Buffer.from("TESTPIN1"), scope: SCOPE, keys, localAddress: "x" })).rejects.toThrow(/no iv/);
  });
});

describe("adoptionCandidates", () => {
  const dev = (serialNumber: number | undefined, cipherType: string, extra: Partial<{ address: string; iv: Buffer | undefined }> = {}) =>
    new CLUDevice({ serialNumber, address: "address" in extra ? extra.address : `10.0.0.${serialNumber ?? 0}`, iv: "iv" in extra ? extra.iv : randomBytes(16), cipherType } as never);

  it("proposes CLUs not under the project key: no PIN stored = new, PIN stored but other key = rekey", () => {
    const found = [dev(30, CipherType.NONE), dev(10, CipherType.UNKNOWN), dev(20, CipherType.PROJECT)];
    expect(adoptionCandidates(found)).toEqual([
      { serial: 10, address: "10.0.0.10", reason: "new" },
      { serial: 30, address: "10.0.0.30", reason: "rekey" },
    ]);
  });

  it("skips declined CLUs and replies that cannot be adopted (no serial / address / iv)", () => {
    const found = [dev(10, CipherType.UNKNOWN), dev(11, CipherType.UNKNOWN), dev(undefined, CipherType.UNKNOWN),
      dev(12, CipherType.UNKNOWN, { address: "" }), dev(13, CipherType.UNKNOWN, { iv: undefined })];
    expect(adoptionCandidates(found, new Set([10]))).toEqual([{ serial: 11, address: "10.0.0.11", reason: "new" }]);
  });

  it("nothing to propose when every CLU is adopted", () => {
    expect(adoptionCandidates([dev(1, CipherType.PROJECT)])).toEqual([]);
  });
});

describe("dropAnswering", () => {
  it("drops CLUs answering check alive under our key; keeps silent, refusing and failing ones", async () => {
    const c = (serial: number) => ({ serial, address: `10.0.0.${serial}`, reason: "new" as const });
    const probe = async (serial: number) => {
      if (serial === 4) throw new Error("timeout");
      return serial === 1 ? true : serial === 2 ? false : null;
    };
    expect((await dropAnswering([c(1), c(2), c(3), c(4)], probe)).map((x) => x.serial)).toEqual([2, 3, 4]);
  });
});
