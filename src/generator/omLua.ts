/**
 * OM.LUA / USER.LUA generator. Output must match what Object Manager writes, byte for byte where
 * known (golden tests in tests/unit/generator.test.ts). Layout reverse-engineered from real OM
 * output; see docs/OM_LUA_FORMAT.md. Pure functions, no vscode imports.
 */
import type { Clu, ScriptParam, FeatureValue, IoObject, RawLua } from "../project/model";

const isRaw = (v: FeatureValue | RawLua): v is RawLua => typeof v === "object" && v !== null;

/** `<id>:set(<index>, <value>)` with a raw value's trailing comment. */
function setLine(id: string, index: number, v: FeatureValue | RawLua): string {
  return isRaw(v) ? `${id}:set(${index}, ${v.lua})${v.comment ? ` -- ${v.comment}` : ""}` : `${id}:set(${index}, ${omLiteral(v)})`;
}

/** IOs with their module serial, in declaration order (clu.ioOrder, else module order). */
export function orderedIos(clu: Clu): Array<{ io: IoObject; moduleSerial: number }> {
  const all = clu.modules.flatMap((m) => m.ios.map((io) => ({ io, moduleSerial: m.serial })));
  if (!clu.ioOrder) return all;
  const byId = new Map(all.map((x) => [x.io.id, x]));
  const ordered = clu.ioOrder.map((id) => byId.get(id) ?? fail(`ioOrder: unknown object ${id}`));
  if (ordered.length !== all.length || new Set(clu.ioOrder).size !== all.length) fail("ioOrder must list every IO exactly once");
  return ordered;
}

function fail(msg: string): never {
  throw new Error(msg);
}

export interface EmitOptions {
  /** OM on Windows writes CRLF; the vCLU fixture is LF. Default CRLF. */
  eol?: "\r\n" | "\n";
}

const hex8 = (n: number): string => (n >>> 0).toString(16).padStart(8, "0");

export function ipToHex(ip: string): string {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`invalid IPv4 address: ${ip}`);
  }
  return "0x" + parts.map((p) => p.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/**
 * A string as OM writes it: verbatim between double quotes, nothing escaped (observed: the
 * HttpListener default `\z` comes out as "\z"). Quotes / line breaks inside are rejected by the
 * resolver (their form is not observed).
 */
export function omString(v: string): string {
  return `"${v}"`;
}

/** A feature / variable value as OM writes it (numbers and booleans as Lua, strings verbatim). */
export function omLiteral(v: FeatureValue): string {
  return typeof v === "string" ? omString(v) : luaLiteral(v);
}

/** A Lua literal with escapes, for our own req: commands (not OM output: see omLiteral). */
export function luaLiteral(v: FeatureValue): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r") + '"';
}

export const HELPERS = `function toboolean(value)
    local valueType = type(value)
    if valueType == "boolean" then
      return value
    elseif valueType == "number" then
      return value ~= 0
    elseif valueType == "string" then
      local numeric = tonumber(value)
      if numeric ~= nil then
         return numeric ~= 0
      elseif value == "false" then
         return false
      end
      return value and true
    elseif valueType == "nil" then
      return false
    end
    return value and true
end

function setVar(name, value)
    t = _type[name]
    if(t == "string") then
        _G[name] = tostring(value)
    elseif(t == "number") then
        _G[name] = tonumber(value)
    elseif(t == "boolean") then
        _G[name] = toboolean(value)
    else
        _G[name] = value
    end
end

function getVar(name)
\treturn _G[name]
end
`;

function ioLines(io: IoObject, moduleSerial: number): string[] {
  const decl = `${io.id} = OBJECT:new(${io.objectClass}, mm_${moduleSerial}, ${io.channel}, "${io.id}")`;
  const lines = [io.inactive ? `--INACTIVE  ${decl}` : ` ${decl}`];
  if (io.name !== undefined) lines.push(`-- NAME_IO ${io.name}=${io.id}`);
  return lines;
}

/** GATE hardware type: OM.LUA without the storage object, own line `GATE:new(...)`. */
export const GATE_HW_TYPE = 0x12;

/**
 * Own line of a GATE (observed, OM 1.13.1, GATE fw types 1 and 2, fw 0x578, two projects):
 * `GATE:new(5000, ip, netmask, gateway, "", "")`; netmask / gateway are the OM project network
 * settings, 5000 and the two empty strings were the same in every sample (meaning unknown).
 */
function gateLine(clu: Clu): string {
  if (!clu.netmask || !clu.gateway) throw new Error(`${clu.name}: a GATE needs netmask and gateway`);
  return `${clu.id} = GATE:new(5000, ${ipToHex(clu.ip)}, ${ipToHex(clu.netmask)}, ${ipToHex(clu.gateway)}, "", "")`;
}

