/**
 * Strict OM.LUA parser: OM output → resolved project model (src/project/model.ts). The inverse of
 * src/generator/omLua.ts; `emitOmLua(parseOmLua(x).clu) === x` is the round-trip golden test. Any
 * line that does not fit the known layout (docs/OM_LUA_FORMAT.md) throws with its line number:
 * unknown constructs are reported, never guessed.
 */
import { HELPERS } from "../generator/omLua";
import type { Clu, EventBinding, FeatureValue, IoObject, ModuleObject, RawLua, UserVariable, VirtualObject } from "./model";

/**
 * Value of an OnInit set line (text between "<id>:set(<i>, " and the end): a Lua literal, or a raw
 * value (table, or any literal followed by a ` -- comment`) kept verbatim.
 */
export function parseSetValue(rest: string): FeatureValue | RawLua | undefined {
  const withComment = /^(.*)\) -- ([^"]*)$/.exec(rest);
  if (withComment) return { lua: withComment[1], comment: withComment[2] };
  if (!rest.endsWith(")")) return undefined;
  const lit = rest.slice(0, -1);
  const v = parseOmLiteral(lit);
  if (v !== undefined) return v;
  return /^\{[^"{}]*\}$/.test(lit) ? { lua: lit } : undefined;
}

export class OmLuaParseError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(`OM.LUA line ${line}: ${message}`);
  }
}

/** Parses a Lua literal as OM writes it in OnInit: number, "string" (escaped), true / false. */
export function parseLuaLiteral(src: string): FeatureValue | undefined {
  if (src === "true") return true;
  if (src === "false") return false;
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(src)) return Number(src);
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(src);
  if (!m) return undefined;
  return m[1].replace(/\\(.)/g, (_, c: string) => ({ n: "\n", r: "\r", t: "\t" })[c] ?? c);
}

/** Like parseLuaLiteral, but strings kept verbatim (OM writes them unescaped, see omString). */
export function parseOmLiteral(src: string): FeatureValue | undefined {
  const m = /^"([^"\r\n]*)"$/.exec(src);
  return m ? m[1] : /^"/.test(src) ? undefined : parseLuaLiteral(src);
}

const hexNum = (h: string) => parseInt(h, 16);

