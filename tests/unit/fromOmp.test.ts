import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OmpClu, OmpPeriphery, OmpProject } from "opengr8on-node/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyInterfaces } from "../../scripts/copy-interfaces.mjs";
import { importOmp } from "../../src/project/fromOmp";
import { loadInterfaceRegistry } from "../../src/interfaces/registry";

let dir: string;
let registry: ReturnType<typeof loadInterfaceRegistry>;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "og-fromomp-"));
  copyInterfaces(path.join(__dirname, "../../lib/opengr8on-node/docs/device-interfaces"), dir);
  registry = loadInterfaceRegistry(dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const timer = (name: string, id: string, isRemoved: string): OmpPeriphery => ({ name, nameOnCLU: id, typeName: "Timer", typeId: "6", typeVersion: "1", isRemoved, features: [], events: [] });
const clu = (name: string, serial: string, ip: string, extra: Partial<OmpClu> = {}): OmpClu => ({
  name,
  nameOnCLU: `CLU${parseInt(serial, 16)}`,
  serialNumber: serial,
  ipAddress: ip,
  hardwareType: "00000013",
  hardwareVersion: "00000001",
  firmwareType: "00000003",
  firmwareVersion: "00000203",
  features: [],
  events: [],
  modules: [],
  ios: [],
  periphery: [],
  scripts: [],
  ...extra,
});
const project: OmpProject = {
  name: "Test",
  network: { gateway: "10.0.0.1", netmask: "255.255.255.0" },
  clus: [
    clu("PARTER", "5f5e10b", "10.0.0.11", { periphery: [timer("TIMER_OK", "TIM0001", "false"), timer("TIMER_OLD", "TIM0002", "true")] }),
    clu("STARY", "5f5e10c", "10.0.0.12", { isRemoved: "true" }),
  ],
};

describe("importOmp: deleted things in Object Manager", () => {
  it("leaves out CLUs in the OM trash and removed virtual objects, with a note each", () => {
    const r = importOmp(project, registry);
    expect([...r.files.keys()].filter((f) => f.startsWith("clus/"))).toEqual(["clus/PARTER.yaml"]);
    const yaml = r.files.get("clus/PARTER.yaml")!;
    expect(yaml).toContain("TIMER_OK");
    expect(yaml).not.toContain("TIMER_OLD");
    expect(yaml).not.toContain("10.0.0.12"); // not even as a remote
    expect(r.notes).toEqual(["STARY: in the Object Manager trash — not imported", "PARTER: 1 removed virtual object(s) not imported"]);
  });

  it("omExact keeps both, as OM still writes them", () => {
    const r = importOmp(project, registry, { omExact: true });
    expect([...r.files.keys()].filter((f) => f.startsWith("clus/")).sort()).toEqual(["clus/PARTER.yaml", "clus/STARY.yaml"]);
    expect(r.files.get("clus/PARTER.yaml")).toContain("TIMER_OLD");
  });
});
