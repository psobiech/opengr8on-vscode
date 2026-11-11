/**
 * Editor assistance with friendly names (pure, no vscode): completion and inlay hints for Lua
 * scripts (plain Lua: completion shows NAME_IO but inserts the object id; hints show names next to
 * ids and feature / method names next to indexes) and for project YAML (OM action grammar, feature /
 * event keys). Built from the resolved project + interface XMLs.
 */
import { isMap, isPair, isScalar, isSeq, parseDocument, type Node } from "yaml";
import type { InterfaceRegistry, ParsedFeature, ParsedInterface, ParsedMethod } from "opengr8on-node/client";
import type { Clu } from "./model";
import { cluInterface, enumByName, ioObject, moduleObjects, objectInterface, paramEnumFeature } from "./interfaces";
import { KEYS } from "./load";

export interface ObjInfo {
  /** friendly name: NAME_IO, CLU name */
  name: string;
  /** object id on the CLU (DIM1186, CLU100000013) */
  id: string;
  kind: "io" | "clu" | "remote";
  /** interface object type name (DIMM) or CLU type */
  typeName?: string;
  iface?: ParsedInterface;
  detail: string;
}

export interface CluIndex {
  clu: Clu;
  objects: ObjInfo[];
  byId: Map<string, ObjInfo>;
  byName: Map<string, ObjInfo>;
}

export type ProjectIndex = Map<string, CluIndex>;

export function buildIndex(clus: Clu[], registry: InterfaceRegistry): ProjectIndex {
  const index: ProjectIndex = new Map();
  for (const clu of clus) {
    const objects: ObjInfo[] = [];
    const byIdExtra: ObjInfo[] = [];
    const ci = cluInterface(registry, clu);
    objects.push({ name: clu.name, id: clu.id, kind: "clu", typeName: "CLU", iface: ci, detail: `this CLU ${clu.id} (${clu.ip})` });
    for (const m of clu.modules) {
      for (const io of m.ios) {
        const o = ioObject(registry, m, io.objectClass);
        objects.push({
          name: io.name ?? io.id,
          id: io.id,
          kind: "io",
          typeName: o?.name,
          iface: o?.interface,
          detail: `${io.id} · ${o?.name ?? `class ${io.objectClass}`} · module ${m.serial} ch ${io.channel}${io.inactive ? " · inactive" : ""}`,
        });
      }
    }
    for (const v of clu.objects ?? []) {
      const o = objectInterface(registry, v.objectClass, v.version);
      if (v.removed) {
        // not a completion / action target, but its features are still edited in the YAML
        byIdExtra.push({ name: v.name, id: v.id, kind: "io", typeName: o?.name, iface: o?.iface, detail: `${v.id} (removed)` });
        continue;
      }
      objects.push({ name: v.name, id: v.id, kind: "io", typeName: o?.name, iface: o?.iface, detail: `${v.id} · ${o?.name ?? `class ${v.objectClass}`} (virtual)` });
    }
    for (const r of clu.remotes) {
      const other = clus.find((c) => c.id === r.id);
      objects.push({ name: other?.name ?? r.id, id: r.id, kind: "remote", typeName: "RemoteCLU", detail: `remote CLU ${r.id} (${r.ip}): execute(0, "<lua>")` });
    }
    index.set(clu.name, { clu, objects, byId: new Map([...objects, ...byIdExtra].map((o) => [o.id, o])), byName: new Map(objects.map((o) => [o.name, o])) });
  }
  return index;
}

export interface Item {
  label: string;
  /** text inserted; snippet syntax when `snippet` */
  insert: string;
  snippet?: boolean;
  detail: string;
  documentation?: string;
  /** lower sorts first */
  sort: string;
  kind: "object" | "clu" | "feature" | "method" | "event" | "script";
  /** extra text the filter matches (e.g. the id behind a friendly name) */
  filter?: string;
}

const featureDoc = (f: ParsedFeature) =>
  [f.type, f.range ? `range ${f.range}` : "", f.unit && f.unit !== "-" ? f.unit : "", f.enums.length ? f.enums.map((e) => `${e.value}=${e.name}`).join(", ") : "", f.set ? "" : "read-only"]
    .filter(Boolean)
    .join(" · ");
