import { LineCounter, isMap, isPair, isScalar, isSeq, parseDocument, type Node, type Pair, type YAMLMap } from "yaml";
import { english, type Tr } from "../i18n";
import type { FeatureValue, RawLua } from "./model";

/**
 * Project loader (format 1, docs/PROJECT_FORMAT.md): YAML + script files → an ordered, still
 * name-based source model with source positions, plus diagnostics. Names (features, events, action
 * targets) are resolved later against the interface XMLs (src/project/resolve.ts); this layer only
 * checks structure and project-wide consistency. Never throws on bad input: everything becomes a
 * diagnostic.
 */

export const FORMAT_VERSION = 1;

/** 0-based position. */
export interface Pos {
  line: number;
  col: number;
}
export interface Range {
  start: Pos;
  end: Pos;
}
export interface Located {
  file: string;
  range: Range;
}

export interface Diagnostic extends Located {
  severity: "error" | "warning";
  message: string;
}

export interface Keyed<V> {
  /** interface name, or index as a decimal string */
  key: string;
  value: V;
  at: Located;
}

export type ActionSource = { kind: "om"; text: string; at: Located } | { kind: "lua"; text: string; at: Located };

export type RemoteSource = { kind: "clu"; name: string; at: Located } | { kind: "external"; id: string; ip: string; at: Located };

export interface IoSource {
  id: string;
  /** class number or interface object name */
  objectClass: number | string;
  channel: number;
  name?: string;
  inactive: boolean;
  features: Keyed<FeatureValue | RawLua>[];
  events: Keyed<ActionSource[]>[];
  at: Located;
}

export interface ObjectSource {
  id: string;
  /** class number or interface object name (Timer) */
  objectClass: number | string;
  /** interface object version (Thermostat v2); needed when several versions exist */
  version?: number;
  name: string;
  removed: boolean;
  features: Keyed<FeatureValue | RawLua>[];
  events: Keyed<ActionSource[]>[];
  at: Located;
}

export interface ModuleSource {
  serial: number;
  typeLiteral: string;
  commentTail: string;
  ios: IoSource[];
  at: Located;
}

export interface ScriptSource {
  name: string;
  params: string[];
  /** file relative to the project root */
  file: string;
  source: string;
  at: Located;
}

export interface CluSource {
  file: string;
  name: string;
  serial: number;
  id: string;
  ip: string;
  hw: { type: number; version: number };
  fw: { type: number; version: number };
  /** undefined = default (all other project CLUs by file name) */
  remotes?: RemoteSource[];
  /** IO declaration order by id; undefined = module order */
  ioOrder?: string[];
  /** GATE only (see model.ts) */
  netmask?: string;
  gateway?: string;
  features: Keyed<FeatureValue | RawLua>[];
  events: Keyed<ActionSource[]>[];
  modules: ModuleSource[];
  /** virtual objects (Timer, Thermostat, ...) */
  objects: ObjectSource[];
  scripts: ScriptSource[];
  at: Located;
}

export interface ProjectSource {
  name: string;
  interfaces: string[];
  clus: CluSource[];
}

/** File access relative to the project root ("/" separators). */
export interface ProjectFiles {
  read(path: string): Promise<string | undefined>;
  /** File names (not paths) in a directory, or [] if it does not exist. */
  list(dir: string): Promise<string[]>;
}

export const ROOT_FILE = "opengr8on.yaml";

/** Keys allowed per mapping (format 1); also used by the editor completion. */
export const KEYS = {
  cluFile: ["clu", "modules", "objects", "scripts"],
  clu: ["name", "serial", "id", "ip", "netmask", "gateway", "hw", "fw", "remotes", "ioOrder", "features", "events"],
  module: ["serial", "type", "comment", "ios"],
  io: ["id", "class", "channel", "name", "inactive", "features", "events"],
  object: ["id", "class", "version", "name", "removed", "features", "events"],
  script: ["name", "params"],
  hwfw: ["type", "version"],
} as const;
export const CLU_DIR = "clus";
export const SCRIPT_DIR = "scripts";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OBJECT_ID = /^[A-Z]{3}[0-9]{4}$/;
const CLU_ID = /^CLU[0-9]+$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const TYPE_LITERAL = /^0x[0-9a-f]+$/;

