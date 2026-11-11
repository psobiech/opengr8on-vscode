import type { InterfaceRegistry, ParsedFeature, ParsedMethod } from "opengr8on-node/client";
import { indexIos, ioKey, type OmObjects } from "../project/omLuaObjects";

/** One IO object of a module, as OM names it by default: x<moduleSerial>_<object>_<nn>. */
export interface IoView {
  /** e.g. AnalogOUT_01 */
  label: string;
  /** OM default IO name, e.g. x330000009_AnalogOUT_01 */
  defaultName: string;
  objectName: string;
  /** object class number (OBJECT:new first argument) */
  objectClass: number;
  /** OBJECT:new channel argument: 0-based index among the module's objects of the same type
   * (observed in real OM output: AnalogOUT 0..3 and AnalogIN 0..6 on one ANALOG_DIN) */
  channel: number;
  /** from the module interface XML */
  features: ParsedFeature[];
  methods: ParsedMethod[];
  /** from the CLU's OM.LUA (attachOmObjects): object id (DIM1186), NAME_IO, --INACTIVE */
  objectId?: string;
  name?: string;
  inactive?: boolean;
}

export interface ModuleView {
  serial: number;
  bus: "tfbus" | "zwave";
  /** pseudo modules of a project view (device/projectView.ts): the CLU itself, its virtual objects */
  kind?: "clu" | "virtual";
  /** interface name (DIMMER_MOSFET_DIN) or a placeholder when unknown */
  name: string;
  known: boolean;
  hwType: number;
  fwType?: number;
  fwApiVer: number;
  fwVer?: string;
  status: string;
  ios: IoView[];
}

export interface CluConfigView {
  serial: number;
  mac?: string;
  /** interface type name (CLU_ZWAVE_2) or undefined when the XML is missing */
  typeName?: string;
  hwType: number;
  hwVer: number;
  fwType: number;
  fwApiVer: number;
  fwVer: string;
  status: string;
  /** CLU object features from its interface XML (e.g. TelnetLogLevel); empty if XML missing */
  cluFeatures: ParsedFeature[];
  modules: ModuleView[];
}

interface RawDevice {
  sn: number;
  hwType: number;
  hwVer?: number;
  fwType?: number;
  fwApiVer: number;
  fwVer?: string;
  status?: string;
}
interface RawConfig extends RawDevice {
  mac?: string;
  hwVer: number;
  fwType: number;
  fwVer: string;
  tfbusDevices?: RawDevice[];
  zwaveDevices?: RawDevice[];
}

const num = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`CONFIG.JSON: ${what} is not a number`);
  return v;
};

/** Parses `a:\CONFIG.JSON` and resolves CLU and module types through the interface XMLs. */
export function parseCluConfig(json: string, registry: InterfaceRegistry): CluConfigView {
  let raw: RawConfig;
  try {
    raw = JSON.parse(json) as RawConfig;
  } catch {
    throw new Error("CONFIG.JSON: not valid JSON");
  }
  const clu = registry.getCLU(num(raw.hwType, "hwType"), num(raw.hwVer, "hwVer"), num(raw.fwType, "fwType"), num(raw.fwApiVer, "fwApiVer"));

  const modules: ModuleView[] = [];
  type Module = ReturnType<InterfaceRegistry["getModule"]>;
  const iosOf = (m: Module, serial: number): IoView[] => {
    const ios: IoView[] = [];
    for (const o of m?.firmware?.objects ?? []) {
      const count = Number(o.count ?? 1) || 1;
      for (let i = 1; i <= count; i++) {
        const label = `${o.name}_${String(i).padStart(2, "0")}`;
        ios.push({
          label,
          defaultName: `x${serial}_${label}`,
          objectName: o.name,
          objectClass: Number(o.class),
          channel: i - 1,
          features: o.interface?.features ?? [],
          methods: o.interface?.methods ?? [],
        });
      }
    }
    return ios;
  };
  for (const d of raw.tfbusDevices ?? []) {
    const m = registry.getModule(num(d.hwType, "tfbusDevices.hwType"), num(d.fwType, "tfbusDevices.fwType"), num(d.fwApiVer, "tfbusDevices.fwApiVer"));
    const serial = num(d.sn, "tfbusDevices.sn");
    const ios = iosOf(m, serial);
    modules.push({
      serial,
      bus: "tfbus",
      name: m?.name ?? `unknown module (hw 0x${d.hwType.toString(16)}, fw 0x${(d.fwType ?? 0).toString(16)} api ${d.fwApiVer})`,
      known: !!m,
      hwType: d.hwType,
      fwType: d.fwType,
      fwApiVer: d.fwApiVer,
      fwVer: d.fwVer,
      status: d.status ?? "",
      ios,
    });
  }
  // Z-Wave devices (observed: { sn, hwType: 0x8500030011, fwApiVer, status }, no fwType): the
  // interface XML (e.g. ZWAVE_FAKRO_ARZ_ZWR) declares fwType 0
  for (const d of raw.zwaveDevices ?? []) {
    const serial = num(d.sn, "zwaveDevices.sn");
    const m = registry.getModule(num(d.hwType, "zwaveDevices.hwType"), d.fwType ?? 0, num(d.fwApiVer, "zwaveDevices.fwApiVer"));
    modules.push({
      serial,
      bus: "zwave",
      name: m?.name ?? `Z-Wave device (type 0x${d.hwType.toString(16)})`,
      known: !!m,
      hwType: d.hwType,
      fwType: d.fwType,
      fwApiVer: d.fwApiVer,
      status: d.status ?? "",
      ios: iosOf(m, serial),
    });
  }

  return {
    serial: num(raw.sn, "sn"),
    mac: raw.mac,
    typeName: clu?.typeName ?? clu?.className,
    hwType: raw.hwType,
    hwVer: raw.hwVer,
    fwType: raw.fwType,
    fwApiVer: raw.fwApiVer,
    fwVer: String(raw.fwVer),
    status: raw.status ?? "",
    cluFeatures: clu?.interface.features ?? [],
    modules,
  };
}

/**
 * Adds OM.LUA object ids / names to the IOs of a CONFIG.JSON view, matched by module serial +
 * object class + channel. Returns how many IOs matched; unmatched IOs are not in the CLU's project.
 */
export function attachOmObjects(view: CluConfigView, objects: OmObjects): number {
  const index = indexIos(objects);
  let matched = 0;
  for (const m of view.modules) {
    for (const io of m.ios) {
      const o = index.get(ioKey(m.serial, io.objectClass, io.channel));
      io.objectId = o?.id;
      io.name = o?.name;
      io.inactive = o?.inactive;
      if (o) matched++;
    }
  }
  return matched;
}
