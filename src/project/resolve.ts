/**
 * Resolver: loaded project (names, OM action grammar) → generator model (indexes, Lua lines), via
 * the interface XMLs. Only forms observed in real OM output are produced (docs/OM_LUA_FORMAT.md);
 * anything else is a diagnostic, never a guess.
 */
import type { InterfaceRegistry, ParsedEvent, ParsedFeature, ParsedInterface, ParsedMethod } from "opengr8on-node/client";
import type { Clu, EventBinding, FeatureInit, IoObject, ModuleObject, RawLua, Script, VirtualObject } from "./model";
import type { ActionSource, CluSource, Diagnostic, IoSource, Keyed, Located, ModuleSource, ObjectSource, ProjectSource } from "./load";
import { findArrows, replaceArrows, type ArrowRef } from "../lua/arrows";
import { english, type Tr } from "../i18n";
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
  /** interface className (OBJECT / GATE); undefined when the versions disagree and none is set */
  className?: string;
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

/**
 * Text values are a Lua string's content: OM writes them verbatim between double quotes (observed
 * "\\z"), the user types escapes himself ('Month: April\\r\\n', GATE HTTP manual). A bare quote or a
 * real line break would end / break the string.
 */
function unsafeText(v: string): boolean {
  if (/[\r\n]/.test(v)) return true;
  for (let i = 0; i < v.length; i++) {
    if (v[i] === "\\") i++;
    else if (v[i] === '"') return true;
  }
  return /(^|[^\\])(\\\\)*\\$/.test(v); // a trailing single backslash escapes the closing quote
}

/**
 * Script call as OM compiles it (observed OM 1.13): arguments re-joined with ", ", missing ones
 * padded with nil (`s("x")` → `s("x", nil, nil)`; no arguments → one nil per parameter, `s(nil)`
 * for a script without parameters). On another CLU the same text is wrapped in CLUx:execute(0, "...").
 */
function scriptCall(script: { name: string; params: { name: string }[] }, args: string[], tr: Tr = english): { lua: string } | { error: string } {
  const n = script.params.length;
  if (args.length === 0) return { lua: `${script.name}(${n ? script.params.map(() => "nil").join(", ") : "nil"})` };
  if (args.length > n) return { error: tr("{0} takes {1} argument(s), got {2}", script.name, n, args.length) };
  return { lua: `${script.name}(${[...args.map((x) => x.trim()), ...Array(n - args.length).fill("nil")].join(", ")})` };
}

