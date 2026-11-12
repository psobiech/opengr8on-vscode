import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { loadInterfaceRegistry } from "../../src/interfaces/registry";
import { loadProject } from "../../src/project/load";
import { resolveProject } from "../../src/project/resolve";
import { projectCluView } from "../../src/device/projectView";
import { ioReads } from "../../src/views/devicesTree";

it("Devices view content of a project CLU comes from the project (docs/demo PARTER)", async () => {
  const root = path.join(__dirname, "../../docs/demo");
  const { project } = await loadProject({
    read: async (p) => { try { return readFileSync(path.join(root, p), "utf8"); } catch { return undefined; } },
    list: async (d) => { try { return readdirSync(path.join(root, d)); } catch { return []; } },
  });
  const registry = loadInterfaceRegistry(path.join(__dirname, "../../dist/interfaces"));
  const parter = resolveProject(project!, registry).clus.find((c) => c.name === "PARTER")!;
  const v = projectCluView(parter, registry);
  expect(v.modules.map((m) => [m.kind ?? "module", m.name, m.ios.length])[0]).toEqual(["clu", "PARTER itself", 1]);
  expect(v.modules.at(-1)).toMatchObject({ kind: "virtual", name: "Virtual objects" });
  const self = v.modules[0].ios[0];
  expect(self.objectId).toBe("CLU100000101");
  expect(ioReads(self).length).toBeGreaterThan(3); // Uptime, Date, ... polled with req:
  const lamp = v.modules.flatMap((m) => m.ios).find((io) => io.name === "LAMPA_SALON")!;
  expect([lamp.objectId, lamp.objectName, lamp.channel]).toEqual(["DOU1001", "DOUT", 0]);
  expect(ioReads(lamp).map((r) => r.id)).toContain("DOU1001");
  const timer = v.modules.at(-1)!.ios[0];
  expect([timer.objectId, timer.objectName, timer.name]).toEqual(["TIM1001", "Timer", "TIMER_ROLETY"]);
  // CLU Timer is v1 (has Value = time left); the GATE Timer v2 has no Value
  expect(timer.features.map((f) => f.name)).toContain("Value");
  const noVersion = { ...parter, objects: parter.objects!.map((o) => ({ ...o, version: undefined })) };
  expect(projectCluView(noVersion, registry).modules.at(-1)!.ios[0].features.map((f) => f.name)).toContain("Value");
});
