import type { InterfaceRegistry, ParsedInterface } from "opengr8on-node/client";
import type { Clu, ModuleObject } from "./model";

/** CLU interface by OM.LUA header fields (FwVersion = fwApiVer). */
export function cluInterface(registry: InterfaceRegistry, clu: Pick<Clu, "hwType" | "hwVersion" | "fwType" | "fwVersion">): ParsedInterface | undefined {
  return registry.getCLU(clu.hwType, clu.hwVersion, clu.fwType, clu.fwVersion)?.interface;
}

/** Module objects by module line fields (typeLiteral = hwType, comment = "fwType fwApiVer" hex). */
export function moduleObjects(registry: InterfaceRegistry, m: Pick<ModuleObject, "typeLiteral" | "commentTail">) {
  const [fwType, fwApiVer] = m.commentTail.split(" ").map((x) => parseInt(x, 16));
  if (!Number.isFinite(fwType) || !Number.isFinite(fwApiVer)) return [];
  return registry.getModule(parseInt(m.typeLiteral, 16), fwType, fwApiVer)?.firmware?.objects ?? [];
}

/** Interface object (name + interface) of an IO class on a module. */
export function ioObject(registry: InterfaceRegistry, m: Pick<ModuleObject, "typeLiteral" | "commentTail">, objectClass: number) {
  return moduleObjects(registry, m).find((o) => Number(o.class) === objectClass);
}

/** Interface of a virtual object by class number (+ version when several exist). */
export function objectInterface(registry: InterfaceRegistry, objectClass: number, version?: number) {
  const cands = registry.allObjects().filter((x) => Number(x.class) === objectClass);
  const pick = version !== undefined ? cands.find((x) => Number(x.version) === version) : cands.length === 1 ? cands[0] : [...cands].sort((a, b) => Number(b.version) - Number(a.version))[0];
  return pick ? { name: pick.name, iface: { features: pick.features, methods: pick.methods, events: pick.events } as ParsedInterface } : undefined;
}

/**
 * Enum features are written by name in YAML (`Mode: Bistable`) when every name of the feature is
 * text (starts with a letter) and unique; numeric-looking names (baud rates `9600`) or duplicates
 * keep raw numbers. Numbers are always accepted.
 */
export function enumByName(f: { enums: Array<{ name: string; value: number }> }): boolean {
  if (!f.enums.length) return false;
  const names = f.enums.map((e) => e.name.trim());
  return names.every((n) => /^[A-Za-z]/.test(n)) && new Set(names).size === names.length;
}

/** Enum value for a YAML value given by name (string, or an unquoted True / False). */
export function enumValueOf(f: { enums: Array<{ name: string; value: number }> }, v: unknown): number | undefined {
  if (!enumByName(f)) return undefined;
  const text = typeof v === "boolean" ? String(v) : typeof v === "string" ? v.trim() : undefined;
  if (text === undefined) return undefined;
  return (f.enums.find((e) => e.name.trim() === text) ?? f.enums.find((e) => e.name.trim().toLowerCase() === text.toLowerCase()))?.value;
}

/** Name to write for a numeric value of an enum feature (undefined: keep the number). */
export function enumNameOf(f: { enums: Array<{ name: string; value: number }> }, v: unknown): string | undefined {
  if (!enumByName(f) || typeof v !== "number") return undefined;
  return f.enums.find((e) => e.value === v)?.name.trim();
}

/**
 * Enum of a method parameter, taken from the feature it sets: a `set`-type method with index i sets
 * feature i (247 such parameters in the interfaces, never in conflict with name matching).
 * Matching by parameter name is not used: for `execute` methods it links unrelated enums
 * (ROLLER_SHUTTER SetRollerBlocked(State) ≠ roller State).
 */
export function paramEnumFeature(
  iface: { features: Array<{ index: number; name: string; enums: Array<{ name: string; value: number }> }> },
  method: { call: string; index: number },
  paramIndex: number,
) {
  if (method.call !== "set" || paramIndex !== 0) return undefined;
  const f = iface.features.find((x) => x.index === method.index);
  return f?.enums.length ? f : undefined;
}

/** A call argument (source text) as written to OM.LUA: an enum name becomes its number. */
export function enumArg(f: { enums: Array<{ name: string; value: number }> }, arg: string): { value: string } | { error: string } {
  const a = arg.trim();
  if (/^-?\d+(\.\d+)?$/.test(a)) {
    return f.enums.some((e) => e.value === Number(a)) ? { value: a } : { error: `must be one of ${f.enums.map((e) => `${e.name.trim()} (${e.value})`).join(", ")}, got ${a}` };
  }
  const name = /^"(.*)"$/.exec(a)?.[1] ?? a;
  const hit = f.enums.find((e) => e.name.trim() === name) ?? f.enums.find((e) => e.name.trim().toLowerCase() === name.toLowerCase());
  if (hit) return { value: String(hit.value) };
  return /^[A-Za-z_]\w*$/.test(a) || /^"/.test(a) ? { error: `must be one of ${f.enums.map((e) => e.name.trim()).join(", ")}, got ${a}` } : { value: a };
}