/** tr: message translation (views pass vscode.l10n.t; see src/i18n.ts). */
export function resolveProject(project: ProjectSource, registry: InterfaceRegistry, tr: Tr = english): ResolveResult {
  const diagnostics: Diagnostic[] = [];
  const err = (at: Located, message: string) => {
    diagnostics.push({ ...at, severity: "error", message });
    return undefined;
  };

  // ---- interfaces per CLU / module / IO ----
  const ctx = new Map<string, CluCtx>();
  for (const c of project.clus) {
    if (c.hw.type === 0x12 && c.modules.length) err(c.at, tr("{0}: a GATE has no TF-Bus modules", c.name));
    if (c.hw.type === 0x12 && (!c.netmask || !c.gateway)) err(c.at, tr("{0}: a GATE needs clu.netmask and clu.gateway (Object Manager: project network settings)", c.name));
    if (c.hw.type !== 0x12 && (c.netmask || c.gateway)) err(c.at, tr("{0}: clu.netmask / clu.gateway are only used by GATEs (hw type 0x12)", c.name));
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
        className: pick?.className ?? (new Set(cands.map((x) => x.className)).size === 1 ? cands[0]?.className : undefined),
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
    if (!list) return err(f.at, tr("{0}: feature \"{1}\" needs the interface XML (not found); use the index as \"<n>\"", owner, f.key));
    const hit = list.find((x) => x.name === f.key);
    return hit ? hit.index : err(f.at, tr("{0}: unknown feature \"{1}\" (known: {2})", owner, f.key, list.map((x) => x.name).join(", ")));
  };
  const eventIndex = (e: Keyed<unknown>, list: ParsedEvent[] | undefined, owner: string): number | undefined => {
    if (/^\d+$/.test(e.key)) return Number(e.key);
    if (!list) return err(e.at, tr("{0}: event \"{1}\" needs the interface XML (not found); use the index as \"<n>\"", owner, e.key));
    const hit = list.find((x) => x.name === e.key);
    return hit ? hit.address : err(e.at, tr("{0}: unknown event \"{1}\" (known: {2})", owner, e.key, list.map((x) => x.name).join(", ")));
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
      if (n === undefined) return err(f.at, tr("{0}: {1} must be one of {2}, got {3}", owner, def.name, def.enums.map((e) => e.name.trim()).join(", "), JSON.stringify(v)));
      return n;
    }
    return v;
  };
  const checkValue = (f: Keyed<FeatureInit[number][1]>, def: ParsedFeature | undefined, owner: string, allowReadOnly = false): boolean => {
    if (!def) return true;
    const v = f.value;
    if (typeof v === "object") return true; // raw { lua } value: written verbatim
    const where = `${owner}: ${def.name}`;
    if (typeof v === "string" && unsafeText(v)) return err(f.at, tr("{0}: a text value is written verbatim into a Lua string: write a quote as \\\" and a line break as \\n", where)) ?? false;
    if (!def.set && !allowReadOnly) return err(f.at, tr("{0} is read-only and cannot be set", where)) ?? false;
    if (def.type === "str" && typeof v !== "string") return err(f.at, tr("{0} expects text, got {1}", where, JSON.stringify(v))) ?? false;
    if (def.type === "num" && typeof v === "string") return err(f.at, tr("{0} expects a number, got \"{1}\"", where, v)) ?? false;
    if (typeof v === "number") {
      if (def.enums.length && !def.enums.some((e) => e.value === v)) {
        const allowed = enumByName(def) ? def.enums.map((e) => e.name.trim()).join(", ") : def.enums.map((e) => `${e.value} (${e.name.trim()})`).join(", ");
        return err(f.at, tr("{0} must be one of {1}, got {2}", where, allowed, v)) ?? false;
      }
      const range = /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/.exec(def.range ?? "");
      if (range && (v < Number(range[1]) || v > Number(range[2]))) return err(f.at, tr("{0} must be in {1}..{2}{3}, got {4}", where, range[1], range[2], def.unit && def.unit !== "-" ? ` ${def.unit}` : "", v)) ?? false;
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
    if (!p) return err(a.at, tr("cannot parse action \"{0}\" (expected CLU->object->Method(args) or CLU->script(args))", a.text));
    const target = ctx.get(p.clu);
    if (!target) return err(a.at, tr("action \"{0}\": no CLU named {1} in this project", a.text, p.clu));
    const local = target === self;

    const call = (objId: string, iface: ParsedInterface | undefined, what: string): string | undefined => {
      if (!iface) return err(a.at, tr("action \"{0}\": no interface XML for {1}; use { lua: ... }", a.text, what));
      const method: ParsedMethod | undefined = iface.methods.find((m) => m.name === p.member);
      if (!method) return err(a.at, tr("action \"{0}\": {1} has no method {2} (known: {3})", a.text, what, p.member, iface.methods.map((m) => m.name).join(", ")));
      // execute: ID:execute(i, args); set (SetMode, ...): ID:set(i, args) — observed in a script
      // (CLU_1->BUTTON->SetMode(0) → CLUx:execute(0, "BUT6012:set(1, 0)")), same form assumed here
      if (method.call !== "execute" && method.call !== "set") return err(a.at, tr("action \"{0}\": {1} is a \"{2}\" method; not supported", a.text, p.member, method.call));
      // OM passes the given arguments only (LEDRGB Switch(0) → execute(11, 0) for 2 params, real .omp)
      if (p.args.length > method.params.length) return err(a.at, tr("action \"{0}\": {1} takes at most {2} argument(s), got {3}", a.text, p.member, method.params.length, p.args.length));
      // observed: Switch() (1 parameter) → OM writes DOU8889:execute(0, ) — broken Lua; refused instead
      if (p.args.length === 0 && method.params.length > 0) return err(a.at, tr("action \"{0}\": pass at least the first argument of {1} (without arguments Object Manager writes \"execute(<n>, )\", which does not run)", a.text, p.member));
      // enum parameters (from the feature a set-method sets): name or number, written as the number
      for (let k = 0; k < p.args.length; k++) {
        const ef = paramEnumFeature(iface, method, k);
        if (!ef) continue;
        const r = enumArg(ef, p.args[k], tr);
        if ("error" in r) return err(a.at, tr("action \"{0}\": {1} {2}", a.text, method.params[k].name, r.error));
        p.args[k] = r.value;
      }
      const line = `${objId}:${method.call}(${[String(method.index), ...p.args].join(", ")})`;
      if (local) return line;
      if (!effectiveRemotes(self.src).some((r) => r.id === target.src.id)) {
        return err(a.at, tr("action \"{0}\": {1} is not in {2}'s remotes", a.text, p.clu, self.src.name));
      }
      return `${target.src.id}:execute(0, "${luaString(line)}")`;
    };

    if (p.object === undefined) {
      const script = target.src.scripts.find((s) => s.name === p.member);
      // CLU->member(args): a script of that CLU, else a method of the CLU object itself
      // (e.g. vCLU mqttOnValueChange = CLU method 30, observed)
      if (!script) {
        if (target.iface?.methods.some((m) => m.name === p.member)) return call(target.src.id, target.iface, target.src.id);
        return err(a.at, tr("action \"{0}\": no script or CLU method {1} on {2}", a.text, p.member, p.clu));
      }
      const compiled = scriptCall(script, p.args, tr);
      if ("error" in compiled) return err(a.at, `${tr("action \"{0}\"", a.text)}: ${compiled.error}`);
      if (local) return compiled.lua;
      // remote (observed in scripts): CLUx:execute(0, "s(\"x\", 1, nil)")
      if (!effectiveRemotes(self.src).some((r) => r.id === target.src.id)) return err(a.at, tr("action \"{0}\": {1} is not in {2}'s remotes", a.text, p.clu, self.src.name));
      return `${target.src.id}:execute(0, "${luaString(compiled.lua)}")`;
    }

    const obj = target.byName.get(p.object) ?? target.byId.get(p.object);
    if (!obj) return err(a.at, tr("action \"{0}\": no object {1} on {2}", a.text, p.object, p.clu));
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
      if (!m) return err(at, tr("{0}.{1}: expected an object reference CLU->OBJECT->Feature", owner, f.name));
      const target = ctx.get(m[1]) ?? [...ctx.values()].find((x) => x.src.id === m[1]);
      if (!target) return err(at, tr("{0}.{1}: no CLU named {2} in this project", owner, f.name, m[1]));
      const obj = target.byName.get(m[2]) ?? target.byId.get(m[2]);
      if (!obj) return err(at, tr("{0}.{1}: no object {2} on {3}", owner, f.name, m[2], m[1]));
      const tf = obj.iface?.features.find((x) => x.name === m[3]);
      if (!tf) return err(at, tr("{0}.{1}: {2} has no feature {3}", owner, f.name, obj.io.id, m[3]));
      const isControl = /Control$/.test(f.name);
      if (target === self && !isControl) return { lua: `{${obj.io.id},${tf.index}}` }; // observed: Source
      if (target !== self && isControl) {
        if (!effectiveRemotes(c).some((x) => x.id === target.src.id)) return err(at, tr("{0}.{1}: {2} is not in {3}'s remotes", owner, f.name, m[1], c.name));
        // observed: Control on another CLU
        return { lua: `"${luaString(`${target.src.id}:execute(0, "${obj.io.id}:set(${tf.index},%v)")`)}"`, comment: `REMOTE_COMMAND ${value.trim()} ${f.name.toUpperCase()}` };
      }
      return err(at, target === self
          ? tr("{0}.{1}: a local reference for {1} is not observed in OM output yet; use { lua: ... }", owner, f.name)
          : tr("{0}.{1}: a remote reference for {1} is not observed in OM output yet; use { lua: ... }", owner, f.name));
    };
    const objects: VirtualObject[] = self.objects.map((info) => {
      const o = info.src;
      const owner = `${c.name}/${o.id}`;
      if (info.ambiguous && [...o.features, ...o.events].some((x) => !/^\d+$/.test(x.key))) {
        err(o.at, tr("{0}: {1} has several interface versions ({2}); set version", owner, o.objectClass, info.ambiguous));
      }
      if (info.objectClass === undefined) err(o.at, tr("{0}: unknown object type {1}", owner, o.objectClass));
      if (o.removed && o.events.length) err(o.at, tr("{0}: removed objects get no events in OM.LUA", owner));
      // the versions of e.g. Timer differ in constructor (v1 OBJECT:new, v2 GATE:new)
      if (info.objectClass !== undefined && !info.className) err(o.at, tr("{0}: {1} has several interface versions ({2}); set version", owner, o.objectClass, info.ambiguous ?? "?"));
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
        ...(info.className && info.className !== "OBJECT" ? { className: info.className } : {}),
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
          err(io.at, tr("{0}: object type {1} not found in the module's interface XML", owner, io.objectClass));
          objectClass = 0;
        }
        let name = io.name;
        if (name === undefined) {
          if (info.objectName) name = defaultIoName(m.serial, info.objectName, io.channel);
          else err(io.at, tr("{0}: no interface XML for this module/class, so the default NAME_IO is unknown; set name", owner));
        }
        if (io.inactive && (io.features.length || io.events.length)) {
          err(io.at, tr("{0}: inactive objects get no events or init values in OM.LUA; remove them or the inactive flag", owner));
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
      if (!target) return err(at, tr("{0}: no CLU named {1} in this project", text, r.clu));
      const local = target === self;
      if (!local && !effectiveRemotes(c).some((x) => x.id === target.src.id)) return err(at, tr("{0}: {1} is not in {2}'s remotes", text, r.clu, c.name));
      const objId = r.object === undefined ? target.src.id : (target.byName.get(r.object) ?? target.byId.get(r.object))?.io.id;
      if (!objId) return err(at, tr("{0}: no object {1} on {2}", text, r.object ?? "", r.clu));
      const iface = r.object === undefined ? target.iface : (target.byName.get(r.object) ?? target.byId.get(r.object))?.iface;
      // remote: the expression runs on the other CLU, OM wraps it (confirmed for reads)
      const wrap = (inner: string) => (local ? inner : `${target.src.id}:execute(0, "${luaString(inner)}")`);
      if (r.kind === "assign") {
        // observed: CLU_1->BUTTON->Mode = 1 → CLUx:execute(0, "BUT6012:set(1, 1)"); local inferred
        if (!iface) return err(at, tr("{0}: no interface XML for {1}; use {1}:set(<index>, value)", text, objId));
        const f = iface.features.find((x) => x.name === r.member);
        if (!f) return err(at, tr("{0}: {1} has no feature {2} (known: {3})", text, objId, r.member, iface.features.map((x) => x.name).join(", ")));
        if (!f.set) return err(at, tr("{0}: feature {1} is read-only", text, r.member));
        let expr = (r.expr ?? "").trim();
        if (!expr) return err(at, tr("{0} = : missing value", text));
        if (f.enums.length && (/^[A-Za-z_]\w*$/.test(expr) || /^-?\d+$/.test(expr))) {
          const isName = f.enums.some((e) => e.name.trim().toLowerCase() === expr.toLowerCase());
          if (isName || /^-?\d+$/.test(expr)) {
            const res = enumArg(f, expr, tr);
            if ("error" in res) return err(at, tr("{0}: {1}", text, res.error));
            expr = res.value;
          }
        }
        if (!local && !/^(-?\d+(\.\d+)?|"(?:[^"\\]|\\.)*"|true|false|nil)$/.test(expr)) {
          return err(at, tr("{0} = {1}: the value of an assignment on another CLU must be a literal (it is evaluated there)", text, expr));
        }
        return wrap(`${objId}:set(${f.index}, ${expr})`);
      }
      // OM compiles scripts line by line: a call whose ")" is on a later line comes out broken
      // (observed: nowy_skrypt("xxx<newline>x2", 2) → nowy_skrypt("xxx, nil, nil)("xxx ...)
      if (r.kind === "call" && (r.args ?? "").includes("\n")) return err(at, tr("{0}(...): the call must end on the same line (Object Manager compiles scripts line by line and would generate broken code)", text));
      const script = r.object === undefined ? target.src.scripts.find((x) => x.name === r.member) : undefined;
      if (script) {
        // observed: CLU->s("x", 1, false) → s("x", 1, false); CLU->s() → s(nil, nil, nil) (one nil per
        // parameter, s(nil) without parameters); on another CLU CLUx:execute(0, "s(nil)")
        if (r.kind !== "call") return err(at, tr("{0}: a script can only be called ({0}())", text));
        const args = (r.args ?? "").trim() ? splitArgs(r.args ?? "") : [];
        const compiled = scriptCall(script, args, tr);
        if ("error" in compiled) return err(at, `${text}: ${compiled.error}`);
        return wrap(compiled.lua);
      }
      if (!iface) return err(at, tr("{0}: no interface XML for {1}; use {1}:get / :set / :execute", text, objId));
      if (r.kind === "read") {
        const f = iface.features.find((x) => x.name === r.member);
        if (!f) return err(at, tr("{0}: {1} has no feature {2} (known: {3})", text, objId, r.member, iface.features.map((x) => x.name).join(", ")));
        // get="false" features (HttpRequest / HttpListener ResponseBody, QueryStringParams, headers)
        // hold Lua tables: readable in a script on the same CLU / GATE only (GATE HTTP manual)
        if (!f.get && !local) return err(at, tr("{0}: feature {1} holds a table and can only be read by a script on {2} itself", text, r.member, r.clu));
        return wrap(`${objId}:get(${f.index})`);
      }
      const m = iface.methods.find((x) => x.name === r.member);
      if (!m) return err(at, tr("{0}: {1} has no method {2} (known: {3})", text, objId, r.member, iface.methods.map((x) => x.name).join(", ")));
      if (m.call !== "execute" && m.call !== "set") return err(at, tr("{0}: {1} is a \"{2}\" method; not supported", text, r.member, m.call));
      let args = (r.args ?? "").trim();
      if (splitArgs(args).length > m.params.length) return err(at, tr("{0}: {1} takes at most {2} argument(s)", text, r.member, m.params.length));
      if (!args && m.params.length > 0) return err(at, tr("{0}(): pass at least the first argument of {1} (without arguments Object Manager writes \"execute(<n>, )\", which does not run)", text, r.member));
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
          const res = enumArg(ef, parts[k], tr);
          if ("error" in res) return err(at, tr("{0}: {1} {2}", text, m.params[k].name, res.error));
          if (res.value !== parts[k]) ((parts[k] = res.value), (changed = true));
        }
        if (changed) args = parts.join(", ");
      }
      if (!local && splitArgs(args).some((a) => a !== "" && !/^(-?\d+(\.\d+)?|"(?:[^"\\]|\\.)*"|true|false|nil)$/.test(a))) {
        return err(at, tr("{0}: arguments of a call on another CLU must be literals (they are evaluated there)", text));
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

    // strings go into OM.LUA / USER.LUA verbatim (as OM writes them): quotes / line breaks not observed
    const badText = (v: unknown) => typeof v === "string" && unsafeText(v);
    for (const v of c.variables) if (badText(v.value)) err(v.at, tr("variable {0}: the value is written verbatim into a Lua string: write a quote as \\\" and a line break as \\n", v.name));
    for (const s of c.scripts) for (const p of s.params) if (badText(p.default)) err(s.at, tr("script {0}: the default of {1} is written verbatim into a Lua string: write a quote as \\\" and a line break as \\n", s.name, p.name));
    // variables: global Lua names, so they must not shadow objects, scripts or each other
    const taken = new Set([c.id, ...self.byId.keys(), ...c.objects.map((o) => o.id), ...c.scripts.map((s) => s.name)]);
    const seenVars = new Set<string>();
    for (const v of c.variables) {
      if (seenVars.has(v.name)) err(v.at, tr("variable {0} is defined twice", v.name));
      else if (taken.has(v.name)) err(v.at, tr("variable {0}: the name is already used by an object or script", v.name));
      seenVars.add(v.name);
    }
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
      ...(c.variables.length ? { variables: c.variables.map(({ name, type, value, persist }) => ({ name, type, value, persist })) } : {}),
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
