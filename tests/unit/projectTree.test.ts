import { readFileSync } from "node:fs";
import * as path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { copyInterfaces } from "../../scripts/copy-interfaces.mjs";
import { loadInterfaceRegistry } from "../../src/interfaces/registry";
import { loadProject } from "../../src/project/load";
import { parseOmLua } from "../../src/project/omLuaParse";
import { resolveProject } from "../../src/project/resolve";
import { cluToYaml } from "../../src/project/toYaml";
import { ProjectTreeProvider } from "../../src/views/projectTree";

describe("ProjectTreeProvider", () => {
  it("lists objects by friendly name (OM defaults included), never mm_<serial>", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "og-pt-"));
    try {
      copyInterfaces(path.join(__dirname, "../../lib/opengr8on-node/docs/device-interfaces"), dir);
      const registry = loadInterfaceRegistry(dir);
      const { clu } = parseOmLua(readFileSync(path.join(__dirname, "../fixtures/real-117.OM.LUA"), "latin1"));
      const files = new Map([["opengr8on.yaml", "format: 1\nname: T\n"], [`clus/${clu.name}.yaml`, cluToYaml(clu, registry)]]);
      const { project } = await loadProject({ read: async (p) => files.get(p), list: async (d) => [...files.keys()].filter((p) => p.startsWith(`${d}/`)).map((p) => p.slice(d.length + 1)) });
      const tree = new ProjectTreeProvider(() => ({ path: "/p" }) as never);
      tree.update(project, new Map(), resolveProject(project!, registry).clus);

      const [cluNode] = tree.getChildren();
      const groups = tree.getChildren(cluNode).map((n) => tree.getTreeItem(n).label);
      expect(groups).toEqual(["Objects", "Virtual objects", "Scripts"]); // Scripts always, for "New Script"
      const scripts = tree.getTreeItem(tree.getChildren(cluNode)[2]);
      expect(scripts).toMatchObject({ contextValue: "group.scripts", description: "0" });
      const ios = tree.getChildren(tree.getChildren(cluNode)[0]).map((n) => tree.getTreeItem(n));
      expect(ios.length).toBeGreaterThan(10);
      expect(ios.map((i) => i.label)).toContain("x520093751_PANEL_01"); // OM default name (not in YAML)
      const shown = ios.flatMap((i) => [String(i.label), String(i.description ?? "")]).join(" ");
      expect(shown).not.toMatch(/mm_\d/);
      const objs = tree.getChildren(tree.getChildren(cluNode)[1]).map((n) => tree.getTreeItem(n));
      expect(objs.map((o) => [o.label, o.description])).toEqual([["t", "Timer · 1 event(s)"], ["hh", "Thermostat · removed"], ["ss", "Scheduler · removed"]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
