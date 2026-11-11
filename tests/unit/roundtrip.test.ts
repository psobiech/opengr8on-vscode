import { readFileSync } from "node:fs";
import * as path from "node:path";
import { emitOmLua } from "../../src/generator/omLua";
import { OmLuaParseError, parseLuaLiteral, parseOmLua } from "../../src/project/omLuaParse";

const fixture = (name: string) => readFileSync(path.join(__dirname, "..", "fixtures", name), "latin1");

// Byte-exact round trip on real (sanitized) OM output: every construct OM wrote must be modelled
// and re-emitted identically.
describe.each(["real-clu2.OM.LUA", "real-x.OM.LUA", "real-modbus.OM.LUA", "vclu.OM.LUA", "real-117.OM.LUA", "real-gate.OM.LUA"])("round trip %s", (name) => {
  it("emit(parse(x)) === x", () => {
    const text = fixture(name);
    const { clu, eol } = parseOmLua(text);
    expect(emitOmLua(clu, { eol })).toBe(text);
  });
});

describe("parseOmLua", () => {
  it("models the real clu2 file", () => {
    const { clu } = parseOmLua(fixture("real-clu2.OM.LUA"));
    expect(clu).toMatchObject({ id: "CLU900000001", name: "CLU_2", fwType: 3, hwType: 0x13 });
    expect(clu.modules).toHaveLength(26 + 3);
    expect(clu.modules.flatMap((m) => m.ios)).toHaveLength(182);
    expect(clu.events).toEqual([]);
    expect(parseOmLua(fixture("real-x.OM.LUA")).clu.events).toEqual([{ index: 13, actions: ["ELO(nil)"] }]);
  });

  it("rejects unknown constructs with a line number", () => {
    const text = fixture("real-clu2.OM.LUA").replace("_type = {}\r\n", '_type = {}\r\n_type["x"] = "number"\r\n');
    expect(() => parseOmLua(text)).toThrow(OmLuaParseError);
    expect(() => parseOmLua(text)).toThrow(/^OM.LUA line 12: expected this CLU/);
  });

  it("parses Lua literals", () => {
    expect([parseLuaLiteral("0.32"), parseLuaLiteral("-5"), parseLuaLiteral("true"), parseLuaLiteral('"a\\"b\\n"'), parseLuaLiteral("nil")]).toEqual([0.32, -5, true, 'a"b\n', undefined]);
  });
});

describe("virtual objects + CluOnInit (real-117)", () => {
  it("models periphery, removed objects, raw values and CLU OnInit actions", () => {
    const { clu } = parseOmLua(fixture("real-117.OM.LUA"));
    expect(clu.objects?.map((o) => [o.id, o.objectClass, o.name, !!o.removed])).toEqual([
      ["TIM8908", 6, "t", false],
      ["THE2961", 18, "hh", true],
      ["SCH1637", 16, "ss", true],
    ]);
    expect(clu.objects?.[0].features).toEqual([[0, 240], [1, 1]]);
    expect(clu.objects?.[0].events).toEqual([{ index: 0, actions: ["test(nil)"] }]);
    const the = clu.objects![1].features;
    expect(the[0]).toEqual([0, { lua: "{PAN9387,0}" }]);
    expect(the[1][1]).toMatchObject({ comment: expect.stringMatching(/^REMOTE_COMMAND CLU_2->x\d+_AnalogOUT_01->Value CONTROL$/) });
    expect(clu.onInit).toEqual(["TIM8908:execute(0)"]);
  });
});

describe("GATE (real-gate, hw type 0x12)", () => {
  it("has no storage object and its own GATE:new line with the project netmask / gateway", () => {
    const text = fixture("real-gate.OM.LUA");
    expect(text).not.toContain("--STORAGE");
    const { clu } = parseOmLua(text);
    expect([clu.hwType, clu.id, clu.ip, clu.netmask, clu.gateway]).toEqual([0x12, "CLU900000006", "192.168.1.107", "255.255.255.0", "192.168.1.108"]);
    expect(clu.modules).toEqual([]);
    expect(() => emitOmLua({ ...clu, gateway: undefined })).toThrow("needs netmask and gateway");
  });
});
