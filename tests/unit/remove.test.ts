import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadInterfaceRegistry } from "../../src/interfaces/registry";
import { removeFromCluYaml } from "../../src/project/edit";
import { loadProject, type ProjectSource } from "../../src/project/load";
import { findUsages } from "../../src/project/remove";

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