const methodSig = (m: ParsedMethod) => `${m.name}(${m.params.map((p) => p.name).join(", ")})`;
/** Argument placeholders; enum parameters (set-methods) get a choice of names (`${1|Locked,Bistable|}`). */
const paramSnippet = (m: ParsedMethod, iface?: ParsedInterface) =>
  m.params
    .map((p, k) => {
      const ef = iface ? paramEnumFeature(iface, m, k) : undefined;
      if (ef && enumByName(ef)) return `\${${k + 1}|${ef.enums.map((e) => e.name.trim().replace(/[|,$}\\]/g, "")).join(",")}|}`;
      return `\${${k + 1}:${p.name.replace(/[}$\\]/g, "")}}`;
    })
    .join(", ");

// ---------------------------------------------------------------------------------------- Lua

export type LuaContext =
  | { kind: "index"; objectId: string; op: "get" | "set" | "execute" }
  | { kind: "arrowObject"; clu: string; word: string }
  | { kind: "arrowMember"; clu: string; object: string; word: string }
  | { kind: "object"; word: string };

/** What to complete at the end of `linePrefix` in a Lua script. */
export function luaContext(linePrefix: string): LuaContext {
  const idx = /([A-Za-z_]\w*):(get|set|execute)\(\s*$/.exec(linePrefix);
  if (idx) return { kind: "index", objectId: idx[1], op: idx[2] as "get" | "set" | "execute" };
  const member = /(?:^|[^\w.:])([A-Za-z_]\w*)->([A-Za-z_]\w*)->(\w*)$/.exec(linePrefix);
  if (member) return { kind: "arrowMember", clu: member[1], object: member[2], word: member[3] };
  const obj = /(?:^|[^\w.:>-])([A-Za-z_]\w*)->(\w*)$/.exec(linePrefix);
  if (obj) return { kind: "arrowObject", clu: obj[1], word: obj[2] };
  return { kind: "object", word: /([A-Za-z_]\w*)$/.exec(linePrefix)?.[1] ?? "" };
}

/** Objects of the script's CLU by friendly name (inserting the id), friendly names first. */
export function luaObjectItems(clu: CluIndex): Item[] {
  return clu.objects.map((o) => ({
    label: o.name,
    insert: o.id,
    detail: o.name === o.id ? o.detail : `${o.id} · ${o.detail}`,
    sort: `${o.kind === "io" ? "0" : "1"}${o.name}`,
    kind: o.kind === "io" ? "object" : "clu",
    filter: `${o.name} ${o.id}`,
  }));
}

/** OM notation `CLU->`: objects of that CLU by friendly name (ids after), its features and methods. */
export function arrowObjectItems(index: ProjectIndex, cluRef: string): Item[] {
  const clu = index.get(cluRef) ?? [...index.values()].find((c) => c.clu.id === cluRef);
  if (!clu) return [];
  const items: Item[] = [];
  for (const o of clu.objects.filter((x) => x.kind === "io")) {
    items.push({ label: o.name, insert: o.name, detail: o.detail, sort: `0${o.name}`, kind: "object", filter: `${o.name} ${o.id}` });
    if (o.name !== o.id) items.push({ label: o.id, insert: o.id, detail: `${o.name} · ${o.detail}`, sort: `3${o.id}`, kind: "object" });
  }
  const self = clu.objects.find((x) => x.kind === "clu");
  if (self) items.push(...arrowMemberItems(self).map((i) => ({ ...i, sort: `1${i.sort}` })));
  return items;
}

/** OM notation `CLU->OBJECT->`: readable features (as values) and execute methods (as calls). */
export function arrowMemberItems(o: ObjInfo): Item[] {
  if (!o.iface) return [];
  const id = (n: string) => /^[A-Za-z_]\w*$/.test(n);
  return [
    ...o.iface.features
      .filter((f) => f.get && id(f.name))
      .map((f) => ({ label: f.name, insert: f.name, detail: `${f.index} · ${featureDoc(f)}`, sort: `0${String(f.index).padStart(4, "0")}`, kind: "feature" as const })),
    ...o.iface.methods
      .filter((m) => (m.call === "execute" || m.call === "set") && id(m.name))
      .map((m) => ({ label: m.name, insert: `${m.name}(${paramSnippet(m, o.iface)})`, snippet: true, detail: `${m.index} · ${methodSig(m)}`, sort: `1${m.name}`, kind: "method" as const })),
  ];
}

/** Indexes for get / set / execute of an object, by feature / method name. */
export function luaIndexItems(o: ObjInfo, op: "get" | "set" | "execute"): Item[] {
  if (!o.iface) return [];
  if (op === "execute") {
    return o.iface.methods
      .filter((m) => m.call === "execute")
      .map((m) => ({
        label: m.name,
        insert: m.params.length ? `${m.index}, ${paramSnippet(m)}` : String(m.index),
        snippet: true,
        detail: `${m.index} · ${methodSig(m)}`,
        sort: String(m.index).padStart(4, "0"),
        kind: "method" as const,
      }));
  }
  return o.iface.features
    .filter((f) => (op === "get" ? f.get : f.set))
    .map((f) => ({
      label: f.name,
      insert: op === "set" ? `${f.index}, \${1:value}` : String(f.index),
      snippet: op === "set",
      detail: `${f.index} · ${featureDoc(f)}`,
      sort: String(f.index).padStart(4, "0"),
      kind: "feature" as const,
    }));
}

export interface Hint {
  /** offset where the hint is shown (after the token) */
  offset: number;
  label: string;
  tooltip: string;
}

/** Offsets of Lua strings / comments, to skip them. */
function codeMask(src: string): boolean[] {
  const skip = new Array<boolean>(src.length).fill(false);
  let i = 0;
  const mark = (a: number, b: number) => {
    for (let k = a; k < Math.min(b, src.length); k++) skip[k] = true;
  };
  while (i < src.length) {
    const c = src[i];
    if (src.startsWith("--", i)) {
      const lc = /^--\[(=*)\[/.exec(src.slice(i, i + 64));
      const end = lc ? (src.indexOf(`]${lc[1]}]`, i) + lc[1].length + 2 || src.length) : src.indexOf("\n", i) < 0 ? src.length : src.indexOf("\n", i);
      mark(i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      mark(i, j + 1);
      i = j + 1;
    } else if (/^\[(=*)\[/.test(src.slice(i, i + 64))) {
      const eq = /^\[(=*)\[/.exec(src.slice(i, i + 64))![1];
      const close = src.indexOf(`]${eq}]`, i);
      const end = close < 0 ? src.length : close + eq.length + 2;
      mark(i, end);
      i = end;
    } else i++;
  }
  return skip;
}

/** Inlay hints for a Lua script: friendly name after each known id, member name after indexes. */
export function luaHints(src: string, clu: CluIndex): Hint[] {
  const skip = codeMask(src);
  const hints: Hint[] = [];
  for (const m of src.matchAll(/\b([A-Za-z_]\w*)\b(?::(get|set|execute)\(\s*(\d+))?/g)) {
    if (skip[m.index]) continue;
    const o = clu.byId.get(m[1]);
    if (!o) continue;
    const idEnd = m.index + m[1].length;
    if (o.name !== o.id) hints.push({ offset: idEnd, label: o.name, tooltip: o.detail });
    if (m[2] && m[3] !== undefined && o.iface) {
      const n = Number(m[3]);
      const member =
        m[2] === "execute" ? o.iface.methods.find((x) => x.call === "execute" && x.index === n)?.name : o.iface.features.find((f) => f.index === n)?.name;
      if (member) hints.push({ offset: m.index + m[0].length, label: member, tooltip: `${o.name}.${member}` });
    }
  }
  return hints;
}

// --------------------------------------------------------------------------------------- YAML

/** Completion inside an OM action string: `CLU`, `CLU->object`, `CLU->object->Method(`. */
export function actionItems(index: ProjectIndex, typed: string): { items: Item[]; replaceLength: number } {
  const m = /^([A-Za-z_]\w*)->(?:([^\s>(]*)->)?([^\s>(]*)$/.exec(typed);
  if (!m) {
    const word = /([A-Za-z_]\w*)$/.exec(typed)?.[1] ?? "";
    const items = [...index.keys()].map((name) => ({ label: name, insert: `${name}->`, detail: `CLU ${index.get(name)!.clu.id}`, sort: `0${name}`, kind: "clu" as const }));
    return { items, replaceLength: word.length };
  }
  const [, cluName, objName, partial] = m;
  const clu = index.get(cluName);
  if (!clu) return { items: [], replaceLength: 0 };
  if (objName === undefined) {
    const items: Item[] = [];
    for (const o of clu.objects.filter((x) => x.kind === "io")) {
      items.push({ label: o.name, insert: `${o.name}->`, detail: o.detail, sort: `0${o.name}`, kind: "object", filter: `${o.name} ${o.id}` });
      if (o.name !== o.id) items.push({ label: o.id, insert: `${o.id}->`, detail: `${o.name} · ${o.detail}`, sort: `2${o.id}`, kind: "object" });
    }
    for (const s of clu.clu.scripts) items.push({ label: s.name, insert: `${s.name}()`, detail: "script", sort: `1${s.name}`, kind: "script" });
    const self = clu.objects.find((x) => x.kind === "clu");
    for (const meth of self?.iface?.methods.filter((x) => x.call === "execute") ?? []) {
      items.push({ label: meth.name, insert: `${meth.name}(${paramSnippet(meth)})`, snippet: true, detail: `CLU method ${methodSig(meth)}`, sort: `1${meth.name}`, kind: "method" });
    }
    return { items, replaceLength: partial.length };
  }
  const o = clu.byName.get(objName) ?? clu.byId.get(objName);
  const methods = o?.iface?.methods.filter((x) => x.call === "execute" || x.call === "set") ?? [];
  const items = methods.map((meth) => ({
    label: meth.name,
    insert: `${meth.name}(${paramSnippet(meth, o?.iface)})`,
    snippet: true,
    detail: methodSig(meth),
    sort: `0${meth.name}`,
    kind: "method" as const,
  }));
  return { items, replaceLength: partial.length };
}

/** YAML path (keys / seq indexes) of the innermost node at `offset`. */
export function yamlPathAt(text: string, offset: number): Array<string | number> {
  const doc = parseDocument(text, { keepSourceTokens: false });
  const path: Array<string | number> = [];
  let node: unknown = doc.contents;
  const inside = (n: unknown) => {
    const r = (n as Node | null)?.range;
    return !!r && offset >= r[0] && offset <= r[2];
  };
  for (;;) {
    if (isMap(node)) {
      const hit = node.items.find((p) => isPair(p) && (inside(p.value) || inside(p.key)));
      if (!hit) break;
      path.push(String(isScalar(hit.key) ? hit.key.value : "?"));
      if (!inside(hit.value)) break;
      node = hit.value;
    } else if (isSeq(node)) {
      const k = node.items.findIndex((n) => inside(n));
      if (k < 0) break;
      path.push(k);
      node = node.items[k];
    } else break;
  }
  return path;
}

/** Feature or event key completion for the IO / CLU that encloses `path` in a clus/<name>.yaml. */
export function keyItems(clu: CluIndex, text: string, path: Array<string | number>): Item[] {
  const section = path.lastIndexOf("features") >= 0 && path.lastIndexOf("features") >= path.lastIndexOf("events") ? "features" : path.includes("events") ? "events" : undefined;
  if (!section) return [];
  let target: ObjInfo | undefined;
  if (path[0] === "clu") target = clu.objects.find((o) => o.kind === "clu");
  else if (path[0] === "objects" && typeof path[1] === "number") {
    const id = parseDocument(text).getIn(["objects", path[1], "id"]);
    target = typeof id === "string" ? clu.byId.get(id) : undefined;
  }
  else if (path[0] === "modules" && typeof path[1] === "number" && path[2] === "ios" && typeof path[3] === "number") {
    const doc = parseDocument(text);
    const id = doc.getIn(["modules", path[1], "ios", path[3], "id"]);
    target = typeof id === "string" ? clu.byId.get(id) : undefined;
  }
  if (!target?.iface) return [];
  if (section === "features") {
    return target.iface.features.filter((f) => f.set).map((f) => ({ label: f.name, insert: `${f.name}: `, detail: `${f.index} · ${featureDoc(f)}`, sort: String(f.index).padStart(4, "0"), kind: "feature" as const }));
  }
  return target.iface.events.map((e) => ({ label: e.name, insert: `${e.name}:\n  - `, detail: `event ${e.address}`, sort: String(e.address).padStart(4, "0"), kind: "event" as const }));
}

export interface YamlContext {
  /** what is being typed */
  kind: "featureKey" | "featureValue" | "eventKey" | "action" | "structureKey";
  owner: "clu" | "io" | "object" | "none";
  /** object id (io / object) */
  id?: string;
  /** item lines of the owning object (class / module type, for objects not resolved yet) */
  objectClass?: string;
  module?: { type?: string; comment?: string };
  /** featureValue: the feature name */
  feature?: string;
  /** structureKey: which mapping (KEYS entry) */
  mapping?: keyof typeof KEYS;
  /** keys already present in that mapping */
  existing: string[];
}

const indentOf = (l: string) => l.length - l.trimStart().length;

/**
 * Context at `offset` from the indentation of the lines above: works while the file is being typed
 * and does not parse. Finds the enclosing mapping keys up to the object (list item with id:) /
 * `clu:` that owns the position.
 */
export function yamlContext(text: string, offset: number): YamlContext | undefined {
  const before = text.slice(0, offset).split("\n");
  const all = text.split("\n");
  const cur = before.length - 1;
  const curLine = before[cur];
  const curIsItem = /^\s*-\s/.test(curLine);
  const valueMatch = /^\s*([A-Za-z_0-9"']+)\s*:\s*([^#]*)$/.exec(curLine);
  // indentation of the key being typed (for "- key" the key sits 2 further in)
  const keyIndent = curLine.trim() === "" ? curLine.length : indentOf(curLine) + (curIsItem ? 2 : 0);

  type Anc = { line: number; key: string; indent: number; item: boolean };
  const ancestors: Anc[] = [];
  let limit = curIsItem ? indentOf(curLine) : keyIndent;
  for (let i = cur - 1; i >= 0; i--) {
    const l = all[i];
    if (!l.trim() || l.trim().startsWith("#")) continue;
    const ind = indentOf(l);
    // a list item at the same indent as the key being typed is the item we are in
    const sameItem = !curIsItem && /^\s*-\s/.test(l) && ind + 2 === keyIndent && ancestors.length === 0;
    if (ind >= limit && !sameItem) continue;
    const m = /^\s*(-\s+)?([A-Za-z_0-9"']+)\s*:/.exec(l);
    ancestors.push({ line: i, key: m ? m[2].replace(/["']/g, "") : "", indent: ind, item: /^\s*-\s/.test(l) });
    limit = ind;
    if (ind === 0) break;
  }
  const top = ancestors[ancestors.length - 1]?.key;
  const blockEnd = (line: number, ind: number) => {
    let i = line + 1;
    while (i < all.length && (all[i].trim() === "" || indentOf(all[i]) > ind)) i++;
    return i;
  };
  /** value of `key:` directly in the item / mapping starting at `line` (block or flow style) */
  const itemValue = (line: number, ind: number, key: string): string | undefined => {
    const flow = new RegExp(`[{,\\s]${key}:\\s*("[^"]*"|'[^']*'|[^,}\\s]+)`).exec(" " + all[line]);
    if (flow) return flow[1].replace(/["']/g, "");
    for (let i = line + 1; i < blockEnd(line, ind); i++) {
      const m = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*(?:#.*)?$`).exec(all[i]);
      if (m && indentOf(all[i]) === ind + 2) return m[1].replace(/["']/g, "");
    }
    return undefined;
  };
  const keysIn = (line: number, ind: number, childIndent: number) => {
    const keys: string[] = [];
    for (let i = line + 1; i < blockEnd(line, ind); i++) {
      const m = /^\s*(?:-\s+)?([A-Za-z_0-9"']+)\s*:/.exec(all[i]);
      const ki = indentOf(all[i]) + (/^\s*-\s/.test(all[i]) ? 2 : 0);
      if (m && i !== cur && ki === childIndent) keys.push(m[1].replace(/["']/g, ""));
    }
    const first = /^\s*-\s+([A-Za-z_0-9"']+)\s*:/.exec(all[line]);
    if (first && line !== cur) keys.push(first[1].replace(/["']/g, ""));
    const flow = /\{([^}]*)\}/.exec(all[line]);
    if (flow) for (const m of flow[1].matchAll(/([A-Za-z_0-9"']+)\s*:/g)) keys.push(m[1].replace(/["']/g, ""));
    return keys;
  };
  /** owning object of the ancestors from index `from` */
  const owner = (from: number): Pick<YamlContext, "owner" | "id" | "objectClass" | "module"> | undefined => {
    for (let k = from; k < ancestors.length; k++) {
      const a = ancestors[k];
      if (a.key === "clu" && a.indent === 0) return { owner: "clu" };
      if (a.item) {
        const id = itemValue(a.line, a.indent, "id");
        const objectClass = itemValue(a.line, a.indent, "class");
        if (top === "objects") return { owner: "object", id, objectClass };
        const mod = ancestors.slice(k + 1).find((x) => x.item);
        return { owner: "io", id, objectClass, module: mod ? { type: itemValue(mod.line, mod.indent, "type"), comment: itemValue(mod.line, mod.indent, "comment") } : undefined };
      }
    }
    return undefined;
  };

  const [parent, grand] = ancestors;
  // value of a feature: "  Mode: |"
  if (valueMatch && parent?.key === "features" && !curIsItem) {
    const o = owner(1);
    return o ? { kind: "featureValue", ...o, feature: valueMatch[1].replace(/["']/g, ""), existing: [] } : undefined;
  }
  if (valueMatch && !curIsItem && valueMatch[2].trim() !== "") return undefined; // other values: no suggestions
  if (parent?.key === "features" || parent?.key === "events") {
    if (curIsItem) return undefined;
    const o = owner(1);
    const childIndent = keyIndent;
    return o ? { kind: parent.key === "features" ? "featureKey" : "eventKey", ...o, existing: keysIn(parent.line, parent.indent, childIndent) } : undefined;
  }
  if (grand?.key === "events" && curIsItem) {
    const o = owner(2);
    return o ? { kind: "action", ...o, existing: [] } : undefined;
  }
  // structure keys: which mapping are we in?
  const mapping = (): keyof typeof KEYS | undefined => {
    if (!parent) return keyIndent === 0 ? "cluFile" : undefined;
    if (parent.key === "clu" && parent.indent === 0 && !parent.item) return "clu";
    if (parent.key === "hw" || parent.key === "fw") return "hwfw";
    if (parent.item || (curIsItem && ["ios", "modules", "objects", "scripts"].includes(parent.key))) {
      const list = parent.item ? ancestors.find((x, k) => k > 0 && !x.item && x.indent < parent.indent)?.key : parent.key;
      return list === "ios" ? "io" : list === "modules" ? "module" : list === "objects" ? "object" : list === "scripts" ? "script" : undefined;
    }
    return undefined;
  };
  const m = mapping();
  if (!m) return undefined;
  const at = parent?.item ? parent : undefined;
  return { kind: "structureKey", owner: "none", mapping: m, existing: at ? keysIn(at.line, at.indent, keyIndent) : parent ? keysIn(parent.line, parent.indent, keyIndent) : [] };
}
/** Completion in a clus/<CLU>.yaml at `offset` (`linePrefix` = text of the line before the cursor). */
export function yamlCompletion(
  index: ProjectIndex,
  clu: CluIndex | undefined,
  text: string,
  offset: number,
  linePrefix: string,
  registry?: InterfaceRegistry,
): { items: Item[]; replaceLength: number } {
  const ctx = yamlContext(text, offset);
  const word = /([A-Za-z_0-9.-]*)$/.exec(linePrefix)?.[1] ?? "";
  if (!ctx) return { items: [], replaceLength: 0 };
  if (ctx.kind === "action") {
    if (/^\s*-\s+lua\s*:/.test(linePrefix)) return { items: [], replaceLength: 0 };
    const typed = /^\s*-\s+["']?([^"'#]*)$/.exec(linePrefix)?.[1] ?? "";
    return actionItems(index, typed);
  }
  if (ctx.kind === "structureKey") {
    const items = KEYS[ctx.mapping!]
      .filter((k) => !ctx.existing.includes(k))
      .map((k, n) => ({ label: k, insert: `${k}: `, detail: `${ctx.mapping} key`, sort: String(n).padStart(3, "0"), kind: "feature" as const }));
    return { items, replaceLength: /([A-Za-z_0-9]*)$/.exec(linePrefix)?.[1].length ?? 0 };
  }
  // the specific object's interface: resolved index first, else from the YAML (class + module)
  const target = ctx.owner === "clu" ? clu?.objects.find((o) => o.kind === "clu") : ctx.id ? clu?.byId.get(ctx.id) : undefined;
  let iface = target?.iface;
  if (!iface && registry && ctx.objectClass) {
    if (ctx.owner === "object") {
      const cls = /^\d+$/.test(ctx.objectClass) ? Number(ctx.objectClass) : registry.allObjects().find((o) => o.name === ctx.objectClass)?.class;
      iface = cls !== undefined ? objectInterface(registry, Number(cls))?.iface : undefined;
    } else if (ctx.module?.type && ctx.module.comment) {
      const objs = moduleObjects(registry, { typeLiteral: ctx.module.type, commentTail: ctx.module.comment });
      iface = objs.find((o) => (/^\d+$/.test(ctx.objectClass!) ? Number(o.class) === Number(ctx.objectClass) : o.name === ctx.objectClass))?.interface;
    }
  }
  if (!iface) return { items: [], replaceLength: word.length };
  const virtual = ctx.owner === "object";
  if (ctx.kind === "featureValue") {
    const f = iface.features.find((x) => x.name === ctx.feature);
    if (!f) return { items: [], replaceLength: 0 };
    const typed = /:\s*(\S*)$/.exec(linePrefix)?.[1] ?? "";
    const byName = enumByName(f);
    const items: Item[] = f.enums.length
      ? f.enums.map((e) => ({
          label: byName ? e.name.trim() : String(e.value),
          insert: byName ? e.name.trim() : String(e.value),
          detail: `${byName ? `= ${e.value}` : e.name.trim()}${f.default === String(e.value) ? " (default)" : ""}`,
          sort: String(e.value).padStart(6, "0"),
          kind: "feature" as const,
        }))
      : [{ label: f.default !== undefined && f.default !== "" ? f.default : f.type === "str" ? '""' : "0", insert: f.default !== undefined && f.default !== "" ? (f.type === "str" ? JSON.stringify(f.default) : f.default) : f.type === "str" ? '""' : "0", detail: featureDoc(f), sort: "0", kind: "feature" as const }];
    return { items, replaceLength: typed.length };
  }
  if (ctx.kind === "featureKey") {
    const settable = iface.features.filter((f) => (f.set || virtual) && LUA_NAME.test(f.name));
    const items = settable.map((f) => {
      const done = ctx.existing.includes(f.name);
      return { label: f.name, insert: `${f.name}: `, detail: `${done ? "already set · " : ""}${f.index} · ${featureDoc(f)}`, sort: `${done ? 1 : 0}${String(f.index).padStart(4, "0")}`, kind: "feature" as const };
    });
    return { items, replaceLength: /([A-Za-z_0-9]*)$/.exec(linePrefix)?.[1].length ?? 0 };
  }
  const items = iface.events.map((e) => {
    const done = ctx.existing.includes(e.name);
    return { label: e.name, insert: `${e.name}:`, detail: `${done ? "already used · " : ""}event ${e.address}`, sort: `${done ? 1 : 0}${String(e.address).padStart(4, "0")}`, kind: "event" as const };
  });
  return { items, replaceLength: /([A-Za-z_0-9]*)$/.exec(linePrefix)?.[1].length ?? 0 };
}

const LUA_NAME = /^[A-Za-z_]\w*$/;
