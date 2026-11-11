import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLUClient, CLUFiles, getLocation, type CLUDevice, type CLUFile, type CipherKey } from "opengr8on-node/client";
import type { KeyStore } from "./keyStore";

/** The CLUClient surface the runner uses (tests inject a fake). */
export interface RunnerClient {
  checkAlive(): Promise<boolean | null>;
  reset(timeoutMs?: number): Promise<boolean>;
  setAddress(newAddress: string, gatewayAddress: string): Promise<string | null>;
  refreshModules(timeoutMs?: number): Promise<string | null>;
  /** true started, false refused (CLU in lockdown answers resp:ERROR), null no answer */
  startTFTPdServer(): Promise<boolean | null>;
  stopTFTPdServer(): Promise<true | null>;
  downloadFile(location: string, localPath: string): Promise<string | null>;
  uploadFile(localPath: string, location: string): Promise<void>;
  execute(script: string): Promise<string | null>;
  close(): void;
}

export type ClientFactory = (localAddress: string, device: CLUDevice, key: CipherKey) => RunnerClient;

/** Files offered by "Download from CLU" (readable ones that matter for a project). */
export const DOWNLOADABLE: Record<string, CLUFile> = {
  "OM.LUA": CLUFiles.OM_LUA,
  "USER.LUA": CLUFiles.USER_LUA,
  "CONFIG.JSON": CLUFiles.CONFIG_JSON,
  "MAIN.LUA": CLUFiles.MAIN_LUA,
  "EMERGNCY.LUA": CLUFiles.EMERGNCY_LUA,
  "config.txt": CLUFiles.CONFIG_TXT,
  "DIAGNOSTIC_PACK.JSON": CLUFiles.DIAGNOSTIC_PACK_JSON,
};

const isIPv4 = (s: string) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(s);

/**
 * Runs commands against CLUs: resolves the key (KeyStore: CLU key, else project key), opens a
 * client per operation and serialises operations per CLU (one request in flight per serial; UDP
 * replies are not tagged, so parallel requests to one CLU would steal each other's answers).
 */
async function startTftp(c: RunnerClient, device: CLUDevice): Promise<void> {
  const started = await c.startTFTPdServer();
  if (started === false) throw new Error(`CLU${device.serialNumber} refused to start its TFTP server (resp:ERROR; a CLU in lockdown does this, e.g. after timeouts — Lua reads still work)`);
  if (!started) throw new Error(`CLU${device.serialNumber}: no answer to the TFTP server start`);
}

export class CluRunner {
  private readonly queues = new Map<number, Promise<unknown>>();

  constructor(
    private readonly keys: KeyStore,
    private readonly scope: () => string | undefined,
    private readonly createClient: ClientFactory = (addr, d, k) => new CLUClient(addr, d, k),
  ) {}

  /** Runs `op` with a client for `device`, after any operation already queued for that CLU. */
  run<T>(localAddress: string, device: CLUDevice, op: (c: RunnerClient) => Promise<T>): Promise<T> {
    const serial = device.serialNumber;
    if (serial == null || !device.address) return Promise.reject(new Error("CLU has no serial/address; run discovery first"));
    const previous = this.queues.get(serial) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const { key } = await this.keys.cipherKeyFor(serial, this.scope());
        if (!key) throw new Error(`no key for CLU${serial}: adopt it or import keys`);
        const client = this.createClient(localAddress, device, key);
        try {
          return await op(client);
        } finally {
          client.close();
        }
      });
    this.queues.set(serial, next);
    void next.finally(() => {
      if (this.queues.get(serial) === next) this.queues.delete(serial);
    }).catch(() => undefined);
    return next;
  }

  checkAlive(local: string, device: CLUDevice): Promise<boolean | null> {
    return this.run(local, device, (c) => c.checkAlive());
  }

  /** Resets and waits until the CLU answers check alive again (false = timed out). */
  reset(local: string, device: CLUDevice): Promise<boolean> {
    return this.run(local, device, (c) => c.reset());
  }

  async setAddress(local: string, device: CLUDevice, address: string, gateway: string): Promise<string> {
    if (!isIPv4(address)) throw new Error(`not an IPv4 address: ${address}`);
    if (!isIPv4(gateway)) throw new Error(`not an IPv4 gateway: ${gateway}`);
    const r = await this.run(local, device, (c) => c.setAddress(address, gateway));
    if (!r) throw new Error(`CLU${device.serialNumber} did not confirm the new address`);
    return r;
  }

  async refreshModules(local: string, device: CLUDevice): Promise<void> {
    if (!(await this.run(local, device, (c) => c.refreshModules()))) throw new Error(`CLU${device.serialNumber}: refresh modules got no answer`);
  }

  /** Runs a Lua expression on the CLU (`req:`) and returns its answer. */
  async execute(local: string, device: CLUDevice, script: string): Promise<string> {
    const r = await this.run(local, device, (c) => c.execute(script));
    if (r === null) throw new Error(`CLU${device.serialNumber}: no answer`);
    return r;
  }

  /**
   * Uploads files over TFTP (start TFTPd, upload each, download each back and compare bytes, stop
   * TFTPd). Throws if the CLU does not hold exactly what was sent. Does not reset the CLU.
   */
  upload(local: string, device: CLUDevice, files: Array<{ file: CLUFile; content: Buffer }>): Promise<void> {
    return this.run(local, device, async (c) => {
      await startTftp(c, device);
      const dir = await mkdtemp(join(tmpdir(), "opengr8on-"));
      try {
        for (const { file, content } of files) {
          if (!file.writable) throw new Error(`${file.fileName} is not writable on the CLU`);
          const src = join(dir, file.fileName);
          await writeFile(src, content);
          await c.uploadFile(src, getLocation(file));
          const back = join(dir, `${file.fileName}.verify`);
          const got = (await c.downloadFile(getLocation(file), back)) ? await readFile(back) : null;
          if (!got || !got.equals(content)) {
            throw new Error(`CLU${device.serialNumber}: ${file.fileName} verification failed (${got ? `${got.length} bytes read back, ${content.length} sent` : "file missing after upload"})`);
          }
        }
      } finally {
        await c.stopTFTPdServer().catch(() => null);
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  /**
   * Downloads a file over TFTP (start TFTPd, download, stop TFTPd). Returns null when the CLU has
   * no such file.
   */
  download(local: string, device: CLUDevice, file: CLUFile): Promise<Buffer | null> {
    return this.run(local, device, async (c) => {
      await startTftp(c, device);
      const dir = await mkdtemp(join(tmpdir(), "opengr8on-"));
      try {
        const path = await c.downloadFile(getLocation(file), join(dir, file.fileName));
        return path ? await readFile(path) : null;
      } finally {
        await c.stopTFTPdServer().catch(() => null);
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}
