import { describe, expect, it } from "vitest";
import type { ModuleView } from "../../src/device/cluConfig";
import { syncModulesInCluYaml } from "../../src/project/syncModules";

const header = `clu:
  name: CLU_1
  serial: 1821775752
  ip: 192.168.0.221
  hw: { type: 19, version: 1 }
  fw: { type: 3, version: 515 }
`;
const din8 = (serial: number, ids: string[]) =>
  `  - serial: ${serial}
    type: "0x1e"
    comment: 02 02
    ios:
${ids.map((id, i) => `      - id: ${id}\n        class: 4\n        channel: ${i}\n`).join("")}`;
const zwave = `  - serial: 77
    type: "0x8500030011"
    comment: 00 01
    ios: []
`;
const reported = (serial: number, bus: "tfbus" | "zwave" = "tfbus"): ModuleView =>
  ({
    serial,
    bus,
    name: "IO_MODULE_DIN_8",
    known: true,
    hwType: 0x1e,
    fwType: 2,
    fwApiVer: 2,
    status: "OK",
    ios: [
      { label: "DOUT_01", defaultName: "", objectName: "DOUT", objectClass: 4, channel: 0, features: [], methods: [] },
      { label: "DIN_01", defaultName: "", objectName: "DIN", objectClass: 3, channel: 0, features: [], methods: [] },
    ],
  }) as ModuleView;
const seq = (...xs: number[]) => {
  let i = 0;
  return () => xs[i++ % xs.length];
};

describe("syncModulesInCluYaml", () => {
  it("drops TF-Bus modules the CLU no longer reports, appends the new ones, keeps the rest", () => {
    const text = `${header}modules:\n${din8(2093736214, ["DOU9340", "DOU7792"])}${din8(815720829, ["DOU0001"])}${zwave}scripts:\n  - name: aaa\n`;
    const r = syncModulesInCluYaml(text, { modules: [reported(815720829), reported(1906342442)] }, new Set(["DOU0001"]), seq(0.1234, 0.5678));
    expect(r.removed).toEqual([2093736214]);
    expect(r.removedIds).toEqual(["DOU9340", "DOU7792"]);
    expect(r.added).toEqual([1906342442]);
    expect(r.text).toBe(
      `${header}modules:\n${din8(815720829, ["DOU0001"])}${zwave}` +
        `  - serial: 1906342442\n    type: "0x1e"\n    comment: 02 02\n    ios:\n` +
        `      - id: DOU1234\n        class: 4\n        channel: 0\n      - id: DIN5678\n        class: 3\n        channel: 0\n` +
        `scripts:\n  - name: aaa\n`,
    );
  });

  it("nothing on the bus: every TF-Bus module goes, the list too", () => {
    const r = syncModulesInCluYaml(`${header}modules:\n${din8(1, ["DOU1"])}${din8(2, ["DOU2"])}`, { modules: [] }, new Set());
    expect(r.removed).toEqual([1, 2]);
    expect(r.text).toBe(header);
  });

  it("in sync: text unchanged", () => {
    const text = `${header}modules:\n${din8(5, ["DOU1"])}`;
    const r = syncModulesInCluYaml(text, { modules: [reported(5)] }, new Set());
    expect(r).toMatchObject({ text, added: [], removed: [] });
  });

  it("no modules: list yet: created for the reported ones", () => {
    const r = syncModulesInCluYaml(header, { modules: [reported(9)] }, new Set(), seq(0.1, 0.2));
    expect(r.added).toEqual([9]);
    expect(r.text).toContain("modules:\n  - serial: 9\n");
  });
});
