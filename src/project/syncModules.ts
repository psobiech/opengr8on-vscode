/**
 * Project modules follow the CLU's bus scan: after Refresh Modules the CLU's CONFIG.JSON lists the
 * TF-Bus modules that answered, and the `modules:` list of clus/<CLU>.yaml is brought in line with
 * it. Pure: text in, text out (format kept: yaml Document API).
 */
import { isMap, isSeq, parseDocument, YAMLSeq } from "yaml";
import type { CluConfigView, ModuleView } from "../device/cluConfig";
import { skeletonFromConfig } from "./skeleton";

export interface ModuleSync {
  text: string;
  /** serials appended (reported by the CLU, not in the file) */
  added: number[];
  /** serials dropped (TF-Bus modules the CLU no longer reports) */
  removed: number[];
  /** IO ids of the dropped modules */
  removedIds: string[];
  /** reported modules not added (no interface XML / not TF-Bus), as "name (serial n)" */
  skipped: string[];
}

/** A `type:` of one byte is a TF-Bus module; wider ones (Z-Wave 0x8500030011, ...) are not ours. */
const isTfbusType = (t: unknown) => {
  const n = typeof t === "number" ? t : typeof t === "string" ? parseInt(t, 16) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 0xff;
};

/**
 * Drops the TF-Bus modules the CLU did not report and appends the reported ones the file lacks (IOs
 * with fresh ids not in `taken`, like a CLU imported without OM.LUA). Modules of other buses and
 * everything outside `modules:` stay as they are.
 */
export function syncModulesInCluYaml(text: string, cfg: Pick<CluConfigView, "modules">, taken: Set<string>, random?: () => number): ModuleSync {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`the CLU file has YAML errors: ${doc.errors[0].message.split("\n")[0]}`);
  if (!isMap(doc.contents)) throw new Error("the CLU file is not a mapping");
  let seq = doc.get("modules", true);
  if (seq !== undefined && seq !== null && !isSeq(seq) && (seq as { value?: unknown }).value !== null) throw new Error("modules: is not a list");
  const reported = cfg.modules.filter((m) => m.bus === "tfbus");
  const onBus = new Set(reported.map((m) => m.serial));
  const removed: number[] = [];
  const removedIds: string[] = [];
  const inFile = new Set<number>();
  if (isSeq(seq)) {
    seq.items = seq.items.filter((item) => {
      if (!isMap(item)) return true;
      const serial = Number(item.get("serial"));
      inFile.add(serial);
      if (!isTfbusType(item.get("type")) || onBus.has(serial)) return true;
      removed.push(serial);
      const ios = item.get("ios", true);
      if (isSeq(ios)) for (const io of ios.items) if (isMap(io) && io.get("id") !== undefined) removedIds.push(String(io.get("id")));
      return false;
    });
  }
  const missing: ModuleView[] = reported.filter((m) => !inFile.has(m.serial));
  const { clu, skipped } = skeletonFromConfig({ ...(cfg as CluConfigView), modules: missing }, { name: "_", ip: "", taken, random });
  if (clu.modules.length) {
    if (!isSeq(seq)) {
      seq = new YAMLSeq();
      doc.set("modules", seq);
    }
    for (const m of clu.modules) {
      (seq as YAMLSeq).add(
        doc.createNode({
          serial: m.serial,
          type: m.typeLiteral,
          comment: m.commentTail,
          ios: m.ios.map((io) => ({ id: io.id, class: io.objectClass, channel: io.channel })),
        }),
      );
    }
  }
  if (isSeq(seq) && seq.items.length === 0) doc.delete("modules");
  const added = clu.modules.map((m) => m.serial);
  return { text: added.length || removed.length ? doc.toString({ lineWidth: 0 }) : text, added, removed, removedIds, skipped };
}
