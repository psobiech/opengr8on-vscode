import { CLUClient, CLUDevice, CipherKey, CipherType } from "opengr8on-node/client";
import type { KeyStore } from "./keyStore";

/** What adoption needs from a CLU client (CLUClient satisfies it; tests inject a fake). */
export interface AdoptClient {
  updateCipherKey(key: CipherKey): Promise<true | null>;
  checkAlive(): Promise<boolean | null>;
  close(): void;
}

export interface AdoptOptions {
  /** CLU as last discovered: serial, address and the iv from its discovery reply. */
  device: CLUDevice;
  /** CLU private key (PIN as ASCII, see pinToPrivateKey). */
  privateKey: Buffer;
  /** Project key scope (workspace folder URI). */
  scope: string;
  keys: KeyStore;
  localAddress: string;
  createClient?: (localAddress: string, device: CLUDevice) => AdoptClient;
}

export interface AdoptResult {
  /** true when a new project key was generated for this scope */
  generatedProjectKey: boolean;
  /** check-alive under the new key: true / false / null (no answer) */
  alive: boolean | null;
}

/**
 * Adopts a CLU into the project: sends `req_set_key` with the project key, encrypted with the CLU's
 * initial device key (discovery iv + private key). The project key is generated and stored
 * before anything is sent, so a CLU never ends up with a key we did not keep. On success the
 * private key is stored for the serial. Throws (without key material in the message) on failure.
 */
export async function adoptClu(opts: AdoptOptions): Promise<AdoptResult> {
  const { device, privateKey, scope, keys } = opts;
  if (device.serialNumber == null || !device.address) throw new Error("CLU has no serial/address; run discovery first");
  if (!device.iv) throw new Error(`CLU${device.serialNumber}: no iv from discovery; run discovery again`);

  let projectKey = await keys.getProjectKey(scope);
  const generatedProjectKey = !projectKey;
  if (!projectKey) {
    projectKey = CipherKey.random();
    await keys.setProjectKey(scope, projectKey);
  }

  const withPin = new CLUDevice({
    serialNumber: device.serialNumber,
    macAddress: device.macAddress,
    address: device.address,
    port: device.port,
    cipherType: device.cipherType,
    iv: device.iv,
    privateKey,
  });
  const client = (opts.createClient ?? ((addr, d) => new CLUClient(addr, d)))(opts.localAddress, withPin);
  try {
    const ok = await client.updateCipherKey(projectKey);
    if (!ok) {
      throw new Error(`CLU${device.serialNumber} did not accept the key (wrong PIN, or the CLU does not take set_key with its device key)`);
    }
    await keys.setCluKeys(device.serialNumber, { privateKey });
    const alive = await client.checkAlive();
    return { generatedProjectKey, alive };
  } finally {
    client.close();
  }
}

/** A discovered CLU this project could adopt. */
export interface AdoptionCandidate {
  serial: number;
  address: string;
  /**
   * `new`: no PIN stored for it, never adopted by this project. `rekey`: PIN known, but the CLU
   * holds another project key (adopted by Object Manager / another project, or reset).
   */
  reason: "new" | "rekey";
}

/**
 * CLUs from a discovery whose discovery cipher check does not show this project's key (see
 * opengr8on-node getCipherType): PROJECT = adopted, UNKNOWN = no PIN stored, NONE = PIN stored
 * but another project key. `skip`: serials the user declined this session.
 */
export function adoptionCandidates(found: readonly CLUDevice[], skip: ReadonlySet<number> = new Set()): AdoptionCandidate[] {
  const out: AdoptionCandidate[] = [];
  for (const d of found) {
    if (d.serialNumber == null || !d.address || !d.iv || skip.has(d.serialNumber)) continue;
    if (d.cipherType === CipherType.PROJECT) continue;
    out.push({ serial: d.serialNumber, address: d.address, reason: d.cipherType === CipherType.NONE ? "rekey" : "new" });
  }
  return out.sort((a, b) => a.serial - b.serial);
}

/**
 * Drops candidates that already answer `probe` (check alive under the key we would use for them):
 * the discovery check needs the CLU's PIN and can miss adopted CLUs (keys imported without a PIN,
 * a vCLU hashing the discovery random differently). Probe errors / no answer keep the candidate.
 */
export async function dropAnswering(
  candidates: readonly AdoptionCandidate[],
  probe: (serial: number) => Promise<boolean | null>,
): Promise<AdoptionCandidate[]> {
  const answers = await Promise.all(candidates.map((c) => probe(c.serial).catch(() => null)));
  return candidates.filter((_, i) => answers[i] !== true);
}
