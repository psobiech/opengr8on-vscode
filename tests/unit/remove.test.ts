import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadInterfaceRegistry } from "../../src/interfaces/registry";
import { removeFromCluYaml, removeRemoteFromCluYaml } from "../../src/project/edit";
import { loadProject, type ProjectSource } from "../../src/project/load";
import { clearedClu, findCluUsages, findUsages, withoutClu } from "../../src/project/remove";
import { buildFiles } from "../../src/views/projectCommands";

const root = path.join(__dirname, "../../docs/demo");
const registry = () => loadInterfaceRegistry(path.join(__dirname, "../../dist/interfaces"));
const files = (overrides: Record<string, string> = {}) => ({
  read: async (p: string) => {
    if (p in overrides) return overrides[p];
    try {
      return readFileSync(path.join(root, p), "utf8");
    } catch {
      return undefined;
    }
  },
  list: async (d: string) => {
    try {
      return readdirSync(path.join(root, d));
    } catch {
      return [];
    }
  },
});
let demo: ProjectSource;
beforeAll(async () => {
  demo = (await loadProject(files())).project!;
});
const where = (u: { file: string; line: number }) => `${u.file}:${u.line + 1}`;

describe("findUsages (docs/demo)", () => {
  it("virtual object: the CLU OnInit action that starts the timer", () => {
    const u = findUsages(demo, registry(), { clu: "PARTER", kind: "object", name: "TIMER_ROLETY" });
    expect(u.map(where)).toEqual(["clus/PARTER.yaml:11"]);
    expect(u[0].text).toContain("TIMER_ROLETY");
  });

  it("script: the timer event that calls it", () => {
    expect(findUsages(demo, registry(), { clu: "PARTER", kind: "script", name: "zamknij_rolety" }).map(where)).toEqual(["clus/PARTER.yaml:83"]);
  });

  it("plain Lua uses of the object id count too (outside comments)", async () => {
    const script = "scripts/PARTER/zamknij_rolety.lua";
    const src = `${readFileSync(path.join(root, script), "utf8")}\nlocal t = TIM1001:get(0) -- TIM1001\n-- TIM1001 only in a comment\n`;
    const p = (await loadProject(files({ [script]: src }))).project!;
    const u = findUsages(p, registry(), { clu: "PARTER", kind: "object", name: "TIMER_ROLETY" });
    expect(u.map(where)).toEqual(["clus/PARTER.yaml:11", `${script}:${src.split("\n").findIndex((l) => l.startsWith("local t")) + 1}`]);
  });

  it("an unused object has no usages", async () => {
    const yaml = readFileSync(path.join(root, "clus/PARTER.yaml"), "utf8").replace("      - PARTER->TIMER_ROLETY->Start()\n", "");
    const p = (await loadProject(files({ "clus/PARTER.yaml": yaml }))).project!;
    expect(findUsages(p, registry(), { clu: "PARTER", kind: "object", name: "TIMER_ROLETY" })).toEqual([]);
  });
});

describe("removeFromCluYaml", () => {
  const yaml = readFileSync(path.join(root, "clus/PARTER.yaml"), "utf8");
  it("drops the object (by name or id) and keeps the rest of the file", () => {
    for (const key of ["TIMER_ROLETY", "TIM1001"]) {
      const out = removeFromCluYaml(yaml, "objects", key);
      expect(out).not.toContain("TIM1001");
      expect(out).not.toMatch(/^objects:/m); // the only one: the list goes too
      expect(out).toContain("scripts:\n  - name: zamknij_rolety");
      expect(out.split("\n").slice(0, 70)).toEqual(yaml.split("\n").slice(0, 70)); // modules untouched
    }
  });
  it("drops the script entry", () => {
    expect(removeFromCluYaml(yaml, "scripts", "zamknij_rolety")).not.toMatch(/^scripts:/m);
  });
  it("unknown entry is an error", () => {
    expect(() => removeFromCluYaml(yaml, "scripts", "nope")).toThrow("nope not found");
  });
});

