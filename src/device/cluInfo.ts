import type { CLUDevice } from "opengr8on-node/client";
import { english, type Tr } from "../i18n";

/** What the device explorer knows about one CLU (from discovery; later also CONFIG.JSON). */
export interface CluInfo {
  /** Decimal serial; OM's object id is `CLU<serial>`. */
  serial: number;
  address: string | null;
  /** aa:bb:cc:dd:ee:ff, lower case */
  mac: string | null;
  /**
   * Discovery's cipher check (opengr8on-node getCipherType): UNKNOWN when we have no private key
   * for the serial, else PROJECT / NONE depending on whether the reply matched the device key.
   */
  cipher: string;
  /** answered the last discovery (false: not seen, or never discovered — see inProject) */
  online: boolean;
  /** last discovery answer; undefined = known from the project only */
  lastSeen?: Date;
  /** in the open project (name / GATE from clus/<name>.yaml): usable without discovery, by its IP */
  inProject?: boolean;
  /** project name (NAME_CLU), shown instead of the id like in Object Manager */
  name?: string;
  gate?: boolean;
  /** Where the key to talk to this CLU comes from (never the key itself). */
  keySource?: "clu" | "project" | "none";
}

export function toCluInfo(device: CLUDevice, now = new Date()): CluInfo | null {
  if (device.serialNumber == null) return null;
  const mac = device.macAddress?.toLowerCase().match(/[0-9a-f]{2}/g)?.join(":") ?? null;
  return { serial: device.serialNumber, address: device.address, mac, cipher: String(device.cipherType), online: true, lastSeen: now };
}

/**
 * Merges a discovery result into the known CLUs (keyed by serial, sorted by serial). CLUs that did
 * not answer stay listed with `online: false`, so an unplugged CLU does not just vanish.
 */
export function mergeDiscovery(known: CluInfo[], found: CluInfo[]): CluInfo[] {
  const bySerial = new Map(known.map((c) => [c.serial, { ...c, online: false }]));
  for (const c of found) {
    const prev = bySerial.get(c.serial);
    bySerial.set(c.serial, { ...c, inProject: prev?.inProject, name: prev?.name, gate: prev?.gate, keySource: c.keySource ?? prev?.keySource });
  }
  return sortClus([...bySerial.values()]);
}

/** A CLU / GATE of the open project (clus/<name>.yaml). */
export interface ProjectDevice {
  serial: number;
  ip: string;
  name: string;
  gate: boolean;
}

/**
 * Adds the project's CLUs / GATEs to the list (no discovery needed: their IP is in the project).
 * Discovered ones keep the discovery data (address, MAC, cipher, online); project-only entries that
 * left the project are dropped, discovered ones just lose the project name.
 */
export function mergeProject(known: CluInfo[], project: ProjectDevice[]): CluInfo[] {
  const bySerial = new Map(
    known.filter((c) => c.lastSeen !== undefined).map((c) => [c.serial, { ...c, inProject: undefined, name: undefined, gate: undefined } as CluInfo]),
  );
  for (const p of project) {
    const prev = bySerial.get(p.serial) ?? known.find((c) => c.serial === p.serial);
    bySerial.set(
      p.serial,
      prev
        ? { ...prev, address: prev.lastSeen ? prev.address : p.ip, inProject: true, name: p.name, gate: p.gate || undefined }
        : { serial: p.serial, address: p.ip, mac: null, cipher: "", online: false, inProject: true, name: p.name, gate: p.gate || undefined },
    );
  }
  return sortClus([...bySerial.values()]);
}

/** Project CLUs first (by name), then the other discovered ones (by serial). */
function sortClus(list: CluInfo[]): CluInfo[] {
  return list.sort((a, b) => (a.name !== undefined) !== (b.name !== undefined) ? (a.name !== undefined ? -1 : 1) : a.name !== undefined && b.name !== undefined ? a.name.localeCompare(b.name) : a.serial - b.serial);
}

/** Usable for commands: answered discovery, or in the project (contacted by its project IP). */
export const reachable = (c: CluInfo) => c.online || (!!c.inProject && !!c.address);

export const cluObjectId = (c: Pick<CluInfo, "serial">): string => `CLU${c.serial}`;

/** Detail rows shown under a CLU node: [label, value]. */
/** tr: UI translation (views pass vscode.l10n.t). */
export function cluDetails(c: CluInfo, tr: Tr = english): Array<[string, string]> {
  return [
    [tr("Serial"), `${c.serial} (0x${c.serial.toString(16).padStart(8, "0")})`],
    ["IP", c.address ?? tr("unknown")],
    ["MAC", c.mac ?? tr("unknown")],
    [tr("Cipher"), c.cipher || tr("unknown")],
    [tr("Stored key"), c.keySource === "clu" ? tr("own key") : c.keySource === "project" ? tr("project key") : tr("none")],
    [tr("Last seen"), c.lastSeen ? c.lastSeen.toLocaleString() : tr("not discovered (address from the project)")],
  ];
}
