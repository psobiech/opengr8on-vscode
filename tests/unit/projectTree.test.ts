import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { copyInterfaces } from "../../scripts/copy-interfaces.mjs";
import { loadInterfaceRegistry } from "../../src/interfaces/registry";
import { loadProject } from "../../src/project/load";
import { parseOmLua } from "../../src/project/omLuaParse";
import { resolveProject } from "../../src/project/resolve";
import { cluToYaml } from "../../src/project/toYaml";
import { liveOwner, ProjectTreeProvider } from "../../src/views/projectTree";
import { DevicesTreeProvider } from "../../src/views/devicesTree";
import { projectCluView } from "../../src/device/projectView";

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

      const [cluNode] = await tree.getChildren();
      const groups = (await tree.getChildren(cluNode)).map((n) => tree.getTreeItem(n).label);
      expect(groups).toEqual(["Objects", "Virtual objects", "Scripts"]); // Scripts always, for "New Script"
      const scripts = tree.getTreeItem((await tree.getChildren(cluNode))[2]);
      expect(scripts).toMatchObject({ contextValue: "group.scripts", description: "0" });
      const ios = (await tree.getChildren((await tree.getChildren(cluNode))[0])).map((n) => tree.getTreeItem(n));
      expect(ios.length).toBeGreaterThan(10);
      expect(ios.map((i) => i.label)).toContain("x520093751_PANEL_01"); // OM default name (not in YAML)
      const shown = ios.flatMap((i) => [String(i.label), String(i.description ?? "")]).join(" ");
      expect(shown).not.toMatch(/mm_\d/);
      const objs = (await tree.getChildren((await tree.getChildren(cluNode))[1])).map((n) => tree.getTreeItem(n));
      expect(objs.map((o) => [o.label, o.description])).toEqual([["t", "Timer · 1 event(s)"], ["hh", "Thermostat · removed"], ["ss", "Scheduler · removed"]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("project CLUs show the Devices view's live rows: modules, device details, object values", async () => {
    const root = path.join(__dirname, "../../docs/demo");
    const { project } = await loadProject({
      read: async (p) => { try { return readFileSync(path.join(root, p), "utf8"); } catch { return undefined; } },
      list: async (d) => { try { return readdirSync(path.join(root, d)); } catch { return []; } },
    });
    const registry = loadInterfaceRegistry(path.join(__dirname, "../../dist/interfaces"));
    const resolved = resolveProject(project!, registry).clus;
    const devices = new DevicesTreeProvider(async (serial) => projectCluView(resolved.find((c) => c.id === `CLU${serial}`)!, registry));
    devices.setProject(project!.clus.map((c) => ({ serial: c.serial, ip: c.ip, name: c.name, gate: false })));
    const shown: string[] = [];
    const tree = new ProjectTreeProvider(() => ({ path: "/p" }) as never, { devices, onIoShown: (_serial, owner) => shown.push(owner) });
    tree.update(project, new Map(), resolved);

    const parter = (await tree.getChildren()).find((n) => tree.getTreeItem(n).label === "PARTER")!;
    const groups = await tree.getChildren(parter);
    expect(groups.map((n) => tree.getTreeItem(n).label)).toEqual(["Objects", "Virtual objects", "Scripts", "Modules", "Device"]);
    expect(tree.getTreeItem(parter).contextValue).toBe("projectClu");

    // Modules: the Devices rows, ids prefixed (unique within this view)
    const modules = await tree.getChildren(groups[3]);
    expect(modules.length).toBeGreaterThan(1);
    expect(tree.getTreeItem(modules[0]).id).toMatch(/^project:m:clu:\d+:/);

    // an object row expands into its live values; settable ones keep the Devices context value
    const lamp = (await tree.getChildren(groups[0])).find((n) => tree.getTreeItem(n).label === "LAMPA_SALON")!;
    expect(tree.getTreeItem(lamp).contextValue).toBe("projectIo");
    const values = (await tree.getChildren(lamp)).map((n) => tree.getTreeItem(n));
    expect(values.some((v) => v.contextValue === "feature.set")).toBe(true);
    expect(values[0].id).toMatch(/^project:project:\d+:DOU1001:clu:/);
    expect(shown).toEqual([liveOwner(parter.kind === "projectClu" ? parter.clu.serial : 0, "DOU1001")]);
    expect((await tree.liveIo(lamp))?.io.objectId).toBe("DOU1001");

    const details = (await tree.getChildren(groups[4])).map((n) => tree.getTreeItem(n).label);
    expect(details).toContain("IP");
  });
});