export function parseOmLua(text: string): { clu: Clu; eol: "\r\n" | "\n" } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (!text.endsWith(eol)) throw new OmLuaParseError(text.split(eol).length, "file does not end with a line break");
  const lines = text.slice(0, -eol.length).split(eol);
  let i = 0;
  const fail = (msg: string): never => {
    throw new OmLuaParseError(i + 1, `${msg}: ${JSON.stringify(lines[i] ?? "<end of file>")}`);
  };
  const expect = (exact: string) => {
    if (lines[i] !== exact) fail(`expected ${JSON.stringify(exact)}`);
    i++;
  };
  const match = (re: RegExp, what: string): RegExpExecArray => {
    const m = re.exec(lines[i] ?? "");
    if (!m) fail(`expected ${what}`);
    i++;
    return m!;
  };

  const header = (name: string) => hexNum(match(new RegExp(`^-- ${name} ([0-9a-f]{8})$`), `-- ${name}`)[1]);
  const fwType = header("FwType");
  const fwVersion = header("FwVersion");
  const hwType = header("HwType");
  const hwVersion = header("HwVersion");
  const gate = hwType === 0x12;
  for (const l of gate ? ["", "", "-- setVar type support", "_type = {}"] : ["", "--STORAGE", 'STO99999 = OBJECT:new(44, "STO99999")', "", "", "-- setVar type support", "_type = {}"]) expect(l);

  // GATE: constant arguments after the IP (see GATE_HW_TYPE in generator/omLua.ts)
  const self = gate
    ? match(/^(CLU\d+) = GATE:new\(5000, 0x([0-9A-F]{8}), 0x([0-9A-F]{8}), 0x([0-9A-F]{8}), "", ""\)$/, 'this GATE (GATE:new(5000, ip, netmask, gateway, "", ""))')
    : match(/^(CLU\d+) = OBJECT:new\(0, 0x([0-9A-F]{8}), "\1"\)$/, "this CLU (class 0)");
  const id = self[1];
  const ip = hexToIp(self[2]);
  const gateNet = gate ? { netmask: hexToIp(self[3]), gateway: hexToIp(self[4]) } : {};
  const nameLine = match(new RegExp(`^-- NAME_CLU (.+)=${id}$`), "-- NAME_CLU");
  expect("");

  const remotes: Clu["remotes"] = [];
  while (lines[i] !== "") {
    const m = match(/^(CLU\d+) = OBJECT:new\(1, 0x([0-9A-F]{8}), "\1"\)$/, "remote CLU (class 1)");
    remotes.push({ id: m[1], ip: hexToIp(m[2]) });
  }
  // virtual objects block between two blank lines (empty in most files)
  expect("");
  const objects: VirtualObject[] = [];
  while (lines[i] !== "") {
    // constructor = interface className: OBJECT, or GATE (ModbusServer, HttpListener, Timer v2)
    const m = match(/^(-- REMOVED )?([A-Z]{3}\d{4}) = (OBJECT|GATE):new\((\d+), "\2"\)$/, "virtual object line");
    const name = match(new RegExp(`^-- NAME_PERIPHERY (.+)=${m[2]}$`), "-- NAME_PERIPHERY");
    objects.push({ id: m[2], objectClass: Number(m[4]), name: name[1], removed: m[1] ? true : undefined, ...(m[3] !== "OBJECT" ? { className: m[3] } : {}), features: [], events: [] });
  }
  for (const l of ["", "-- MODULES"]) expect(l);

  const modules: ModuleObject[] = [];
  const bySerial = new Map<number, ModuleObject>();
  while (lines[i] !== "") {
    const m = match(/^mm_(\d+) = OBJECT:new\(2, 0x([0-9a-f]{8}), (0x[0-9a-f]+), "\2"\) -- \1 (.+)$/, "module line");
    const serial = Number(m[1]);
    if (serial.toString(16).padStart(8, "0") !== m[2]) fail("module serial and hex serial differ");
    const mod: ModuleObject = { serial, typeLiteral: m[3], commentTail: m[4], ios: [] };
    modules.push(mod);
    bySerial.set(serial, mod);
  }
  for (const l of ["", "-- IO_MODULES"]) expect(l);

  const ios = new Map<string, IoObject>();
  const declOrder: string[] = [];
  while (lines[i] !== "") {
    const m = match(/^(?:(--INACTIVE {2})| )([A-Z]{3}\d{4}) = OBJECT:new\((\d+), mm_(\d+), (\d+), "\2"\)$/, "IO object line");
    const mod = bySerial.get(Number(m[4])) ?? fail(`unknown module mm_${m[4]}`);
    if (ios.has(m[2])) fail(`duplicate object id ${m[2]}`);
    const io: IoObject = { id: m[2], objectClass: Number(m[3]), channel: Number(m[5]), inactive: m[1] ? true : undefined, features: [], events: [] };
    const name = new RegExp(`^-- NAME_IO (.+)=${m[2]}$`).exec(lines[i] ?? "");
    if (name) {
      io.name = name[1];
      i++;
    }
    mod.ios.push(io);
    ios.set(io.id, io);
    declOrder.push(io.id);
  }
  // user variables between two blank lines: `name = "v" -- string` + `_type["name"] = "string"`
  expect("");
  const variables: UserVariable[] = [];
  while (lines[i] !== "") {
    const v = match(/^(\w+) = (.+) -- (string|other|number|boolean)$/, "variable line (name = value -- string|other|number|boolean)");
    match(new RegExp(`^_type\\["${v[1]}"\\] = "${v[3]}"$`), "variable type line");
    const value = parseOmLiteral(v[2]);
    const want = v[3] === "number" ? "number" : v[3] === "boolean" ? "boolean" : "string";
    if (typeof value !== want) fail(`variable ${v[1]}: value does not match its type ${v[3]}`);
    variables.push({ name: v[1], type: v[3] as UserVariable["type"], value: value as string | number | boolean, persist: false });
  }
  expect("");
  for (const l of HELPERS.split("\n")) expect(l);

  const cluEvents: EventBinding[] = [];
  while (lines[i]?.startsWith("function EventsFor_")) {
    const head = match(/^function EventsFor_(\w+?)_(\d+)\(\)$/, "event function");
    const [objId, index] = [head[1], Number(head[2])];
    const actions: string[] = [];
    while (lines[i] !== "end") actions.push(match(/^\t(.+)$/, "tab-indented action line")[1]);
    expect("end");
    expect(`${objId}:add_event(${index}, EventsFor_${objId}_${index})`);
    expect("");
    const ev = { index, actions };
    if (objId === id) cluEvents.push(ev);
    else (ios.get(objId) ?? objects.find((o) => o.id === objId && !o.removed) ?? fail(`event for unknown object ${objId}`)).events.push(ev);
  }

  for (const l of ["", "", "function OnInit()", "", "-- INIT_CLU_OBJECTS"]) expect(l);
  const features: Clu["features"] = [];
  while (lines[i] !== "") {
    const m = match(/^(-- REMOVED )?(\w+):set\((\d+), (.+)$/, "OnInit feature line");
    const value = parseSetValue(m[4]);
    if (value === undefined) {
      i--;
      fail("unsupported value");
    }
    const removed = !!m[1];
    const obj = objects.find((o) => o.id === m[2]);
    if (removed !== !!obj?.removed) {
      i--;
      fail(`-- REMOVED prefix does not match the declaration of ${m[2]}`);
    }
    const entry: Clu["features"][number] = [Number(m[3]), value!];
    if (m[2] === id) features.push(entry);
    else if (obj) obj.features.push(entry);
    else (ios.get(m[2]) ?? (i--, fail(`feature for unknown object ${m[2]}`))).features.push(entry);
  }
  expect("");
  const onInit: string[] = [];
  while (lines[i] !== "end") onInit.push(match(/^\t(.+) -- CluOnInit$/, "CLU OnInit action (\\t<action> -- CluOnInit)")[1]);
  for (const l of ["end", "", `${id}:add_event(0, OnInit)`]) expect(l);
  // variables registered in the storage object, in declaration order (2 volatile, 4 persistent)
  for (const v of variables) {
    const sto = match(new RegExp(`^STO99999:execute\\(([24]), "${v.name}"\\)$`), `STO99999:execute(2|4, "${v.name}")`);
    v.persist = sto[1] === "4";
  }
  if (i !== lines.length) fail("unexpected content after OnInit");

  const moduleOrder = modules.flatMap((m) => m.ios.map((io) => io.id));
  const ioOrder = declOrder.some((x, k) => x !== moduleOrder[k]) ? declOrder : undefined;
  const clu: Clu = {
    name: nameLine[1],
    id,
    ip,
    fwType,
    fwVersion,
    hwType,
    hwVersion,
    remotes,
    features,
    ioOrder,
    ...gateNet,
    events: cluEvents,
    ...(objects.length ? { objects } : {}),
    ...(variables.length ? { variables } : {}),
    ...(onInit.length ? { onInit } : {}),
    modules,
    scripts: [],
  };
  return { clu, eol };
}

function hexToIp(h: string): string {
  return [0, 2, 4, 6].map((k) => hexNum(h.slice(k, k + 2))).join(".");
}
