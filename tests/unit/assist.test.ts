import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { copyInterfaces } from "../../scripts/copy-interfaces.mjs";
import { loadInterfaceRegistry } from "../../src/interfaces/registry";
import { actionItems, arrowMemberItems, arrowObjectItems, buildIndex, keyItems, luaContext, luaHints, luaIndexItems, luaObjectItems, yamlPathAt, type ProjectIndex } from "../../src/project/assist";
import { parseOmLua } from "../../src/project/omLuaParse";

let dir: string;
let index: ProjectIndex;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "og-assist-"));
  copyInterfaces(path.join(__dirname, "../../lib/opengr8on-node/docs/device-interfaces"), dir);
  const { clu } = parseOmLua(readFileSync(path.join(__dirname, "../fixtures/real-clu2.OM.LUA"), "latin1"));
  clu.scripts = [{ name: "ELO", params: [], source: "" }];
  index = buildIndex([clu], loadInterfaceRegistry(dir));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const clu2 = () => index.get("CLU_2")!;

describe("Lua assistance", () => {
  it("detects the completion context", () => {
    expect(luaContext("  local v = DIM1186:get(")).toEqual({ kind: "index", objectId: "DIM1186", op: "get" });
    expect(luaContext("x = LAMP")).toEqual({ kind: "object", word: "LAMP" });
  });

  it("completes OM notation: CLU-> objects by friendly name first, then members", () => {
    expect(luaContext("print(CLU_2->IO_D")).toEqual({ kind: "arrowObject", clu: "CLU_2", word: "IO_D" });
    expect(luaContext("  CLU_2->IO_DIM1186->Sw")).toEqual({ kind: "arrowMember", clu: "CLU_2", object: "IO_DIM1186", word: "Sw" });
    const objs = arrowObjectItems(index, "CLU_2");
    const dim = objs.filter((i) => i.insert === "IO_DIM1186" || i.insert === "DIM1186");
    expect(dim.map((i) => [i.label, i.sort[0]])).toEqual([["IO_DIM1186", "0"], ["DIM1186", "3"]]);
    expect(arrowObjectItems(index, "CLU900000001").length).toBe(objs.length); // by id too
    const members = arrowMemberItems(clu2().byId.get("DIM1186")!);
    expect(members.find((i) => i.label === "Value")).toMatchObject({ insert: "Value", kind: "feature" });
    expect(members.find((i) => i.label === "SwitchOn")?.insert).toMatch(/^SwitchOn\(\$\{1:\w+\}, \$\{2:\w+\}\)$/);
    // set-methods with an enum parameter offer the names as a choice
    const but = arrowMemberItems(clu2().byId.get("BUT3153")!);
    expect(but.find((i) => i.label === "SetMode")?.insert).toMatch(/^SetMode\(\$\{1\|[A-Za-z]+(,[A-Za-z]+)+\|\}\)$/);
  });

  it("offers objects by friendly name, inserting the id, IOs first", () => {
    const items = luaObjectItems(clu2());
    const dim = items.find((i) => i.insert === "DIM1186")!;
    expect(dim).toMatchObject({ label: "IO_DIM1186", kind: "object", filter: "IO_DIM1186 DIM1186" });
    expect(dim.sort < items.find((i) => i.kind === "clu")!.sort).toBe(true);
    expect(items.find((i) => i.insert === "CLU900000001")).toMatchObject({ label: "CLU_2", kind: "clu" });
  });

  it("offers indexes by feature / method name", () => {
    const dim = clu2().byId.get("DIM1186")!;
    expect(luaIndexItems(dim, "get").find((i) => i.label === "Value")).toMatchObject({ insert: "0" });
    expect(luaIndexItems(dim, "set").find((i) => i.label === "Value")).toMatchObject({ insert: "0, ${1:value}", snippet: true });
    expect(luaIndexItems(dim, "execute").find((i) => i.label === "SwitchOn")?.insert).toMatch(/^\d+, \$\{1:\w+\}, \$\{2:\w+\}$/);
  });

  it("shows friendly names and member names as hints, not inside strings or comments", () => {
    const src = 'local v = DIM1186:get(0)\nDIM1186:execute(2, 0) -- DIM1186\nprint("DIM1186")';
    expect(luaHints(src, clu2()).map((h) => [src.slice(0, h.offset).split("\n").pop(), h.label])).toEqual([
      ["local v = DIM1186", "IO_DIM1186"],
      ["local v = DIM1186:get(0", "Value"],
      ["DIM1186", "IO_DIM1186"],
      ["DIM1186:execute(2", expect.any(String)],
    ]);
  });
});

describe("YAML assistance", () => {
  it("completes OM actions: CLU, object (friendly first), method", () => {
    expect(actionItems(index, "CL").items.map((i) => i.insert)).toEqual(["CLU_2->"]);
    const objs = actionItems(index, "CLU_2->IO_D");
    expect(objs.replaceLength).toBe(4);
    const dim = objs.items.filter((i) => i.insert.startsWith("IO_DIM1186") || i.insert.startsWith("DIM1186"));
    expect(dim.map((i) => [i.label, i.sort[0]])).toEqual([["IO_DIM1186", "0"], ["DIM1186", "2"]]);
    expect(objs.items.find((i) => i.kind === "script")).toMatchObject({ label: "ELO", insert: "ELO()" });
    const meths = actionItems(index, "CLU_2->IO_DIM1186->Sw").items.map((i) => i.label);
    expect(meths).toEqual(expect.arrayContaining(["Switch", "SwitchOn", "SwitchOff"]));
    expect(actionItems(index, "CLU_9->").items).toEqual([]);
  });

  it("completes feature and event keys of the enclosing IO", () => {
    const yaml = 'clu:\n  name: CLU_2\nmodules:\n  - serial: 520093697\n    type: "0x1a"\n    comment: "02 02"\n    ios:\n      - id: DIM1186\n        class: 5\n        channel: 0\n        features:\n          Ra: 1\n';
    const at = yaml.indexOf("Ra:");
    const p = yamlPathAt(yaml, at);
    expect(p).toEqual(["modules", 0, "ios", 0, "features", "Ra"]);
    expect(keyItems(clu2(), yaml, p).map((i) => i.label)).toEqual(expect.arrayContaining(["RampTime", "MinValue"]));
    expect(keyItems(clu2(), yaml, ["clu", "events", "x"]).length).toBeGreaterThan(0);
    expect(keyItems(clu2(), yaml, ["clu", "name"])).toEqual([]);
  });
});

describe("virtual objects in the editor (real-117)", () => {
  it("are completion targets with their interface", () => {
    const { clu } = parseOmLua(readFileSync(path.join(__dirname, "../fixtures/real-117.OM.LUA"), "latin1"));
    const idx = buildIndex([clu], loadInterfaceRegistry(dir));
    const t = idx.get(clu.name)!.byName.get("t")!;
    expect(t).toMatchObject({ id: "TIM8908", typeName: "Timer" });
    // removed: not offered as a target, but its YAML features still complete
    expect(idx.get(clu.name)!.objects.some((o) => o.id === "THE2961")).toBe(false);
    expect(idx.get(clu.name)!.byId.get("THE2961")?.typeName).toBe("Thermostat");
    expect(luaIndexItems(t, "execute").map((i) => i.label)).toEqual(expect.arrayContaining(["Start", "Stop"]));
  });
});