/** Per-file reader: converts YAML nodes, collecting diagnostics with positions. */
class FileReader {
  readonly lines = new LineCounter();
  constructor(
    readonly file: string,
    private readonly diags: Diagnostic[],
    /** message translation (views pass vscode.l10n.t; see src/i18n.ts) */
    readonly tr: Tr = english,
  ) {}

  private pos(offset: number): Pos {
    const p = this.lines.linePos(offset);
    return { line: p.line - 1, col: p.col - 1 };
  }

  at(node: Node | Pair | null | undefined): Located {
    let r: readonly number[] | null | undefined;
    if (isPair(node)) {
      const k = node.key as Node | null;
      const v = node.value as Node | null;
      r = k?.range && v?.range ? [k.range[0], v.range[1]] : k?.range;
    } else r = node?.range;
    return this.span(r?.[0] ?? 0, r?.[1] ?? 0);
  }

  span(start: number, end: number): Located {
    return { file: this.file, range: { start: this.pos(start), end: this.pos(end) } };
  }

  /** YAML syntax errors of a parsed document; returns true if there were any. */
  syntaxErrors(doc: { errors: Array<{ pos: [number, number]; message: string }> }): boolean {
    for (const e of doc.errors) this.diags.push({ ...this.span(e.pos[0], e.pos[1]), severity: "error", message: e.message.split("\n")[0] });
    return doc.errors.length > 0;
  }

  error(node: Node | Pair | null | undefined, message: string, severity: Diagnostic["severity"] = "error"): undefined {
    this.diags.push({ ...this.at(node), severity, message });
    return undefined;
  }

  map(node: unknown, what: string): YAMLMap | undefined {
    if (isMap(node)) return node;
    if (node === undefined) return undefined;
    return this.error(node as Node, this.tr("{0}: expected a mapping", what));
  }

  /** Pairs of a mapping in document order, with string keys. Reports unknown keys. */
  pairs(map: YAMLMap, allowed?: readonly string[], what = "mapping"): Array<{ key: string; pair: Pair; value: unknown }> {
    const out: Array<{ key: string; pair: Pair; value: unknown }> = [];
    const seen = new Set<string>();
    for (const pair of map.items) {
      const k = isScalar(pair.key) ? pair.key.value : undefined;
      if (typeof k !== "string" && typeof k !== "number") {
        this.error(pair.key as Node, this.tr("{0}: keys must be plain strings", what));
        continue;
      }
      const key = String(k);
      if (seen.has(key)) this.error(pair.key as Node, this.tr('{0}: duplicate key "{1}"', what, key));
      seen.add(key);
      if (allowed && !allowed.includes(key)) {
        this.error(pair.key as Node, this.tr('{0}: unknown key "{1}" (allowed: {2})', what, key, allowed.join(", ")));
        continue;
      }
      out.push({ key, pair, value: pair.value });
    }
    return out;
  }

  get(map: YAMLMap, key: string): unknown {
    return map.items.find((p) => isScalar(p.key) && String(p.key.value) === key)?.value;
  }

  required(map: YAMLMap, key: string, what: string): unknown {
    const v = this.get(map, key);
    if (v === undefined || v === null) this.error(map, this.tr('{0}: missing "{1}"', what, key));
    return v;
  }

  // Type checks are silent on a missing node: required() already reported it.
  str(node: unknown, what: string, pattern?: RegExp, hint?: string): string | undefined {
    if (node === undefined) return undefined;
    if (!isScalar(node) || typeof node.value !== "string") return this.error(node as Node, this.tr("{0}: expected a string", what));
    if (pattern && !pattern.test(node.value)) return this.error(node, hint ? this.tr('{0}: "{1}" is not valid ({2})', what, node.value, hint) : this.tr('{0}: "{1}" is not valid', what, node.value));
    return node.value;
  }

  int(node: unknown, what: string): number | undefined {
    if (node === undefined) return undefined;
    if (!isScalar(node) || typeof node.value !== "number" || !Number.isInteger(node.value) || node.value < 0) {
      return this.error(node as Node, this.tr("{0}: expected a non-negative integer", what));
    }
    return node.value;
  }

  bool(node: unknown, what: string): boolean | undefined {
    if (!isScalar(node) || typeof node.value !== "boolean") return this.error(node as Node, this.tr("{0}: expected true or false", what));
    return node.value;
  }

  seq(node: unknown, what: string): unknown[] | undefined {
    if (node === undefined || node === null || (isScalar(node) && node.value === null)) return [];
    if (!isSeq(node)) return this.error(node as Node, this.tr("{0}: expected a list", what));
    return node.items;
  }
}

