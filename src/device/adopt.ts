import { CLUClient, CLUDevice, CipherKey } from "opengr8on-node/client";
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