export function emitOmLua(clu: Clu, opts: EmitOptions = {}): string {
  const out: string[] = [];
  const push = (...l: string[]) => out.push(...l);
  const gate = clu.hwType === GATE_HW_TYPE;

  push(
    `-- FwType ${hex8(clu.fwType)}`,
    `-- FwVersion ${hex8(clu.fwVersion)}`,
    `-- HwType ${hex8(clu.hwType)}`,
    `-- HwVersion ${hex8(clu.hwVersion)}`,
    "",
    ...(gate ? [] : ["--STORAGE", 'STO99999 = OBJECT:new(44, "STO99999")', ""]),
    "",
    "-- setVar type support",
    "_type = {}",
    gate ? gateLine(clu) : `${clu.id} = OBJECT:new(0, ${ipToHex(clu.ip)}, "${clu.id}")`,
    `-- NAME_CLU ${clu.name}=${clu.id}`,
    "",
  );
  for (const r of clu.remotes) push(`${r.id} = OBJECT:new(1, ${ipToHex(r.ip)}, "${r.id}")`);
  // virtual objects ("periphery") between two blank lines (empty block = the two blanks of a plain file)
  push("");
  for (const o of clu.objects ?? []) {
    // constructor = the interface className (observed: GATE:new for ModbusServer on a GATE and for
    // HttpListener on a vCLU; OBJECT:new for Timer v1 / Thermostat / Scheduler)
    push(`${o.removed ? "-- REMOVED " : ""}${o.id} = ${o.className ?? "OBJECT"}:new(${o.objectClass}, "${o.id}")`, `-- NAME_PERIPHERY ${o.name}=${o.id}`);
  }
  push("", "-- MODULES");
  for (const m of clu.modules) {
    const sn = hex8(m.serial);
    push(`mm_${m.serial} = OBJECT:new(2, 0x${sn}, ${m.typeLiteral}, "${sn}") -- ${m.serial} ${m.commentTail}`);
  }
  push("", "-- IO_MODULES");
  const ios = orderedIos(clu);
  for (const { io, moduleSerial } of ios) push(...ioLines(io, moduleSerial));
  // user variables between two blank lines (none: the two blanks of a plain file)
  push("");
  for (const v of clu.variables ?? []) push(`${v.name} = ${typeof v.value === "string" ? omString(v.value) : String(v.value)} -- ${v.type}`, `_type["${v.name}"] = "${v.type}"`);
  push("");
  push(...HELPERS.split("\n")); // ends with "" -> blank line after getVar

  // The CLU's own events come first (observed in real-x: event 13 before any IO event).
  for (const ev of clu.events) {
    const fn = `EventsFor_${clu.id}_${ev.index}`;
    push(`function ${fn}()`, ...ev.actions.map((a) => `\t${a}`), "end", `${clu.id}:add_event(${ev.index}, ${fn})`, "");
  }
  for (const { io } of ios) {
    if (io.inactive) continue; // TODO: confirm OM drops events of inactive objects
    for (const ev of io.events) {
      const fn = `EventsFor_${io.id}_${ev.index}`;
      push(`function ${fn}()`, ...ev.actions.map((a) => `\t${a}`), "end", `${io.id}:add_event(${ev.index}, ${fn})`, "");
    }
  }

  // virtual objects' events after the IO events (observed: TIM after PAN)
  for (const o of clu.objects ?? []) {
    if (o.removed) continue;
    for (const ev of o.events) {
      const fn = `EventsFor_${o.id}_${ev.index}`;
      push(`function ${fn}()`, ...ev.actions.map((a) => `\t${a}`), "end", `${o.id}:add_event(${ev.index}, ${fn})`, "");
    }
  }

  push("", "", "function OnInit()", "", "-- INIT_CLU_OBJECTS");
  for (const [idx, v] of clu.features) push(setLine(clu.id, idx, v));
  for (const { io } of ios) {
    if (io.inactive) continue;
    for (const [idx, v] of io.features) push(setLine(io.id, idx, v));
  }
  for (const o of clu.objects ?? []) for (const [idx, v] of o.features) push(`${o.removed ? "-- REMOVED " : ""}${setLine(o.id, idx, v)}`);
  push("", ...(clu.onInit ?? []).map((a) => `\t${a} -- CluOnInit`), "end", "", `${clu.id}:add_event(0, OnInit)`);
  // variables are registered in the storage object: 2 = volatile, 4 = persistent
  for (const v of clu.variables ?? []) push(`STO99999:execute(${v.persist ? 4 : 2}, "${v.name}")`);
  push("");

  return out.join(opts.eol ?? "\r\n");
}

/** `--ARG` value / init literal of a script parameter default. */
function paramLiteral(p: ScriptParam): string {
  return p.type === "string" ? omString(String(p.default)) : String(p.default);
}

/**
 * USER.LUA (observed OM 1.13, three scripts with and without parameters): each script is
 * "\n\nfunction name(a,b)\n\n--ARG ...\n--BEGIN_INIT\n<nil defaults>\n--END_INIT\n\n<body>\n\nend\n\n\n\n\n",
 * concatenated. Body lines: leading and trailing whitespace dropped, one tab added (blank ones too).
 */
export function emitUserLua(clu: Clu, opts: EmitOptions = {}): string {
  if (clu.scripts.length === 0) return ""; // OM writes an empty USER.LUA (real modbus: 0 bytes)
  const out: string[] = [];
  for (const s of clu.scripts) {
    const body = s.source.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n").map((l) => `\t${l.replace(/^[ \t]+|[ \t]+$/g, "")}`);
    const args = s.params.map((p) => `--ARG ${p.name}=${paramLiteral(p)}${p.range ? ` {${p.range[0]}-${p.range[1]}}` : ""}`);
    // the trailing space after "then" is in OM's output
    const init = s.params.flatMap((p) => [`\tif ${p.name} == nil then `, `\t\t${p.name} = ${paramLiteral(p)}`, "\tend"]);
    out.push("", "", `function ${s.name}(${s.params.map((p) => p.name).join(",")})`, "", ...args, "--BEGIN_INIT", ...init, "--END_INIT", "", ...body, "", "end", "", "", "", "");
  }
  out.push("");
  return out.join(opts.eol ?? "\r\n");
}
