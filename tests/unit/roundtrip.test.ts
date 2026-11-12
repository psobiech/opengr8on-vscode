import { readFileSync } from "node:fs";
import * as path from "node:path";
import { emitOmLua } from "../../src/generator/omLua";
import { OmLuaParseError, parseLuaLiteral, parseOmLua } from "../../src/project/omLuaParse";
import { parseUserLua } from "../../src/project/userLuaParse";
import { emitUserLua } from "../../src/generator/omLua";

const fixture = (name: string) => readFileSync(path.join(__dirname, "..", "fixtures", name), "latin1");

// Byte-exact round trip on real (sanitized) OM output: every construct OM wrote must be modelled
// and re-emitted identically.
describe.each(["real-clu2.OM.LUA", "real-x.OM.LUA", "real-modbus.OM.LUA", "vclu.OM.LUA", "real-117.OM.LUA", "real-gate.OM.LUA", "real-117c.OM.LUA", "real-gate-modbus.OM.LUA", "real-vclu2.OM.LUA"])("round trip %s", (name) => {
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

describe("user variables, several scripts with parameters, GATE objects (real-117c, real-gate-modbus; OM 1.13)", () => {
  it("models variables (persist from STO99999:execute 2/4)", () => {
    const { clu } = parseOmLua(fixture("real-117c.OM.LUA"));
    expect(clu.variables).toEqual([
      { name: "cecha", type: "string", value: "aas", persist: false },
      { name: "cecha_persistent", type: "string", value: "aa", persist: true },
      { name: "cecha_other", type: "other", value: "s", persist: false },
    ]);
  });

  it("USER.LUA: three scripts, parameters with defaults and range, byte for byte", () => {
    const text = fixture("real-117c.USER.LUA");
    const { scripts, eol } = parseUserLua(text);
    expect(scripts.map((s) => [s.name, s.params])).toEqual([
      ["test", []],
      ["nowy_skrypt", [
        { name: "parametr", type: "string", default: "domyslna" },
        { name: "dd", type: "number", default: 1, range: [1, 10] },
        { name: "bbb", type: "boolean", default: true },
      ]],
      ["aaaa", []],
    ]);
    const { clu } = parseOmLua(fixture("real-117c.OM.LUA"));
    expect(emitUserLua({ ...clu, scripts }, { eol })).toBe(text);
  });

  it("GATE: its objects are GATE:new(class, id) with NAME_PERIPHERY and OnInit sets", () => {
    const { clu } = parseOmLua(fixture("real-gate-modbus.OM.LUA"));
    expect(clu.objects?.map((o) => [o.id, o.objectClass, o.name, o.features.length])).toEqual([["MOD8301", 206, "modbserv", 8]]);
  });
});

describe("constructor from the interface className, text verbatim, calls to another CLU (real-vclu2)", () => {
  it("HttpListener on a vCLU is GATE:new; its \\z defaults stay verbatim", () => {
    const { clu } = parseOmLua(fixture("real-vclu2.OM.LUA"));
    const o = clu.objects![0];
    expect([o.id, o.objectClass, o.className]).toEqual(["HTT9478", 120, "GATE"]);
    expect(o.features.find(([i]) => i === 2)?.[1]).toBe("\\z"); // two characters, as stored in the .omp
    // number / boolean variables: unquoted (volatile: STO99999:execute(2, ...))
    expect(clu.variables).toEqual([
      { name: "aas", type: "number", value: 4, persist: false },
      { name: "aaab", type: "boolean", value: false, persist: false },
    ]);
  });

  it("USER.LUA: calls to a script on another CLU, missing arguments padded with nil", () => {
    const text = fixture("real-vclu2.USER.LUA");
    const { scripts, eol } = parseUserLua(text);
    expect(scripts[0].source).toContain('CLU900000006:execute(0, "nowy_skrypt(\\"xxxx2\\", 2, nil)")');
    const { clu } = parseOmLua(fixture("real-vclu2.OM.LUA"));
    expect(emitUserLua({ ...clu, scripts }, { eol })).toBe(text);
  });
});