function readFeatures(r: FileReader, node: unknown, what: string): Keyed<FeatureValue | RawLua>[] {
  if (node === undefined || node === null) return [];
  const map = r.map(node, what);
  if (!map) return [];
  const out: Keyed<FeatureValue | RawLua>[] = [];
  for (const { key, pair, value } of r.pairs(map, undefined, what)) {
    if (isMap(value)) {
      // raw value written verbatim: { lua: "{PAN9387,0}", comment: "..." }
      r.pairs(value, ["lua", "comment"], `${what}.${key}`);
      const lua = r.str(r.required(value, "lua", `${what}.${key}`), `${what}.${key}.lua`);
      const commentNode = r.get(value, "comment");
      const comment = commentNode === undefined ? undefined : r.str(commentNode, `${what}.${key}.comment`);
      if (lua !== undefined) out.push({ key, value: comment === undefined ? { lua } : { lua, comment }, at: r.at(pair) });
      continue;
    }
    if (!isScalar(value) || !["number", "string", "boolean"].includes(typeof value.value)) {
      r.error((value as Node) ?? pair, r.tr("{0}: expected a number, string or boolean", `${what}.${key}`));
      continue;
    }
    out.push({ key, value: value.value as FeatureValue, at: r.at(pair) });
  }
  return out;
}

function readEvents(r: FileReader, node: unknown, what: string): Keyed<ActionSource[]>[] {
  if (node === undefined || node === null) return [];
  const map = r.map(node, what);
  if (!map) return [];
  const out: Keyed<ActionSource[]>[] = [];
  for (const { key, pair, value } of r.pairs(map, undefined, what)) {
    const actions: ActionSource[] = [];
    for (const item of r.seq(value, `${what}.${key}`) ?? []) {
      if (isScalar(item) && typeof item.value === "string" && item.value.trim()) {
        actions.push({ kind: "om", text: item.value.trim(), at: r.at(item as Node) });
      } else if (isMap(item)) {
        const lua = r.pairs(item, ["lua"], `${what}.${key}[]`)[0];
        const text = lua ? r.str(lua.value, `${what}.${key}[].lua`) : r.error(item, r.tr("{0}: expected { lua: ... }", `${what}.${key}[]`));
        if (text?.trim()) actions.push({ kind: "lua", text, at: r.at(item) });
      } else r.error(item as Node, r.tr("{0}: expected an action string or { lua: ... }", `${what}.${key}[]`));
    }
    out.push({ key, value: actions, at: r.at(pair) });
  }
  return out;
}

function readHwFw(r: FileReader, node: unknown, what: string): { type: number; version: number } | undefined {
  const map = r.map(node, what);
  if (!map) return undefined;
  r.pairs(map, KEYS.hwfw, what);
  const type = r.int(r.required(map, "type", what), `${what}.type`);
  const version = r.int(r.required(map, "version", what), `${what}.version`);
  return type === undefined || version === undefined ? undefined : { type, version };
}

function readIo(r: FileReader, node: unknown, what: string): IoSource | undefined {
  const map = r.map(node, what);
  if (!map) return undefined;
  r.pairs(map, KEYS.io, what);
  const id = r.str(r.required(map, "id", what), `${what}.id`, OBJECT_ID, "3 capital letters + 4 digits, e.g. DIM1186");
  const w = id ? `io ${id}` : what;
  const classNode = r.required(map, "class", w);
  let objectClass: number | string | undefined;
  if (isScalar(classNode) && typeof classNode.value === "number") objectClass = r.int(classNode, `${w}.class`);
  else if (classNode !== undefined) objectClass = r.str(classNode, `${w}.class`, NAME, "class number or interface object name");
  const channel = r.int(r.required(map, "channel", w), `${w}.channel`);
  const nameNode = r.get(map, "name");
  const name = nameNode === undefined ? undefined : r.str(nameNode, `${w}.name`, /^[^=\r\n]+$/, "no '=' or line breaks");
  const inactiveNode = r.get(map, "inactive");
  const inactive = inactiveNode === undefined ? false : r.bool(inactiveNode, `${w}.inactive`);
  const features = readFeatures(r, r.get(map, "features"), `${w}.features`);
  const events = readEvents(r, r.get(map, "events"), `${w}.events`);
  if (id === undefined || objectClass === undefined || channel === undefined) return undefined;
  return { id, objectClass, channel, name, inactive: inactive ?? false, features, events, at: r.at(map) };
}

