/**
 * Generator model → project YAML (format 1): used by import (OM.LUA from a CLU, later .omp). Writes
 * names where the interface XML makes them unambiguous, indexes ("18") otherwise; compiled actions
 * become `{ lua: ... }` lines; IO names equal to OM's default are omitted. The result must resolve
 * back to the same model (tests/unit/resolve.test.ts round trip).
 */
import { Document, YAMLMap, YAMLSeq } from "yaml";
import type { InterfaceRegistry, ParsedEvent, ParsedFeature, ParsedInterface } from "opengr8on-node/client";
import type { Clu, EventBinding, FeatureInit } from "./model";
import { defaultIoName } from "./resolve";
import { enumNameOf } from "./interfaces";

const hex = (n: number) => `0x${n.toString(16)}`;

function featureKey(index: number, list: ParsedFeature[] | undefined): string {
  const hits = list?.filter((f) => f.index === index) ?? [];
  const name = hits.length === 1 ? hits[0].name : undefined;
  return name && list!.filter((f) => f.name === name).length === 1 ? name : String(index);
}

function eventKey(index: number, list: ParsedEvent[] | undefined): string {
  const hits = list?.filter((e) => e.address === index) ?? [];
  const name = hits.length === 1 ? hits[0].name : undefined;
  return name && list!.filter((e) => e.name === name).length === 1 ? name : String(index);
}

export interface ToYamlOptions {
  /** Remote CLU ids that are CLU files of the same project (id → CLU name); others stay {id, ip}. */
  projectClus?: Map<string, string>;
  /** "lua" (default): actions are compiled Lua lines → `{ lua: ... }`; "om": OM action strings, written as is. */
  actions?: "lua" | "om";
  /** For "lua": friendly OM form of a compiled line, or undefined to keep `{ lua: ... }`. */
  friendly?: (line: string) => string | undefined;
}

