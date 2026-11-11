/**
 * Resolver: loaded project (names, OM action grammar) → generator model (indexes, Lua lines), via
 * the interface XMLs. Only forms observed in real OM output are produced (docs/OM_LUA_FORMAT.md);
 * anything else is a diagnostic, never a guess.
 */
import type { InterfaceRegistry, ParsedEvent, ParsedFeature, ParsedInterface, ParsedMethod } from "opengr8on-node/client";
import type { Clu, EventBinding, FeatureInit, IoObject, ModuleObject, RawLua, Script, VirtualObject } from "./model";
import type { ActionSource, CluSource, Diagnostic, IoSource, Keyed, Located, ModuleSource, ObjectSource, ProjectSource } from "./load";
import { findArrows, replaceArrows, type ArrowRef } from "../lua/arrows";
import { enumArg, enumByName, enumValueOf, paramEnumFeature } from "./interfaces";

export interface ResolveResult {
  clus: Clu[];
  diagnostics: Diagnostic[];
}

/** Escapes a Lua line for use inside "..." (remote execute). */
const luaString = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** Splits call arguments at top-level commas (respecting "strings" and parentheses). */
export function splitArgs(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let cur = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      cur += c;
      if (c === "\\") cur += src[++i] ?? "";
      else if (c === '"') quote = false;
      continue;
    }
    if (c === '"') quote = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim() || out.length) out.push(cur.trim());
  return out;
}

/** OM action grammar: CLU->object->Method(args) or CLU->script(args). */
export function parseAction(text: string): { clu: string; object?: string; member: string; args: string[] } | undefined {
  const m = /^([A-Za-z_]\w*)->(?:([^\s>]+?)->)?([A-Za-z_]\w*)\((.*)\)$/.exec(text.trim());
  if (!m) return undefined;
  return { clu: m[1], object: m[2], member: m[3], args: splitArgs(m[4]) };
}

interface IoTarget {
  io: Pick<IoSource, "id">;
  iface?: ParsedInterface;
}

interface ObjectInfo {
  src: ObjectSource;
  iface?: ParsedInterface;
  objectClass?: number;
  /** several interface versions and no `version` given */
  ambiguous?: string;
}

interface CluCtx {
  src: CluSource;
  iface?: ParsedInterface;
  modules: Array<{ src: ModuleSource; ifaceOf: (io: IoSource) => { iface?: ParsedInterface; objectName?: string; objectClass?: number } }>;
  /** IO lookup by NAME_IO (effective) and by id */
  byName: Map<string, IoTarget>;
  byId: Map<string, IoTarget>;
  objects: ObjectInfo[];
}

