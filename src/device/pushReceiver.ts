/**
 * UDP socket the CLUs push `clientReport`s to (see push.ts). One random port for all CLUs; each
 * packet is decrypted with the key of the CLU it came from.
 */
import dgram from "node:dgram";
import type { CipherKey } from "opengr8on-node/client";

export class PushReceiver {
  private socket: dgram.Socket | undefined;

  constructor(
    /** key of the CLU at this address (undefined: unknown sender, packet dropped) */
    private readonly keyFor: (address: string) => Promise<CipherKey | undefined>,
    private readonly onReport: (text: string, address: string) => void,
  ) {}

  get port(): number | undefined {
    try {
      return this.socket?.address().port;
    } catch {
      return undefined;
    }
  }

  async start(): Promise<void> {
    if (this.socket) return;
    const s = dgram.createSocket("udp4");
    s.on("message", (msg, rinfo) => {
      void this.keyFor(rinfo.address)
        .then((key) => {
          const text = key?.decrypt(msg)?.toString("utf8");
          if (text?.includes("clientReport:")) this.onReport(text, rinfo.address);
        })
        .catch(() => undefined);
    });
    s.on("error", () => this.close());
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.bind(0, () => resolve());
    });
    this.socket = s;
  }

  close(): void {
    try {
      this.socket?.close();
    } catch {
      /* closed */
    }
    this.socket = undefined;
  }
}
