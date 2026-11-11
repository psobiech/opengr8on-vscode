/**
 * .omp import: OM project (opengr8on-node readOmpProject) → project files (format 1). Event actions
 * stay in OM's own grammar, so the normal loader + resolver compile them; the acceptance test
 * compares the result with the OM.LUA OM itself generated (diagnostics/ inside the .omp).
 */
import type { InterfaceRegistry, OmpClu, OmpFeature, OmpProject } from "opengr8on-node/client";
import type { Clu, FeatureInit, IoObject, ModuleObject, VirtualObject } from "./model";
import { cluToYaml } from "./toYaml";

export interface ImportedProject {
  /** project-relative path → content (opengr8on.yaml, clus/*.yaml, scripts/<CLU>/*.lua) */
  files: Map<string, string>;
  notes: string[];
}

const hexInt = (s: string | undefined) => (s ? parseInt(s, 16) : NaN);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** OM initValue (raw string) → Lua value as OM writes it in OnInit; undefined = not initialised. */
export function initLiteral(f: OmpFeature): FeatureInit[number][1] | undefined {
  const v = f.initValue;
  if (v === undefined) return undefined;
  if (f.paramType === "STRING") return v; // an empty string is emitted as "" (real .omp)
  if (v === "") return undefined;
  if (f.paramType === "BOOLEAN") return v === "true" ? true : v === "false" ? false : Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

/** OnInit sets every feature with an init value except read-only ones (CloudConnection, real .omp). */
function features(list: OmpFeature[]): FeatureInit {
  return list.flatMap((f) => {
    if (f.accessType === "READ") return [];
    const v = initLiteral(f);
    return v === undefined ? [] : [[f.index, v] as FeatureInit[number]];
  });
}

/** A CLU of the .omp as a model whose event actions are still OM action strings. */
export interface OmpImportOptions {
  /**
   * Reproduce OM's output byte for byte (acceptance tests): keep removed virtual objects (OM writes
   * them commented out) and CLUs in OM's trash (OM still declares them as remotes on every CLU and
   * compiles references to their objects). Off for a normal import: both are deleted in OM and are
   * left out; a script still using a trashed CLU then shows "no CLU named ..." at that line.
   */
  omExact?: boolean;
}

/** Deleted in OM but still stored in the project (OM's trash). */
export const inTrash = (c: OmpClu) => c.isRemoved === "true";

export function ompCluModel(c: OmpClu, all: OmpClu[], options: OmpImportOptions = {}, network: OmpProject["network"] = {}): { clu: Clu; notes: string[] } {
  const notes: string[] = [];
  const serial = hexInt(c.serialNumber);
  const modules = new Map<string, ModuleObject>();
  for (const m of c.modules) {
    modules.set(m.moduleID, {
      serial: Number(m.moduleID),
      typeLiteral: `0x${(m.moduleClass ?? "").toLowerCase()}`,
      commentTail: `${m.moduleTypeFirmware ?? ""} ${m.moduleVersion ?? ""}`,
      ios: [],
    });
  }
  const order: string[] = [];
  for (const io of c.ios) {
    if (io.isRemoved === "true") continue;
    const modId = io.module?.moduleID;
    if (!modId) {
      notes.push(`${c.name}/${io.nameOnCLU}: no module (virtual object?) — skipped, not supported yet`);
      continue;
    }
    let mod = modules.get(modId);
    if (!mod) {
      mod = { serial: Number(modId), typeLiteral: `0x${(io.module?.moduleClass ?? "").toLowerCase()}`, commentTail: `${io.module?.moduleTypeFirmware ?? ""} ${io.module?.moduleVersion ?? ""}`, ios: [] };
      modules.set(modId, mod);
      notes.push(`${c.name}: module ${modId} only referenced by IOs`);
    }
    const obj: IoObject = {
      id: io.nameOnCLU,
      objectClass: Number(io.classTypeId),
      channel: Number(io.number),
      name: io.name,
      inactive: io.active === "false" ? true : undefined,
      features: io.active === "false" ? [] : features(io.features),
      events: io.active === "false" ? [] : io.events.filter((e) => e.commands.length).map((e) => ({ index: e.index, actions: e.commands })),
    };
    mod.ios.push(obj);
    order.push(obj.id);
  }
  // virtual objects: every feature with an init value (read-only ones too, unlike CLU / IO features:
  // Thermostat OutputType); table features stay OM references (CLU->OBJ->Feature) for the resolver
  const removed = c.periphery.filter((p) => p.isRemoved === "true");
  if (removed.length && !options.omExact) notes.push(`${c.name}: ${removed.length} removed virtual object(s) not imported`);
  const objects: VirtualObject[] = c.periphery.filter((p) => options.omExact || p.isRemoved !== "true").map((p) => ({
    id: p.nameOnCLU,
    objectClass: Number(p.typeId),
    name: p.name,
    removed: p.isRemoved === "true" || undefined,
    version: p.typeVersion !== undefined ? Number(p.typeVersion) : undefined,
    features: p.features.flatMap((f) => {
      const v = initLiteral(f);
      return v === undefined ? [] : [[f.index, v] as FeatureInit[number]];
    }),
    events: p.events.filter((e) => e.commands.length).map((e) => ({ index: e.index, actions: e.commands })),
  }));
  const mods = [...modules.values()];
  const moduleOrder = mods.flatMap((m) => m.ios.map((io) => io.id));
  const clu: Clu = {
    name: NAME.test(c.name) ? c.name : c.name.replace(/[^A-Za-z0-9_]/g, "_"),
    id: c.nameOnCLU || `CLU${serial}`,
    ip: c.ipAddress,
    fwType: hexInt(c.firmwareType),
    fwVersion: hexInt(c.firmwareVersion),
    hwType: hexInt(c.hardwareType),
    hwVersion: hexInt(c.hardwareVersion),
    remotes: all.filter((o) => o !== c).map((o) => ({ id: o.nameOnCLU || `CLU${hexInt(o.serialNumber)}`, ip: o.ipAddress })),
    features: features(c.features),
    ioOrder: order.some((id, k) => id !== moduleOrder[k]) ? order : undefined,
    ...(hexInt(c.hardwareType) === 0x12 ? { netmask: network.netmask, gateway: network.gateway } : {}),
    events: c.events.filter((e) => e.commands.length).map((e) => ({ index: e.index, actions: e.commands })),
    modules: mods,
    ...(objects.length ? { objects } : {}),
    scripts: c.scripts.map((s) => ({ name: s.name, params: s.parameters, source: (s.source ?? "").replace(/\r\n/g, "\n") })),
  };
  if (clu.name !== c.name) notes.push(`CLU "${c.name}" renamed to ${clu.name} (file name)`);
  return { clu, notes };
}


export function importOmp(project: OmpProject, registry: InterfaceRegistry, options: OmpImportOptions = {}): ImportedProject {
  const files = new Map<string, string>();
  const notes: string[] = [];
  files.set("opengr8on.yaml", `format: 1\nname: ${JSON.stringify(project.name || "imported")}\n`);
  if (!options.omExact) for (const t of project.clus.filter(inTrash)) notes.push(`${t.name}: in the Object Manager trash — not imported`);
  const clus = options.omExact ? project.clus : project.clus.filter((c) => !inTrash(c));
  const models = clus.map((c) => ompCluModel(c, clus, options, project.network));
  const ids = new Map(models.map(({ clu }) => [clu.id, clu.name]));
  for (const { clu, notes: n } of models) {
    notes.push(...n);
    files.set(`clus/${clu.name}.yaml`, cluToYaml(clu, registry, { projectClus: ids, actions: "om" }));
    for (const s of clu.scripts) files.set(`scripts/${clu.name}/${s.name}.lua`, s.source);
  }
  return { files, notes };
}
