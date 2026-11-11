import { readFileSync } from "node:fs";
import * as path from "node:path";
import { indexIos, ioKey, parseOmObjects } from "../../src/project/omLuaObjects";

const fixture = (name: string) => readFileSync(path.join(__dirname, "..", "fixtures", name), "latin1");

describe("parseOmObjects", () => {
  it("reads every IO of the real clu2 OM.LUA (CRLF), incl. --INACTIVE and NAME_IO", () => {
    const o = parseOmObjects(fixture("real-clu2.OM.LUA"));
    expect(o.cluId).toBe("CLU900000001");
    expect(o.ios).toHaveLength(182);
    expect(o.ios.filter((i) => i.inactive)).toHaveLength(2);
    expect(o.ios.filter((i) => i.name)).toHaveLength(182);
    // channel is per object type within a module (two AnalogOUT/AnalogIN classes share channels)
    const analog = o.ios.filter((i) => i.moduleSerial === 520093698);
    expect(analog.filter((i) => i.objectClass === 13).map((i) => i.channel)).toEqual([0, 1, 2, 3]);
    expect(analog.filter((i) => i.objectClass === 12).map((i) => i.channel)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(indexIos(o).size).toBe(182); // (module, class, channel) is unique
  });

  it("handles the LF vCLU file (no modules) and the synthetic sample", () => {
    expect(parseOmObjects(fixture("vclu.OM.LUA"))).toEqual({ cluId: "CLU1", ios: [] });
    const s = parseOmObjects(fixture("om.synthetic.lua"));
    expect(s.cluId).toBe("CLU100000001");
    expect(s.ios.length).toBeGreaterThan(0);
  });

  it("matches NAME_IO only to the object right above it", () => {
    const o = parseOmObjects(' DIM0001 = OBJECT:new(5, mm_1, 0, "DIM0001")\n\n-- NAME_IO X=DIM0001\n DIM0002 = OBJECT:new(5, mm_1, 1, "DIM0002")\n-- NAME_IO LAMP=DIM0002\n');
    expect(o.ios.map((i) => i.name)).toEqual([undefined, "LAMP"]);
    expect(indexIos(o).get(ioKey(1, 5, 1))?.id).toBe("DIM0002");
  });
});
