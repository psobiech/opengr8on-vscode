import { readFileSync } from "node:fs";
import * as path from "node:path";
import { emitUserLua } from "../../src/generator/omLua";
import type { CluConfigView } from "../../src/device/cluConfig";
import type { Clu } from "../../src/project/model";
import { allocateId, idPrefix, skeletonFromConfig } from "../../src/project/skeleton";
import { parseUserLua } from "../../src/project/userLuaParse";

const fixture = (name: string) => readFileSync(path.join(__dirname, "..", "fixtures", name), "latin1");
const withScripts = (scripts: Clu["scripts"]): Clu => ({ name: "X", id: "CLU1", ip: "10.0.0.1", fwType: 3, fwVersion: 1, hwType: 1, hwVersion: 1, remotes: [], features: [], events: [], modules: [], scripts });

describe("parseUserLua", () => {
  it.each(["vclu.USER.LUA", "real-x.USER.LUA"])("round-trips %s", (name) => {
    const text = fixture(name);
    const { scripts, eol } = parseUserLua(text);
    expect(scripts).toHaveLength(1);
    expect(emitUserLua(withScripts(scripts), { eol })).toBe(text);
  });

  it("rejects the unexplained stub in real-clu2", () => {
    expect(() => parseUserLua(fixture("real-clu2.USER.LUA"))).toThrow(/^USER.LUA line 2: /);
  });

  it("writes an empty USER.LUA without scripts, and drops body indentation like OM", () => {
    expect(emitUserLua(withScripts([]))).toBe("");
    expect(emitUserLua(withScripts([{ name: "f", params: [], source: "if x then   \n    y()\n  \nend\n" }]), { eol: "\n" })).toContain("\tif x then\n\ty()\n\t\n\tend\n");
  });
});

describe("ids", () => {
  it("uses the first 3 letters of the object name", () => {
    expect(["DIMM", "PowerSupplyVoltage", "PANEL_BUTTON", "DOUT", "X1"].map(idPrefix)).toEqual(["DIM", "POW", "PAN", "DOU", "XXX"]);
  });

  it("allocates unique ids", () => {
    const taken = new Set(["DIM0001"]);
    const seq = [0.0001, 0.0001, 0.0002];
    const id = allocateId("DIMM", taken, () => seq.shift()!);
    expect(id).toBe("DIM0002");
    expect(taken.has("DIM0002")).toBe(true);
  });
});

describe("skeletonFromConfig", () => {
  it("builds modules and IOs the way OM writes them", () => {
    const cfg: CluConfigView = {
      serial: 100000013, typeName: "CLU_ZWAVE_2", hwType: 0x13, hwVer: 1, fwType: 3, fwApiVer: 0x203, fwVer: "x", status: "OK", cluFeatures: [],
      modules: [
        { serial: 330000009, bus: "tfbus", name: "DIMMER_MOSFET_DIN", known: true, hwType: 26, fwType: 2, fwApiVer: 2, status: "OK",
          ios: [{ label: "DIMM_01", defaultName: "x330000009_DIMM_01", objectName: "DIMM", objectClass: 5, channel: 0, features: [], methods: [] }] },
        { serial: 3489660929, bus: "zwave", name: "Z-Wave", known: false, hwType: 1, fwApiVer: 1, status: "OK", ios: [] },
      ],
    };
    let n = 0;
    const { clu, skipped } = skeletonFromConfig(cfg, { name: "CLU_2", ip: "10.0.0.13", random: () => (n++ % 10) / 10 });
    expect(clu).toMatchObject({ id: "CLU100000013", hwType: 0x13, hwVersion: 1, fwType: 3, fwVersion: 0x203 });
    expect(clu.modules).toEqual([{ serial: 330000009, typeLiteral: "0x1a", commentTail: "02 02", ios: [{ id: "DIM0000", objectClass: 5, channel: 0, features: [], events: [] }] }]);
    expect(skipped).toEqual(["Z-Wave (serial 3489660929)"]);
  });
});