describe("findCluUsages (docs/demo)", () => {
  it("a CLU used by another CLU's event and script cannot go", () => {
    const u = findCluUsages(demo, registry(), "PIETRO");
    expect(u.map(where)).toEqual(["clus/PARTER.yaml:68", "scripts/PARTER/zamknij_rolety.lua:7"]);
  });

  it("its own files do not count; plain Lua naming its id in other CLUs does", async () => {
    expect(findCluUsages(demo, registry(), "PARTER")).toEqual([]);
    const pietro = demo.clus.find((c) => c.name === "PIETRO")!;
    const script = "scripts/PARTER/zamknij_rolety.lua";
    const src = readFileSync(path.join(root, script), "utf8").replace("print(PIETRO->LAMPA_SYPIALNIA->Value)", `${pietro.id}:execute(0, "x") -- ${pietro.id}`);
    const p = (await loadProject(files({ [script]: src }))).project!;
    expect(findCluUsages(p, registry(), "PIETRO").map(where)).toEqual(["clus/PARTER.yaml:68", `${script}:7`]);
  });

  it("explicit remotes listing it are not usages (Remove drops them)", async () => {
    const yaml = readFileSync(path.join(root, "clus/PARTER.yaml"), "utf8")
      .replace("  name: PARTER\n", "  name: PARTER\n  remotes: [PIETRO]\n")
      .replace("PIETRO->LAMPA_SYPIALNIA->Switch(0, 500)", "PARTER->LAMPA_SALON->Switch(0)");
    const script = "scripts/PARTER/zamknij_rolety.lua";
    const src = readFileSync(path.join(root, script), "utf8").replace("print(PIETRO->LAMPA_SYPIALNIA->Value)", "");
    const p = (await loadProject(files({ "clus/PARTER.yaml": yaml, [script]: src }))).project!;
    expect(p.clus.find((c) => c.name === "PARTER")!.remotes).toHaveLength(1);
    expect(findCluUsages(p, registry(), "PIETRO")).toEqual([]);
    expect(withoutClu(p, "PIETRO").clus.map((c) => [c.name, c.remotes?.length])).toEqual([["PARTER", 0]]);
  });
});

describe("removeRemoteFromCluYaml", () => {
  it("drops the name from clu.remotes, keeps comments; an emptied list stays as [] (no remotes)", () => {
    expect(removeRemoteFromCluYaml("clu:\n  name: A # me\n  remotes:\n    - B\n    - C\nmodules: []\n", "B")).toBe("clu:\n  name: A # me\n  remotes:\n    - C\nmodules: []\n");
    expect(removeRemoteFromCluYaml("clu:\n  name: A\n  remotes: [B]\n", "B")).toBe("clu:\n  name: A\n  remotes: []\n");
    expect(removeRemoteFromCluYaml("clu:\n  name: A\n  remotes:\n    - B\n", "B")).toBe("clu:\n  name: A\n  remotes: []\n");
  });

  it("unchanged when not listed or there is no list", () => {
    const t = "clu:\n  name: A\n  remotes:\n    - { id: CLU1, ip: 10.0.0.1 }\n";
    expect(removeRemoteFromCluYaml(t, "B")).toBe(t);
    expect(removeRemoteFromCluYaml("clu:\n  name: A\n", "B")).toBe("clu:\n  name: A\n");
  });

  it("the edited demo file loads without the remote (real layout)", async () => {
    const yaml = readFileSync(path.join(root, "clus/PARTER.yaml"), "utf8").replace("  name: PARTER\n", "  name: PARTER\n  remotes: [PIETRO]\n");
    const edited = removeRemoteFromCluYaml(yaml, "PIETRO");
    expect(edited).not.toContain("PIETRO]");
    const p = (await loadProject(files({ "clus/PARTER.yaml": edited }))).project!;
    expect(p.clus.find((c) => c.name === "PARTER")!.remotes).toEqual([]);
  });
});

describe("clearedClu (docs/demo)", () => {
  it("keeps the CLU's hardware, drops all logic; generates with no remotes, events, objects or scripts", () => {
    const parter = demo.clus.find((c) => c.name === "PARTER")!;
    const c = clearedClu(demo, registry(), "PARTER");
    expect([c.name, c.id, c.ip]).toEqual(["PARTER", parter.id, parter.ip]);
    expect(c.remotes).toEqual([]);
    expect(c.modules.flatMap((m) => m.ios).length).toBe(parter.modules.flatMap((m) => m.ios).length);
    const { om, user } = buildFiles(c, "\n");
    const text = om.toString("utf8");
    expect(text).not.toContain("TIMER_ROLETY");
    expect(text).not.toMatch(/OBJECT:new\(1,/); // no remote CLUs
    // only OM's fixed OnInit registration, empty
    expect(text.match(/^.*:add_event\(.*$/gm)).toEqual([`${parter.id}:add_event(0, OnInit)`]);
    expect(text).not.toContain("CluOnInit");
    expect(text).toContain("LAMPA_SALON"); // IOs stay declared
    expect(user.toString("utf8")).not.toContain("zamknij_rolety");
  });
});