function readModule(r: FileReader, node: unknown, what: string): ModuleSource | undefined {
  const map = r.map(node, what);
  if (!map) return undefined;
  r.pairs(map, KEYS.module, what);
  const serial = r.int(r.required(map, "serial", what), `${what}.serial`);
  const w = serial !== undefined ? `module ${serial}` : what;
  const typeNode = r.required(map, "type", w);
  const typeLiteral =
    isScalar(typeNode) && typeof typeNode.value === "number"
      ? r.error(typeNode, r.tr('{0}: quote it ("0x…"): the literal is emitted verbatim, a number loses its zero padding', `${w}.type`))
      : typeNode === undefined
        ? undefined
        : r.str(typeNode, `${w}.type`, TYPE_LITERAL, 'lower-case hex literal, e.g. "0x1a"');
  const commentNode = r.required(map, "comment", w);
  const commentTail = commentNode === undefined ? undefined : r.str(commentNode, `${w}.comment`);
  const ios = (r.seq(r.get(map, "ios"), `${w}.ios`) ?? []).map((n, i) => readIo(r, n, `${w}.ios[${i}]`)).filter((x): x is IoSource => !!x);
  if (serial === undefined || typeLiteral === undefined || commentTail === undefined) return undefined;
  return { serial, typeLiteral, commentTail, ios, at: r.at(map) };
}

function readRemotes(r: FileReader, node: unknown): RemoteSource[] | undefined {
  if (node === undefined) return undefined;
  const out: RemoteSource[] = [];
  for (const item of r.seq(node, "clu.remotes") ?? []) {
    if (isScalar(item)) {
      const name = r.str(item, "clu.remotes[]", NAME, "a CLU name");
      if (name) out.push({ kind: "clu", name, at: r.at(item as Node) });
      continue;
    }
    const map = r.map(item, "clu.remotes[]");
    if (!map) continue;
    r.pairs(map, ["id", "ip"], "clu.remotes[]");
    const id = r.str(r.required(map, "id", "clu.remotes[]"), "clu.remotes[].id", CLU_ID, "CLU<digits>");
    const ip = r.str(r.required(map, "ip", "clu.remotes[]"), "clu.remotes[].ip", IPV4, "IPv4");
    if (id && ip) out.push({ kind: "external", id, ip, at: r.at(map) });
  }
  return out;
}

