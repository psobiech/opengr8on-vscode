/**
 * Devices view content of a project CLU / GATE, from the project instead of the CLU's CONFIG.JSON
 * (no TFTP needed; the object ids and names are the ones the project uploads). Live values then only
 * need `req:` reads. Pure.
 */
import type { InterfaceRegistry } from "opengr8on-node/client";
import { english, type Tr } from "../i18n";
import type { Clu } from "../project/model";
import { cluInterface, moduleObjects, objectInterface } from "../project/interfaces";
import type { CluConfigView, IoView, ModuleView } from "./cluConfig";

export function projectCluView(clu: Clu, registry: InterfaceRegistry, tr: Tr = english): CluConfigView {
  const serial = Number(/^CLU(\d+)$/.exec(clu.id)?.[1] ?? 0);
  const cluEntry = registry.getCLU(clu.hwType, clu.hwVersion, clu.fwType, clu.fwVersion);
  const cluIface = cluInterface(registry, clu);
  const self: ModuleView = {
    serial,
    bus: "tfbus",
    kind: "clu",
    name: tr("{0} itself", clu.name),
    known: !!cluIface,
    hwType: clu.hwType,
    fwApiVer: clu.fwVersion,
    status: "",
    ios: [{ label: clu.name, defaultName: clu.name, objectName: cluEntry?.typeName ?? "CLU", objectClass: 0, channel: 0, features: cluIface?.features ?? [], methods: cluIface?.methods ?? [], objectId: clu.id, name: clu.name }],
  };
  const modules: ModuleView[] = clu.modules.map((m) => {
    const objects = moduleObjects(registry, m);
    const [fwType, fwApiVer] = m.commentTail.split(" ").map((x) => parseInt(x, 16));
    const ios: IoView[] = m.ios.map((io) => {
      const o = objects.find((x) => Number(x.class) === io.objectClass);
      const label = `${o?.name ?? `class${io.objectClass}`}_${String(io.channel + 1).padStart(2, "0")}`;
      return {
        label,
        defaultName: `x${m.serial}_${label}`,
        objectName: o?.name ?? String(io.objectClass),
        objectClass: io.objectClass,
        channel: io.channel,
        features: o?.interface?.features ?? [],
        methods: o?.interface?.methods ?? [],
        objectId: io.id,
        name: io.name,
        inactive: io.inactive,
      };
    });
    const known = registry.getModule(parseInt(m.typeLiteral, 16), fwType, fwApiVer);
    return {
      serial: m.serial,
      bus: "tfbus",
      name: known?.name ?? tr("unknown module (type {0})", m.typeLiteral),
      known: !!known,
      hwType: parseInt(m.typeLiteral, 16),
      fwType: Number.isFinite(fwType) ? fwType : undefined,
      fwApiVer: Number.isFinite(fwApiVer) ? fwApiVer : 0,
      status: "",
      ios,
    };
  });
  const virtual = (clu.objects ?? []).filter((o) => !o.removed);
  if (virtual.length) {
    modules.push({
      serial,
      bus: "tfbus",
      kind: "virtual",
      name: tr("Virtual objects"),
      known: true,
      hwType: 0,
      fwApiVer: 0,
      status: "",
      ios: virtual.map((o) => {
        const i = objectInterface(registry, o.objectClass, o.version);
        return { label: o.name, defaultName: o.name, objectName: i?.name ?? String(o.objectClass), objectClass: o.objectClass, channel: 0, features: i?.iface.features ?? [], methods: i?.iface.methods ?? [], objectId: o.id, name: o.name };
      }),
    });
  }
  return {
    serial,
    typeName: cluEntry?.typeName ?? cluEntry?.className,
    hwType: clu.hwType,
    hwVer: clu.hwVersion,
    fwType: clu.fwType,
    fwApiVer: clu.fwVersion,
    fwVer: `0x${clu.fwVersion.toString(16)}`,
    status: "",
    cluFeatures: cluIface?.features ?? [],
    modules: [self, ...modules],
  };
}
