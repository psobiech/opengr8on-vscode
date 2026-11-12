import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { copyInterfaces } from "../../scripts/copy-interfaces.mjs";
import { loadInterfaceRegistry } from "../../src/interfaces/registry";
import { luaStubs } from "../../src/lua/stubs";
import { parseOmLua } from "../../src/project/omLuaParse";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "og-stub-"));
  copyInterfaces(path.join(__dirname, "../../lib/opengr8on-node/docs/device-interfaces"), dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("luaStubs", () => {
  it("declares classes with typed overloads and one global per object", () => {
    const { clu } = parseOmLua(readFileSync(path.join(__dirname, "../fixtures/real-clu2.OM.LUA"), "latin1"));
    const { text, conflicts } = luaStubs([clu], loadInterfaceRegistry(dir));
    expect(conflicts).toEqual([]);
    expect(text.startsWith("---@meta opengr8on")).toBe(true);
    expect(text).toContain("---@class DIMM : GrentonObject");
    expect(text).toMatch(/---@overload fun\(self: DIMM, index: 0, value: number\) # Value \[0\]/);
    expect(text).toMatch(/---@overload fun\(self: DIMM, index: \d+, \w+: number, \w+: number\): nil # SwitchOn/);
    expect(text).toContain("---@type DIMM\nDIM1186 = nil");
    expect(text).toContain("---@type RemoteCLU\nCLU900000002 = nil");
    expect(text).toMatch(/---@type CLU_13_203\nCLU900000001 = nil/);
    // every IO of the file is declared exactly once
    const declared = [...text.matchAll(/^([A-Z]{3}\d{4}) = nil$/gm)].map((m) => m[1]);
    expect(new Set(declared).size).toBe(182);
    // Z-Wave objects without an interface XML fall back to the base class
    expect(text).toMatch(/---@type GrentonObject\nZWA1794 = nil/);
  });

  it("OM notation: set-type methods (SetMode) and the CLU's scripts with optional parameters", () => {
    const { clu } = parseOmLua(readFileSync(path.join(__dirname, "../fixtures/real-117c.OM.LUA"), "latin1"));
    clu.scripts = [
      { name: "test", params: [], source: "" },
      { name: "nowy_skrypt", params: [{ name: "parametr", type: "string", default: "domyslna" }, { name: "dd", type: "number", default: 1, range: [1, 10] }, { name: "bbb", type: "boolean", default: true }], source: "" },
    ];
    const { text } = luaStubs([clu], loadInterfaceRegistry(dir));
    expect(text).toMatch(/---@field nowy_skrypt fun\(parametr\?: string, dd\?: number, bbb\?: boolean\) # script on /);
    expect(text).toMatch(/---@field test fun\(\) # script on .*no parameters/);
    // panel buttons: SetMode is a set-type method
    expect(text).toMatch(/---@field SetMode fun\(/);
  });

  it("reports ids used for different classes on different CLUs", () => {
    const reg = loadInterfaceRegistry(dir);
    const base = { ip: "10.0.0.1", fwType: 3, fwVersion: 0x203, hwType: 0x13, hwVersion: 1, remotes: [], features: [], events: [], scripts: [] };
    const mod = (cls: number) => [{ serial: 1, typeLiteral: "0x1a", commentTail: "02 02", ios: [{ id: "XXX0001", objectClass: cls, channel: 0, features: [], events: [] }] }];
    const r = luaStubs([{ ...base, name: "A", id: "CLU1", modules: mod(5) }, { ...base, name: "B", id: "CLU2", modules: mod(99) }], reg);
    expect(r.conflicts).toEqual(["XXX0001"]);
  });
});

import { mergeLuarc } from "../../src/lua/luarc";

describe("mergeLuarc", () => {
  it("creates, merges and leaves alone", () => {
    const fresh = mergeLuarc(undefined);
    expect(fresh.changed).toBe(true);
    expect(JSON.parse(fresh.text)["workspace.library"]).toEqual([".opengr8on/luals"]);
    expect(JSON.parse(fresh.text)["runtime.plugin"]).toBe(".opengr8on/luals/plugin.lua");
    expect(JSON.parse(fresh.text)["workspace.ignoreDir"]).toEqual(["build"]);
    expect(JSON.parse(fresh.text)["diagnostics.ignoredFiles"]).toBe("Disable"); // opened build/OM.LUA too
    // a project configured before this setting existed gets it on the next start
    const old = JSON.stringify({ "workspace.library": [".opengr8on/luals"], "runtime.plugin": "x.lua", "workspace.ignoreDir": ["build"] });
    expect(JSON.parse(mergeLuarc(old).text)["diagnostics.ignoredFiles"]).toBe("Disable");
    expect(mergeLuarc(JSON.stringify({ ...JSON.parse(old), diagnostics: { ignoredFiles: "Opened" } })).changed).toBe(false); // user's choice kept
    expect(JSON.parse(mergeLuarc('{ "workspace.ignoreDir": ["x"] }').text)["workspace.ignoreDir"]).toEqual(["x"]);
    expect(JSON.parse(mergeLuarc('{ "runtime.plugin": "mine.lua" }').text)["runtime.plugin"]).toBe("mine.lua");
    expect(mergeLuarc(fresh.text).changed).toBe(false);
    const merged = JSON.parse(mergeLuarc('{ "workspace.library": ["x"], "runtime.version": "Lua 5.3" }').text);
    expect(merged["runtime.plugin"]).toBe(".opengr8on/luals/plugin.lua");
    expect(merged["workspace.library"]).toEqual(["x", ".opengr8on/luals"]);
    expect(merged["runtime.version"]).toBe("Lua 5.3");
    expect(JSON.parse(mergeLuarc('{ "workspace": { "library": [] } }').text).workspace.library).toEqual([".opengr8on/luals"]);
    expect(() => mergeLuarc("{ // c\n}")).toThrow(/not valid JSON/);
  });
});