export function cluToYaml(clu: Clu, registry: InterfaceRegistry, opts: ToYamlOptions = {}): string {
  const doc = new Document();
  const cluIface = registry.getCLU(clu.hwType, clu.hwVersion, clu.fwType, clu.fwVersion)?.interface;

  const features = (f: FeatureInit, iface: ParsedInterface | undefined) => {
    const m = new YAMLMap();
    for (const [idx, v] of f) {
      const def = iface?.features.find((x) => x.index === idx);
      // enum features by name (Mode: Bistable), when the key is written by name too
      const key = featureKey(idx, iface?.features);
      const name = def && key === def.name ? enumNameOf(def, v) : undefined;
      m.add(doc.createPair(key, name ?? v));
    }
    return m;
  };
  const events = (list: EventBinding[], iface: ParsedInterface | undefined) => {
    const m = new YAMLMap();
    for (const e of list) m.add(doc.createPair(eventKey(e.index, iface?.events), opts.actions === "om" ? e.actions : e.actions.map((lua) => opts.friendly?.(lua) ?? { lua })));
    return m;
  };
  const flow = <T extends YAMLMap | YAMLSeq>(n: T) => ((n.flow = true), n);

  const cluMap = new YAMLMap();
  cluMap.add(doc.createPair("name", clu.name));
  const serial = /^CLU(\d+)$/.exec(clu.id)?.[1];
  cluMap.add(doc.createPair("serial", serial && serial.length > 2 ? Number(serial) : 0));
  if (!serial || serial.length <= 2) cluMap.add(doc.createPair("id", clu.id));
  cluMap.add(doc.createPair("ip", clu.ip));
  if (clu.netmask) cluMap.add(doc.createPair("netmask", clu.netmask));
  if (clu.gateway) cluMap.add(doc.createPair("gateway", clu.gateway));
  cluMap.add(doc.createPair("hw", flow(doc.createNode({ type: clu.hwType, version: clu.hwVersion }) as YAMLMap)));
  cluMap.add(doc.createPair("fw", flow(doc.createNode({ type: clu.fwType, version: clu.fwVersion }) as YAMLMap)));
  const remotes = new YAMLSeq();
  for (const r of clu.remotes) {
    const name = opts.projectClus?.get(r.id);
    remotes.add(name ?? flow(doc.createNode({ id: r.id, ip: r.ip }) as YAMLMap));
  }
  cluMap.add(doc.createPair("remotes", remotes));
  if (clu.ioOrder) cluMap.add(doc.createPair("ioOrder", flow(doc.createNode(clu.ioOrder) as YAMLSeq)));
  if (clu.features.length) cluMap.add(doc.createPair("features", features(clu.features, cluIface)));
  const cluEvents = clu.onInit?.length ? [{ index: 0, actions: clu.onInit }, ...clu.events] : clu.events;
  if (cluEvents.length) cluMap.add(doc.createPair("events", events(cluEvents, cluIface)));

  const modules = new YAMLSeq();
  for (const m of clu.modules) {
    const [fwType, fwApiVer] = m.commentTail.split(" ").map((x) => parseInt(x, 16));
    const objects = registry.getModule(parseInt(m.typeLiteral, 16), fwType, fwApiVer)?.firmware?.objects ?? [];
    const mm = new YAMLMap();
    mm.add(doc.createPair("serial", m.serial));
    mm.add(doc.createPair("type", m.typeLiteral));
    mm.add(doc.createPair("comment", m.commentTail));
    const ios = new YAMLSeq();
    for (const io of m.ios) {
      const o = objects.find((x) => Number(x.class) === io.objectClass);
      const im = new YAMLMap();
      im.add(doc.createPair("id", io.id));
      im.add(doc.createPair("class", io.objectClass));
      im.add(doc.createPair("channel", io.channel));
      if (io.name !== undefined && !(o && io.name === defaultIoName(m.serial, o.name, io.channel))) im.add(doc.createPair("name", io.name));
      if (io.inactive) im.add(doc.createPair("inactive", true));
      if (io.features.length) im.add(doc.createPair("features", features(io.features, o?.interface)));
      if (io.events.length) im.add(doc.createPair("events", events(io.events, o?.interface)));
      ios.add(im);
    }
    mm.add(doc.createPair("ios", ios));
    modules.add(mm);
  }

  const objects = new YAMLSeq();
  for (const o of clu.objects ?? []) {
    const cands = registry.allObjects().filter((x) => Number(x.class) === o.objectClass);
    const pick = o.version !== undefined ? cands.find((x) => Number(x.version) === o.version) : cands.length === 1 ? cands[0] : undefined;
    const sameName = cands.length > 0 && cands.every((x) => x.name === cands[0].name);
    const om = new YAMLMap();
    om.add(doc.createPair("id", o.id));
    om.add(doc.createPair("class", sameName ? cands[0].name : o.objectClass));
    if (o.version !== undefined && cands.length > 1) om.add(doc.createPair("version", o.version));
    om.add(doc.createPair("name", o.name));
    if (o.removed) om.add(doc.createPair("removed", true));
    const iface = pick ? { features: pick.features, methods: pick.methods, events: pick.events } : undefined;
    if (o.features.length) om.add(doc.createPair("features", features(o.features, iface)));
    if (o.events.length) om.add(doc.createPair("events", events(o.events, iface)));
    objects.add(om);
  }

  const root = new YAMLMap();
  root.add(doc.createPair("clu", cluMap));
  root.add(doc.createPair("modules", modules));
  if (objects.items.length) root.add(doc.createPair("objects", objects));
  if (clu.scripts.length) root.add(doc.createPair("scripts", clu.scripts.map((s) => ({ name: s.name, params: s.params }))));
  doc.contents = root;
  // quote index keys so they stay strings ("18"), and hex-looking strings stay strings
  return doc.toString({ lineWidth: 0, defaultKeyType: "PLAIN" });
}

export { hex };