export function resolveProject(project: ProjectSource, registry: InterfaceRegistry): ResolveResult {
  const diagnostics: Diagnostic[] = [];
  const err = (at: Located, message: string) => {
    diagnostics.push({ ...at, severity: "error", message });
    return undefined;
  };

  // ---- interfaces per CLU / module / IO ----
  const ctx = new Map<string, CluCtx>();
  for (const c of project.clus) {
    if (c.hw.type === 0x12 && (c.modules.length || c.objects.length))
      err(c.at, `${c.name}: GATE with modules or virtual objects — their OM.LUA form on a GATE is not known yet`);
    if (c.hw.type === 0x12 && (!c.netmask || !c.gateway)) err(c.at, `${c.name}: a GATE needs clu.netmask and clu.gateway (Object Manager: project network settings)`);
    if (c.hw.type !== 0x12 && (c.netmask || c.gateway)) err(c.at, `${c.name}: clu.netmask / clu.gateway are only used by GATEs (hw type 0x12)`);
    const cluIface = registry.getCLU(c.hw.type, c.hw.version, c.fw.type, c.fw.version)?.interface;
    const modules = c.modules.map((m) => {
      const [fwType, fwApiVer] = m.commentTail.split(" ").map((x) => parseInt(x, 16));
      const parsed = Number.isFinite(fwType) && Number.isFinite(fwApiVer) ? registry.getModule(parseInt(m.typeLiteral, 16), fwType, fwApiVer) : null;
      const objects = parsed?.firmware?.objects ?? [];
      return {
        src: m,
        ifaceOf: (io: IoSource) => {
          const o = objects.find((x) => (typeof io.objectClass === "number" ? Number(x.class) === io.objectClass : x.name === io.objectClass));
          return { iface: o?.interface, objectName: o?.name, objectClass: o ? Number(o.class) : undefined };
        },
      };
    });
    const byName = new Map<string, IoTarget>();
    const byId = new Map<string, IoTarget>();
    for (const m of modules) {
      for (const io of m.src.ios) {
        const info = m.ifaceOf(io);
        const t = { io, iface: info.iface };
        byId.set(io.id, t);
        const name = io.name ?? (info.objectName ? defaultIoName(m.src.serial, info.objectName, io.channel) : undefined);
        if (name) byName.set(name, t);
      }
    }
    const objects: ObjectInfo[] = c.objects.map((o) => {
      const cands = registry.allObjects().filter((x) => (typeof o.objectClass === "number" ? Number(x.class) === o.objectClass : x.name === o.objectClass));
      const pick = o.version !== undefined ? cands.find((x) => Number(x.version) === o.version) : cands.length === 1 ? cands[0] : undefined;
      const info: ObjectInfo = {
        src: o,
        iface: pick ? { features: pick.features, methods: pick.methods, events: pick.events } : undefined,
        objectClass: typeof o.objectClass === "number" ? o.objectClass : cands[0] ? Number(cands[0].class) : undefined,
        ambiguous: o.version === undefined && cands.length > 1 ? cands.map((x) => `v${Number(x.version)}`).join(", ") : undefined,
      };
      const t = { io: { id: o.id }, iface: info.iface };
      byId.set(o.id, t);
      byName.set(o.name, t);
      return info;
    });
    ctx.set(c.name, { src: c, iface: cluIface, modules, byName, byId, objects });
  }

  // ---- name → index helpers ----
  const featureIndex = (f: Keyed<unknown>, list: ParsedFeature[] | undefined, owner: string): number | undefined => {
    if (/^\d+$/.test(f.key)) return Number(f.key);
    if (!list) return err(f.at, `${owner}: feature "${f.key}" needs the interface XML (not found); use the index as "<n>"`);
    const hit = list.find((x) => x.name === f.key);
    return hit ? hit.index : err(f.at, `${owner}: unknown feature "${f.key}" (known: ${list.map((x) => x.name).join(", ")})`);
  };
  const eventIndex = (e: Keyed<unknown>, list: ParsedEvent[] | undefined, owner: string): number | undefined => {
    if (/^\d+$/.test(e.key)) return Number(e.key);
    if (!list) return err(e.at, `${owner}: event "${e.key}" needs the interface XML (not found); use the index as "<n>"`);
    const hit = list.find((x) => x.name === e.key);
    return hit ? hit.address : err(e.at, `${owner}: unknown event "${e.key}" (known: ${list.map((x) => x.name).join(", ")})`);
  };
  /**
   * Value checks against the interface (every rule holds for all real OM output: tests/unit/
   * validation.test.ts). Virtual objects may set read-only features (OM does: Thermostat OutputType).
   */
  /** YAML value → value written to OM.LUA (enum names → numbers); undefined after an error. */
  const featureValue = (f: Keyed<FeatureInit[number][1]>, def: ParsedFeature | undefined, owner: string): FeatureInit[number][1] | undefined => {
    const v = f.value;
    if (!def || typeof v === "object" || typeof v === "number") return v;
    if (enumByName(def) && (typeof v === "string" || typeof v === "boolean")) {
      const n = enumValueOf(def, v);
      if (n === undefined) return err(f.at, `${owner}: ${def.name} must be one of ${def.enums.map((e) => e.name.trim()).join(", ")}, got ${JSON.stringify(v)}`);
      return n;
    }
    return v;
  };
  const checkValue = (f: Keyed<FeatureInit[number][1]>, def: ParsedFeature | undefined, owner: string, allowReadOnly = false): boolean => {
    if (!def) return true;
    const v = f.value;
    if (typeof v === "object") return true; // raw { lua } value: written verbatim
    const where = `${owner}: ${def.name}`;
    if (!def.set && !allowReadOnly) return err(f.at, `${where} is read-only and cannot be set`) ?? false;
    if (def.type === "str" && typeof v !== "string") return err(f.at, `${where} expects text, got ${JSON.stringify(v)}`) ?? false;
    if (def.type === "num" && typeof v === "string") return err(f.at, `${where} expects a number, got "${v}"`) ?? false;
    if (typeof v === "number") {
      if (def.enums.length && !def.enums.some((e) => e.value === v)) {
        const allowed = enumByName(def) ? def.enums.map((e) => e.name.trim()).join(", ") : def.enums.map((e) => `${e.value} (${e.name.trim()})`).join(", ");
        return err(f.at, `${where} must be one of ${allowed}, got ${v}`) ?? false;
      }
      const range = /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/.exec(def.range ?? "");
      if (range && (v < Number(range[1]) || v > Number(range[2]))) return err(f.at, `${where} must be in ${range[1]}..${range[2]}${def.unit && def.unit !== "-" ? ` ${def.unit}` : ""}, got ${v}`) ?? false;
    }
    return true;
  };
  const features = (list: Keyed<FeatureInit[number][1]>[], iface: ParsedFeature[] | undefined, owner: string): FeatureInit =>
    list.flatMap((f) => {
      const idx = featureIndex(f, iface, owner);
      if (idx === undefined) return [];
      const def = iface?.find((x) => x.index === idx);
      const value = featureValue(f, def, owner);
      if (value === undefined) return [];
      checkValue({ ...f, value }, def, owner);
      return [[idx, value] as FeatureInit[number]];
    });

  // ---- remotes ----
  const effectiveRemotes = (c: CluSource): Array<{ id: string; ip: string; name?: string }> => {
    if (!c.remotes) return project.clus.filter((o) => o !== c).map((o) => ({ id: o.id, ip: o.ip, name: o.name }));
    return c.remotes.flatMap((r) => {
      if (r.kind === "external") return [{ id: r.id, ip: r.ip }];
      const o = ctx.get(r.name)?.src;
      return o ? [{ id: o.id, ip: o.ip, name: o.name }] : [];
    });
  };

  // ---- actions ----
  const compileAction = (a: ActionSource, self: CluCtx): string | undefined => {
    if (a.kind === "lua") return a.text;
    const p = parseAction(a.text);
    if (!p) return err(a.at, `cannot parse action "${a.text}" (expected CLU->object->Method(args) or CLU->script(args))`);
    const target = ctx.get(p.clu);
    if (!target) return err(a.at, `action "${a.text}": no CLU named ${p.clu} in this project`);
    const local = target === self;

    const call = (objId: string, iface: ParsedInterface | undefined, what: string): string | undefined => {
      if (!iface) return err(a.at, `action "${a.text}": no interface XML for ${what}; use { lua: ... }`);
      const method: ParsedMethod | undefined = iface.methods.find((m) => m.name === p.member);
      if (!method) return err(a.at, `action "${a.text}": ${what} has no method ${p.member} (known: ${iface.methods.map((m) => m.name).join(", ")})`);
      // execute: ID:execute(i, args); set (SetMode, ...): ID:set(i, args) — observed in a script
      // (CLU_1->BUTTON->SetMode(0) → CLUx:execute(0, "BUT6012:set(1, 0)")), same form assumed here
      if (method.call !== "execute" && method.call !== "set") return err(a.at, `action "${a.text}": ${p.member} is a "${method.call}" method; not supported`);
      // OM passes the given arguments only (LEDRGB Switch(0) → execute(11, 0) for 2 params, real .omp)
      if (p.args.length > method.params.length) return err(a.at, `action "${a.text}": ${p.member} takes at most ${method.params.length} argument(s), got ${p.args.length}`);
      // enum parameters (from the feature a set-method sets): name or number, written as the number
      for (let k = 0; k < p.args.length; k++) {
        const ef = paramEnumFeature(iface, method, k);
        if (!ef) continue;
        const r = enumArg(ef, p.args[k]);
        if ("error" in r) return err(a.at, `action "${a.text}": ${method.params[k].name} ${r.error}`);
        p.args[k] = r.value;
      }
      const line = `${objId}:${method.call}(${[String(method.index), ...p.args].join(", ")})`;
      if (local) return line;
      if (!effectiveRemotes(self.src).some((r) => r.id === target.src.id)) {
        return err(a.at, `action "${a.text}": ${p.clu} is not in ${self.src.name}'s remotes`);
      }
      return `${target.src.id}:execute(0, "${luaString(line)}")`;
    };

    if (p.object === undefined) {
      const script = target.src.scripts.find((s) => s.name === p.member);
      // CLU->member(args): a script of that CLU, else a method of the CLU object itself
      // (e.g. vCLU mqttOnValueChange = CLU method 30, observed)
      if (!script) {
        if (target.iface?.methods.some((m) => m.name === p.member)) return call(target.src.id, target.iface, target.src.id);
        return err(a.at, `action "${a.text}": no script or CLU method ${p.member} on ${p.clu}`);
      }
      if (p.args.length > 0) return err(a.at, `action "${a.text}": script calls with arguments are not supported yet (only the parameterless form name(nil) is observed)`);
      if (local) return `${p.member}(nil)`;
      // remote: observed in a script (CLU_1->elo2() → CLUx:execute(0, "elo2(nil)")), same form here
      if (!effectiveRemotes(self.src).some((r) => r.id === target.src.id)) return err(a.at, `action "${a.text}": ${p.clu} is not in ${self.src.name}'s remotes`);
      return `${target.src.id}:execute(0, "${luaString(`${p.member}(nil)`)}")`;
    }

    const obj = target.byName.get(p.object) ?? target.byId.get(p.object);
    if (!obj) return err(a.at, `action "${a.text}": no object ${p.object} on ${p.clu}`);
    return call(obj.io.id, obj.iface, obj.io.id);
  };

  const events = (list: Keyed<ActionSource[]>[], iface: ParsedEvent[] | undefined, owner: string, self: CluCtx): EventBinding[] =>
    list.flatMap((e) => {
      const index = eventIndex(e, iface, owner);
      const actions = e.value.map((a) => compileAction(a, self));
      if (index === undefined || actions.some((x) => x === undefined)) return [];
      return actions.length ? [{ index, actions: actions as string[] }] : [];
    });

  // ---- CLUs ----
  const clus: Clu[] = [];
  for (const self of ctx.values()) {
    const c = self.src;
    const allCluEvents = events(c.events, self.iface?.events, c.name, self);
    // CLU OnInit (event 0): last in OnInit as `\t<action> -- CluOnInit` (observed)
    const onInit = allCluEvents.filter((e) => e.index === 0).flatMap((e) => e.actions);
    const cluEvents = allCluEvents.filter((e) => e.index !== 0);

    // virtual objects
    const tableValue = (value: string, f: ParsedFeature, at: Located, owner: string): RawLua | undefined => {
      const m = /^([A-Za-z_]\w*)->([^\s>]+)->([A-Za-z_]\w*)$/.exec(value.trim());
      if (!m) return err(at, `${owner}.${f.name}: expected an object reference CLU->OBJECT->Feature`);
      const target = ctx.get(m[1]) ?? [...ctx.values()].find((x) => x.src.id === m[1]);
      if (!target) return err(at, `${owner}.${f.name}: no CLU named ${m[1]} in this project`);
      const obj = target.byName.get(m[2]) ?? target.byId.get(m[2]);
      if (!obj) return err(at, `${owner}.${f.name}: no object ${m[2]} on ${m[1]}`);
      const tf = obj.iface?.features.find((x) => x.name === m[3]);
      if (!tf) return err(at, `${owner}.${f.name}: ${obj.io.id} has no feature ${m[3]}`);
      const isControl = /Control$/.test(f.name);
      if (target === self && !isControl) return { lua: `{${obj.io.id},${tf.index}}` }; // observed: Source
      if (target !== self && isControl) {
        if (!effectiveRemotes(c).some((x) => x.id === target.src.id)) return err(at, `${owner}.${f.name}: ${m[1]} is not in ${c.name}'s remotes`);
        // observed: Control on another CLU
        return { lua: `"${luaString(`${target.src.id}:execute(0, "${obj.io.id}:set(${tf.index},%v)")`)}"`, comment: `REMOTE_COMMAND ${value.trim()} ${f.name.toUpperCase()}` };
      }
      return err(at, `${owner}.${f.name}: a ${target === self ? "local" : "remote"} reference for ${f.name} is not observed in OM output yet; use { lua: ... }`);
    };
    const objects: VirtualObject[] = self.objects.map((info) => {
      const o = info.src;
      const owner = `${c.name}/${o.id}`;
      if (info.ambiguous && [...o.features, ...o.events].some((x) => !/^\d+$/.test(x.key))) {
        err(o.at, `${owner}: ${o.objectClass} has several interface versions (${info.ambiguous}); set version`);
      }
      if (info.objectClass === undefined) err(o.at, `${owner}: unknown object type ${o.objectClass}`);
      if (o.removed && o.events.length) err(o.at, `${owner}: removed objects get no events in OM.LUA`);
      const feats: FeatureInit = o.features.flatMap((f) => {
        const idx = featureIndex(f, info.iface?.features, owner);
        if (idx === undefined) return [];
        const def = info.iface?.features.find((x) => x.index === idx);
        if (def?.type === "table" && typeof f.value === "string") {
          const raw = tableValue(f.value, def, f.at, owner);
          return raw ? [[idx, raw] as FeatureInit[number]] : [];
        }
        const value = featureValue(f, def, owner);
        if (value === undefined) return [];
        checkValue({ ...f, value }, def, owner, true);
        return [[idx, value] as FeatureInit[number]];
      });
      return {
        id: o.id,
        objectClass: info.objectClass ?? 0,
        name: o.name,
        removed: o.removed || undefined,
        features: feats,
        events: events(o.events, info.iface?.events, owner, self),
      };
    });

    const modules: ModuleObject[] = self.modules.map(({ src: m, ifaceOf }) => ({
      serial: m.serial,
      typeLiteral: m.typeLiteral,
      commentTail: m.commentTail,
      ios: m.ios.map((io): IoObject => {
        const info = ifaceOf(io);
        const owner = `${c.name}/${io.id}`;
        let objectClass = typeof io.objectClass === "number" ? io.objectClass : info.objectClass;
        if (objectClass === undefined) {
          err(io.at, `${owner}: object type ${io.objectClass} not found in the module's interface XML`);
          objectClass = 0;
        }
        let name = io.name;
        if (name === undefined) {
          if (info.objectName) name = defaultIoName(m.serial, info.objectName, io.channel);
          else err(io.at, `${owner}: no interface XML for this module/class, so the default NAME_IO is unknown; set name`);
        }
        if (io.inactive && (io.features.length || io.events.length)) {
          err(io.at, `${owner}: inactive objects get no events or init values in OM.LUA; remove them or the inactive flag`);
        }
        return {
          id: io.id,
          objectClass,
          channel: io.channel,
          name,
          inactive: io.inactive || undefined,
          features: features(io.features, info.iface?.features, owner),
          events: events(io.events, info.iface?.events, owner, self),
        };
      }),
    }));

    // `CLU->OBJ->Member` references in script sources (OM script notation)
    const compileRef = (r: ArrowRef, file: string): string | undefined => {
      const at: Located = { file, range: { start: { line: r.line, col: r.col }, end: { line: r.line, col: r.col + (r.end - r.start) } } };
      const text = `${r.clu}${r.sep}${r.object ? `${r.object}${r.sep}` : ""}${r.member}`;
      const target = ctx.get(r.clu) ?? [...ctx.values()].find((x) => x.src.id === r.clu);
      if (!target) return err(at, `${text}: no CLU named ${r.clu} in this project`);
      const local = target === self;
      if (!local && !effectiveRemotes(c).some((x) => x.id === target.src.id)) return err(at, `${text}: ${r.clu} is not in ${c.name}'s remotes`);
      const objId = r.object === undefined ? target.src.id : (target.byName.get(r.object) ?? target.byId.get(r.object))?.io.id;
      if (!objId) return err(at, `${text}: no object ${r.object} on ${r.clu}`);
      const iface = r.object === undefined ? target.iface : (target.byName.get(r.object) ?? target.byId.get(r.object))?.iface;
      // remote: the expression runs on the other CLU, OM wraps it (confirmed for reads)
      const wrap = (inner: string) => (local ? inner : `${target.src.id}:execute(0, "${luaString(inner)}")`);
      if (r.kind === "assign") {
        // observed: CLU_1->BUTTON->Mode = 1 → CLUx:execute(0, "BUT6012:set(1, 1)"); local inferred
        if (!iface) return err(at, `${text}: no interface XML for ${objId}; use ${objId}:set(<index>, value)`);
        const f = iface.features.find((x) => x.name === r.member);
        if (!f) return err(at, `${text}: ${objId} has no feature ${r.member} (known: ${iface.features.map((x) => x.name).join(", ")})`);
        if (!f.set) return err(at, `${text}: feature ${r.member} is read-only`);
        let expr = (r.expr ?? "").trim();
        if (!expr) return err(at, `${text} = : missing value`);
        if (f.enums.length && (/^[A-Za-z_]\w*$/.test(expr) || /^-?\d+$/.test(expr))) {
          const isName = f.enums.some((e) => e.name.trim().toLowerCase() === expr.toLowerCase());
          if (isName || /^-?\d+$/.test(expr)) {
            const res = enumArg(f, expr);
            if ("error" in res) return err(at, `${text}: ${res.error}`);
            expr = res.value;
          }
        }
        if (!local && !/^(-?\d+(\.\d+)?|"(?:[^"\\]|\\.)*"|true|false|nil)$/.test(expr)) {
          return err(at, `${text} = ${expr}: the value of an assignment on another CLU must be a literal (it is evaluated there)`);
        }
        return wrap(`${objId}:set(${f.index}, ${expr})`);
      }
      if (r.object === undefined && target.src.scripts.some((x) => x.name === r.member)) {
        // observed: CLU_1->elo2() on another CLU → CLUx:execute(0, "elo2(nil)"); local: name(nil)
        // (as in event actions); arguments: form not observed
        if (r.kind !== "call") return err(at, `${text}: a script can only be called (${text}())`);
        if ((r.args ?? "").trim()) return err(at, `${text}(...): script calls with arguments are not supported yet (OM.LUA form not observed)`);
        return wrap(`${r.member}(nil)`);
      }
      if (!iface) return err(at, `${text}: no interface XML for ${objId}; use ${objId}:get / :set / :execute`);
      if (r.kind === "read") {
        const f = iface.features.find((x) => x.name === r.member);
        if (!f) return err(at, `${text}: ${objId} has no feature ${r.member} (known: ${iface.features.map((x) => x.name).join(", ")})`);
        if (!f.get) return err(at, `${text}: feature ${r.member} cannot be read`);
        return wrap(`${objId}:get(${f.index})`);
      }
      const m = iface.methods.find((x) => x.name === r.member);
      if (!m) return err(at, `${text}: ${objId} has no method ${r.member} (known: ${iface.methods.map((x) => x.name).join(", ")})`);
      if (m.call !== "execute" && m.call !== "set") return err(at, `${text}: ${r.member} is a "${m.call}" method; not supported`);
      let args = (r.args ?? "").trim();
      if (splitArgs(args).length > m.params.length) return err(at, `${text}: ${r.member} takes at most ${m.params.length} argument(s)`);
      // enum arguments by name (SetMode(Bistable)) → number; only replaced when the argument is
      // a name of that enum, so Lua expressions pass through unchanged
      if (args) {
        const parts = splitArgs(args);
        let changed = false;
        for (let k = 0; k < parts.length; k++) {
          const ef = paramEnumFeature(iface, m, k);
          if (!ef || !/^[A-Za-z_]\w*$|^-?\d+$/.test(parts[k])) continue;
          const isName = ef.enums.some((e) => e.name.trim().toLowerCase() === parts[k].toLowerCase());
          if (!isName && !/^-?\d+$/.test(parts[k])) continue; // a variable
          const res = enumArg(ef, parts[k]);
          if ("error" in res) return err(at, `${text}: ${m.params[k].name} ${res.error}`);
          if (res.value !== parts[k]) ((parts[k] = res.value), (changed = true));
        }
        if (changed) args = parts.join(", ");
      }
      if (!local && splitArgs(args).some((a) => a !== "" && !/^(-?\d+(\.\d+)?|"(?:[^"\\]|\\.)*"|true|false|nil)$/.test(a))) {
        return err(at, `${text}: arguments of a call on another CLU must be literals (they are evaluated there)`);
      }
      return wrap(`${objId}:${m.call}(${m.index}${args ? `, ${args}` : ""})`);
    };
    const isClu = (name: string) => ctx.has(name) || [...ctx.values()].some((x) => x.src.id === name);
    const compileScript = (src: string, file: string): string => {
      // dotted refs are plain Lua unless they start with a project CLU (CLU_1.NAME.State)
      const refs = findArrows(src).filter((r) => r.sep === "->" || isClu(r.clu));
      if (refs.length === 0) return src;
      const out = refs.map((r) => compileRef(r, file));
      return out.every((x) => x !== undefined) ? replaceArrows(src, refs, out as string[]) : src;
    };

    if (c.scripts.length > 1) err(c.scripts[1].at, `${c.name}: more than one script per CLU is not supported yet (USER.LUA layout for several scripts unknown)`);
    for (const s of c.scripts) if (s.params.length) err(s.at, `script ${s.name}: parameters are not supported yet (USER.LUA rendering unknown)`);
    const scripts: Script[] = c.scripts.map((s) => ({ name: s.name, params: s.params, source: compileScript(s.source, s.file) }));

    clus.push({
      name: c.name,
      id: c.id,
      ip: c.ip,
      fwType: c.fw.type,
      fwVersion: c.fw.version,
      hwType: c.hw.type,
      hwVersion: c.hw.version,
      remotes: effectiveRemotes(c).map(({ id, ip }) => ({ id, ip })),
      features: features(c.features, self.iface?.features, c.name),
      ioOrder: c.ioOrder,
      ...(c.hw.type === 0x12 ? { netmask: c.netmask, gateway: c.gateway } : {}),
      events: cluEvents,
      ...(objects.length ? { objects } : {}),
      ...(onInit.length ? { onInit } : {}),
      modules,
      scripts,
    });
  }
  return { clus, diagnostics };
}

/** OM's default IO name: x<module serial>_<object>_<nn> (nn = channel + 1, two digits). */
export function defaultIoName(moduleSerial: number, objectName: string, channel: number): string {
  return `x${moduleSerial}_${objectName}_${String(channel + 1).padStart(2, "0")}`;
}
