import { readFileSync } from "node:fs";
import * as path from "node:path";
import { emitOmLua, emitUserLua, ipToHex, luaLiteral } from "../../src/generator/omLua";
import type { Clu } from "../../src/project/model";

const fixture = (name: string) => readFileSync(path.join(__dirname, "..", "fixtures", name), "utf8");

// Model of opengr8on/runtime/root/a (vCLU sample written by Object Manager, LF line endings).
const vclu: Clu = {
  name: "DEVCLU",
  id: "CLU1",
  ip: "10.0.0.10",
  fwType: 0x03,
  fwVersion: 0x00aa55aa,
  hwType: 0x13,
  hwVersion: 0x01,
  remotes: [
    { id: "CLU100000011", ip: "10.0.0.11" },
    { id: "CLU100000012", ip: "10.0.0.12" },
    { id: "CLU100000013", ip: "10.0.0.13" },
    { id: "CLU100000014", ip: "10.0.0.14" },
    { id: "CLU100000015", ip: "10.0.0.15" },
  ],
  features: [
    [14, 22],
    [20, "ssl://user:pass@localhost:8883"],
    [21, false],
    [23, false],
    [24, "homeassistant"],
  ],
  events: [],
  modules: [],
  scripts: [{ name: "sss", params: [], source: 'print(CLU100000015:execute(0, "CLU100000015:get(0)"))' }],
};

describe("OM.LUA generator", () => {
  it("reproduces the vCLU OM.LUA byte for byte", () => {
    expect(emitOmLua(vclu, { eol: "\n" })).toBe(fixture("vclu.OM.LUA"));
  });

  it("reproduces the vCLU USER.LUA byte for byte", () => {
    expect(emitUserLua(vclu, { eol: "\n" })).toBe(fixture("vclu.USER.LUA"));
  });

  it("emits modules, IOs, events and OnInit in OM layout", () => {
    const clu: Clu = {
      ...vclu,
      remotes: [],
      features: [[18, 1]],
      scripts: [],
      modules: [
        {
          serial: 330000009,
          typeLiteral: "0x1a",
          commentTail: "02 02",
          ios: [
            {
              id: "DIM1186",
              objectClass: 5,
              channel: 0,
              name: "LAMP",
              features: [[3, 0.32], [6, 0]],
              events: [{ index: 0, actions: ["DOU0001:execute(0, 0)"] }],
            },
          ],
        },
      ],
    };
    const lua = emitOmLua(clu, { eol: "\n" });
    expect(lua).toContain('mm_330000009 = OBJECT:new(2, 0x13ab6689, 0x1a, "13ab6689") -- 330000009 02 02\n\n-- IO_MODULES\n');
    expect(lua).toContain(' DIM1186 = OBJECT:new(5, mm_330000009, 0, "DIM1186")\n-- NAME_IO LAMP=DIM1186\n\n\nfunction toboolean');
    expect(lua).toContain("function EventsFor_DIM1186_0()\n\tDOU0001:execute(0, 0)\nend\nDIM1186:add_event(0, EventsFor_DIM1186_0)\n\n\n\nfunction OnInit()");
    expect(lua).toContain("CLU1:set(18, 1)\nDIM1186:set(3, 0.32)\nDIM1186:set(6, 0)\n\nend\n");
  });

  it("formats literals", () => {
    expect(ipToHex("10.0.0.13")).toBe("0x0A00000D");
    expect(luaLiteral('a"b')).toBe('"a\\"b"');
    expect(luaLiteral(0.5)).toBe("0.5");
  });
});
