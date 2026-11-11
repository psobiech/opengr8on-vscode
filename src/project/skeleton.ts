/** New-object helpers: OM-style ids and a CLU skeleton from CONFIG.JSON (fresh CLU, no OM.LUA). */
import type { CluConfigView } from "../device/cluConfig";
import type { Clu, ModuleObject } from "./model";

/** OM id prefix: first 3 letters of the interface object name (426/426 real IOs). */
export const idPrefix = (objectName: string) => objectName.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase().padEnd(3, "X");

/** `<PREFIX><4 digits>` not in `taken` (random, like OM); adds it to `taken`. */
export function allocateId(objectName: string, taken: Set<string>, random: () => number = Math.random): string {
  const prefix = idPrefix(objectName);
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const id = `${prefix}${String(Math.floor(random() * 10_000)).padStart(4, "0")}`;
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
  for (let n = 0; n < 10_000; n++) {
    const id = `${prefix}${String(n).padStart(4, "0")}`;
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
  throw new Error(`no free object id with prefix ${prefix}`);
}

/**
 * CLU model from a CONFIG.JSON view: header from the CLU, modules (typeLiteral = hwType, comment =
 * fwType fwApiVer as OM writes them) and every IO with a fresh id. Z-Wave devices and modules without
 * interface XML are skipped (returned in `skipped`).
 */
export function skeletonFromConfig(
  cfg: CluConfigView,
  opts: { name: string; ip: string; taken?: Set<string>; random?: () => number },
): { clu: Clu; skipped: string[] } {
  const taken = opts.taken ?? new Set<string>();
  const skipped: string[] = [];
  const modules: ModuleObject[] = [];
  for (const m of cfg.modules) {
    if (m.bus !== "tfbus" || !m.known || m.fwType === undefined) {
      skipped.push(`${m.name} (serial ${m.serial})`);
      continue;
    }
    modules.push({
      serial: m.serial,
      typeLiteral: `0x${m.hwType.toString(16).padStart(2, "0")}`,
      commentTail: `${m.fwType.toString(16).padStart(2, "0")} ${m.fwApiVer.toString(16).padStart(2, "0")}`,
      ios: m.ios.map((io) => ({ id: allocateId(io.objectName, taken, opts.random), objectClass: io.objectClass, channel: io.channel, features: [], events: [] })),
    });
  }
  const clu: Clu = {
    name: opts.name,
    id: `CLU${cfg.serial}`,
    ip: opts.ip,
    fwType: cfg.fwType,
    fwVersion: cfg.fwApiVer,
    hwType: cfg.hwType,
    hwVersion: cfg.hwVer,
    remotes: [],
    features: [],
    events: [],
    modules,
    scripts: [],
  };
  return { clu, skipped };
}
