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
});

describe("cluOfScript", () => {
  it("takes the CLU from scripts/<CLU>/<file>.lua", () => {
    expect(cluOfScript("scripts/CLU_2/ELO.lua")).toBe("CLU_2");
    expect(cluOfScript("scripts\\CLU_2\\ELO.lua")).toBe("CLU_2");
    expect(cluOfScript("scripts/ELO.lua")).toBeUndefined();
    expect(cluOfScript("other/CLU_2/ELO.lua")).toBeUndefined();
  });
});