async function readCluFile(files: ProjectFiles, file: string, diags: Diagnostic[], tr: Tr): Promise<CluSource | undefined> {
  const text = (await files.read(file)) ?? "";
  const r = new FileReader(file, diags, tr);
  const doc = parseDocument(text, { lineCounter: r.lines, prettyErrors: false, uniqueKeys: false });
  if (r.syntaxErrors(doc)) return undefined;
  const root = r.map(doc.contents, file);
  if (!root) return undefined;
  r.pairs(root, KEYS.cluFile, file);

  const cluNode = r.map(r.required(root, "clu", file), "clu");
  if (!cluNode) return undefined;
  r.pairs(cluNode, KEYS.clu, "clu");
  const name = r.str(r.required(cluNode, "name", "clu"), "clu.name", NAME, "letters, digits, _");
  const expected = file.replace(/^.*\//, "").replace(/\.ya?ml$/, "");
  if (name !== undefined && name !== expected) r.error(r.get(cluNode, "name") as Node, r.tr('clu.name "{0}" must match the file name "{1}"', name, expected));
  const serial = r.int(r.required(cluNode, "serial", "clu"), "clu.serial");
  const idNode = r.get(cluNode, "id");
  const id = idNode === undefined ? (serial !== undefined ? `CLU${serial}` : undefined) : r.str(idNode, "clu.id", CLU_ID, "CLU<digits>");
  const ip = r.str(r.required(cluNode, "ip", "clu"), "clu.ip", IPV4, "IPv4");
  const optIp = (key: "netmask" | "gateway") => {
    const n = r.get(cluNode, key);
    return n === undefined ? undefined : r.str(n, `clu.${key}`, IPV4, "IPv4");
  };
  const netmask = optIp("netmask");
  const gateway = optIp("gateway");
  const hw = readHwFw(r, r.required(cluNode, "hw", "clu"), "clu.hw");
  const fw = readHwFw(r, r.required(cluNode, "fw", "clu"), "clu.fw");
  const remotes = readRemotes(r, r.get(cluNode, "remotes"));
  const ioOrderNode = r.get(cluNode, "ioOrder");
  const ioOrder = ioOrderNode === undefined ? undefined : (r.seq(ioOrderNode, "clu.ioOrder") ?? []).map((n) => r.str(n, "clu.ioOrder[]", OBJECT_ID, "an object id"));
  const features = readFeatures(r, r.get(cluNode, "features"), "clu.features");
  const events = readEvents(r, r.get(cluNode, "events"), "clu.events");

  const modules = (r.seq(r.get(root, "modules"), "modules") ?? []).map((n, i) => readModule(r, n, `modules[${i}]`)).filter((x): x is ModuleSource => !!x);

  const objects: ObjectSource[] = [];
  for (const [k, n] of (r.seq(r.get(root, "objects"), "objects") ?? []).entries()) {
    const what = `objects[${k}]`;
    const map = r.map(n, what);
    if (!map) continue;
    r.pairs(map, KEYS.object, what);
    const oid = r.str(r.required(map, "id", what), `${what}.id`, OBJECT_ID, "3 capital letters + 4 digits, e.g. TIM8908");
    const w = oid ? `object ${oid}` : what;
    const classNode = r.required(map, "class", w);
    const objectClass = isScalar(classNode) && typeof classNode.value === "number" ? r.int(classNode, `${w}.class`) : classNode === undefined ? undefined : r.str(classNode, `${w}.class`, NAME, "class number or object name (Timer)");
    const versionNode = r.get(map, "version");
    const version = versionNode === undefined ? undefined : r.int(versionNode, `${w}.version`);
    const oname = r.str(r.required(map, "name", w), `${w}.name`, /^[^=\r\n]+$/, "no '=' or line breaks");
    const removedNode = r.get(map, "removed");
    const removed = removedNode === undefined ? false : r.bool(removedNode, `${w}.removed`);
    const features = readFeatures(r, r.get(map, "features"), `${w}.features`);
    const events = readEvents(r, r.get(map, "events"), `${w}.events`);
    if (oid && objectClass !== undefined && oname !== undefined) {
      objects.push({ id: oid, objectClass, version, name: oname, removed: removed ?? false, features, events, at: r.at(map) });
    }
  }

  const scripts: ScriptSource[] = [];
  for (const [i, n] of (r.seq(r.get(root, "scripts"), "scripts") ?? []).entries()) {
    const map = r.map(n, `scripts[${i}]`);
    if (!map) continue;
    r.pairs(map, KEYS.script, `scripts[${i}]`);
    const sname = r.str(r.required(map, "name", `scripts[${i}]`), `scripts[${i}].name`, NAME, "a Lua identifier");
    const params = (r.seq(r.get(map, "params"), `scripts[${i}].params`) ?? []).map((p) => r.str(p, `scripts[${i}].params[]`, NAME, "a Lua identifier"));
    if (!sname || !name || params.some((p) => p === undefined)) continue;
    const sfile = `${SCRIPT_DIR}/${name}/${sname}.lua`;
    const source = await files.read(sfile);
    if (source === undefined) r.error(r.get(map, "name") as Node, r.tr("script {0}: {1} not found", sname ?? "", sfile));
    scripts.push({ name: sname, params: params as string[], file: sfile, source: source ?? "", at: r.at(map) });
  }

  if (name === undefined || serial === undefined || id === undefined || ip === undefined || !hw || !fw) return undefined;
  if (ioOrder) {
    const ids = modules.flatMap((m) => m.ios.map((io) => io.id));
    const listed = new Set(ioOrder.filter((x): x is string => !!x));
    const missing = ids.filter((x) => !listed.has(x));
    const unknown = [...listed].filter((x) => !ids.includes(x));
    if (missing.length || unknown.length || listed.size !== ioOrder.length) {
      const parts = [
        missing.length ? r.tr("missing {0}", missing.join(", ")) : "",
        unknown.length ? r.tr("unknown {0}", unknown.join(", ")) : "",
        listed.size !== ioOrder.length ? r.tr("duplicates") : "",
      ].filter(Boolean);
      r.error(ioOrderNode as Node, `${r.tr("clu.ioOrder must list every IO exactly once")}; ${parts.join("; ")}`);
    }
  }
  const order = ioOrder?.every((x) => x) ? (ioOrder as string[]) : undefined;
  return { file, name, serial, id, ip, netmask, gateway, hw, fw, remotes, ioOrder: order, features, events, modules, objects, scripts, at: r.at(cluNode) };
}

function dup<T>(items: T[], key: (t: T) => string | number, report: (t: T, first: T) => void): void {
  const seen = new Map<string | number, T>();
  for (const t of items) {
    const k = key(t);
    const first = seen.get(k);
    if (first !== undefined) report(t, first);
    else seen.set(k, t);
  }
}

/** Loads a project. `project` is undefined when the root file is unusable. */
export async function loadProject(files: ProjectFiles, tr: Tr = english): Promise<{ project?: ProjectSource; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const err = (at: Located, message: string) => diagnostics.push({ ...at, severity: "error", message });

  const rootText = await files.read(ROOT_FILE);
  if (rootText === undefined) {
    err({ file: ROOT_FILE, range: { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } } }, tr("{0} not found", ROOT_FILE));
    return { diagnostics };
  }
  const r = new FileReader(ROOT_FILE, diagnostics, tr);
  const doc = parseDocument(rootText, { lineCounter: r.lines, prettyErrors: false });
  if (r.syntaxErrors(doc)) return { diagnostics };
  const root = r.map(doc.contents, ROOT_FILE);
  if (!root) return { diagnostics };
  r.pairs(root, ["format", "name", "interfaces"], ROOT_FILE);
  const formatNode = r.required(root, "format", ROOT_FILE);
  const format = formatNode === undefined ? undefined : r.int(formatNode, "format");
  if (format !== undefined && format !== FORMAT_VERSION) {
    r.error(formatNode as Node, tr("format {0} is not supported by this extension (expected {1})", String(format), FORMAT_VERSION));
    return { diagnostics };
  }
  const name = r.str(r.required(root, "name", ROOT_FILE), "name");
  const interfaces = (r.seq(r.get(root, "interfaces"), "interfaces") ?? []).map((n) => r.str(n, "interfaces[]")).filter((x): x is string => !!x);
  if (name === undefined || format === undefined) return { diagnostics };

  const clus: CluSource[] = [];
  const cluFiles = (await files.list(CLU_DIR)).filter((f) => /\.ya?ml$/.test(f)).sort();
  for (const f of cluFiles) {
    const clu = await readCluFile(files, `${CLU_DIR}/${f}`, diagnostics, tr);
    if (clu) clus.push(clu);
  }

  // project-wide consistency
  dup(clus, (c) => c.name, (c) => err(c.at, tr("CLU name {0} is used twice", c.name)));
  dup(clus, (c) => c.serial, (c, f) => err(c.at, tr("CLU serial {0} is also used by {1}", c.serial, f.name)));
  dup(clus, (c) => c.id, (c, f) => err(c.at, tr("CLU id {0} is also used by {1}", c.id, f.name)));
  // by file, so a CLU file with errors does not also break every remote pointing at it
  const names = new Set(cluFiles.map((f) => f.replace(/\.ya?ml$/, "")));
  for (const c of clus) {
    for (const rem of c.remotes ?? []) {
      if (rem.kind === "clu" && !names.has(rem.name)) err(rem.at, tr("remote {0}: no clus/{0}.yaml in this project", rem.name));
      if (rem.kind === "clu" && rem.name === c.name) err(rem.at, tr("remote {0}: a CLU cannot be its own remote", rem.name));
    }
    const ios = c.modules.flatMap((m) => m.ios.map((io) => ({ io, m })));
    dup(c.modules, (m) => m.serial, (m) => err(m.at, tr("module {0} is listed twice", m.serial)));
    dup(ios, (x) => x.io.id, (x) => err(x.io.at, tr("object id {0} is used twice on {1}", x.io.id, c.name)));
    for (const o of c.objects) if (ios.some((x) => x.io.id === o.id)) err(o.at, tr("object id {0} is used twice on {1}", o.id, c.name));
    dup(c.objects, (o) => o.id, (o) => err(o.at, tr("object id {0} is used twice on {1}", o.id, c.name)));
    dup(ios, (x) => `${x.m.serial}/${x.io.objectClass}/${x.io.channel}`, (x, f) => err(x.io.at, tr("{0}: same module, class and channel as {1}", x.io.id, f.io.id)));
    dup(c.scripts, (s) => s.name, (s) => err(s.at, tr("script {0} is listed twice", s.name)));
  }

  return { project: { name, interfaces, clus }, diagnostics };
}
