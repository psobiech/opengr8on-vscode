import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFiles, cluOfScript, encodeOmFile } from "../../src/views/projectCommands";

describe("encodeOmFile", () => {
  it("writes UTF-8 like Object Manager (Polish characters, observed on a CLU)", () => {
    expect(encodeOmFile("-- a\r\n")).toEqual(Buffer.from("-- a\r\n"));
    // bytes of OM 1.13.1's USER.LUA for "-- zażółć gęślą jaźń"
    const bytes = [...encodeOmFile("zażółć gęślą jaźń")];
    expect(bytes.slice(2, 6)).toEqual([0xc5, 0xbc, 0xc3, 0xb3]); // "żó" as in the CLU's USER.LUA
    expect(encodeOmFile("zażółć gęślą jaźń")).toEqual(Buffer.from("zażółć gęślą jaźń", "utf8"));
  });
});

describe("buildFiles", () => {
  it("uses the configured line endings", () => {
    const clu = { name: "X", id: "CLU1", ip: "10.0.0.1", fwType: 3, fwVersion: 1, hwType: 1, hwVersion: 1, remotes: [], features: [], events: [], modules: [], scripts: [{ name: "f", params: [], source: "print(1)\n" }] };
    expect(buildFiles(clu, "\n").om.includes(Buffer.from("\r\n"))).toBe(false);
    expect(buildFiles(clu).om.includes(Buffer.from("\r\n"))).toBe(true);
    expect(buildFiles(clu, "\n").user.toString()).toContain("\tprint(1)\n");
  });

  it("builds MAIN.LUA like Object Manager: loads user + om, checkAlive = serial hex, Init + Loop", () => {
    const clu = { name: "X", id: "CLU1114403717", ip: "10.0.0.1", fwType: 3, fwVersion: 1, hwType: 1, hwVersion: 1, remotes: [], features: [], events: [], modules: [], scripts: [] };
    const main = buildFiles(clu, "\n").main.toString();
    expect(main.indexOf('require "user"')).toBeLessThan(main.indexOf('require "om"'));
    expect(main).toContain('function checkAlive()\n\treturn "426c7385"\nend');
    expect(main.indexOf('require "om"')).toBeLessThan(main.indexOf("SYSTEM.Init()"));
    expect(main).toContain("repeat\n\tSYSTEM.Loop()\nuntil 1==2\n");
    expect(buildFiles(clu).main.includes(Buffer.from("\r\n"))).toBe(true);
    // no serial in the id: the CLU's own checkAlive() stays
    expect(buildFiles({ ...clu, id: "X" }, "\n").main.toString()).not.toContain("checkAlive");
  });

  it("builds a GATE's MAIN.LUA byte for byte like the real GATE (no loop, checkAlive prints)", () => {
    const gate = { name: "ALARM", id: "CLU511002130", ip: "10.0.0.4", netmask: "255.255.255.0", gateway: "10.0.0.1", fwType: 2, fwVersion: 0x456, hwType: 0x12, hwVersion: 2, remotes: [], features: [], events: [], modules: [], scripts: [] };
    const real = readFileSync(join(__dirname, "../fixtures/real-gate.MAIN.LUA"));
    expect(buildFiles(gate, "\n").main).toEqual(real);
    expect(buildFiles(gate).main.toString()).toBe(real.toString().replace(/\n/g, "\r\n"));
  });
});

describe("cluOfScript", () => {
  it("takes the CLU from scripts/<CLU>/<file>.lua", () => {
    expect(cluOfScript("scripts/CLU_2/ELO.lua")).toBe("CLU_2");
    expect(cluOfScript("scripts\\CLU_2\\ELO.lua")).toBe("CLU_2");
    expect(cluOfScript("scripts/ELO.lua")).toBeUndefined();
    expect(cluOfScript("other/CLU_2/ELO.lua")).toBeUndefined();
  });
});
