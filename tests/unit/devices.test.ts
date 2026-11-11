import { CLUDevice, CipherType } from "opengr8on-node/client";
import { cluDetails, cluObjectId, mergeDiscovery, mergeProject, reachable, rememberClus, restoreClus, toCluInfo, type CluInfo } from "../../src/device/cluInfo";
import type { CluConfigView } from "../../src/device/cluConfig";
import { DevicesTreeProvider, ioReads } from "../../src/views/devicesTree";

const t0 = new Date("2026-11-11T10:00:00Z");
const clu = (serial: number, address: string, extra: Partial<CluInfo> = {}): CluInfo => ({
  serial, address, mac: null, cipher: "NONE", online: true, lastSeen: t0, ...extra,
});

describe("toCluInfo", () => {
  it("maps a discovered device", () => {
    const d = new CLUDevice({ serialNumber: 100000013, macAddress: "AA:BB:CC:00:11:22", address: "10.0.0.13", cipherType: CipherType.PROJECT });
    expect(toCluInfo(d, t0)).toEqual({ serial: 100000013, address: "10.0.0.13", mac: "aa:bb:cc:00:11:22", cipher: "PROJECT", online: true, lastSeen: t0 });
  });

  it("skips devices without a serial", () => {
    expect(toCluInfo(new CLUDevice({ address: "10.0.0.1" }))).toBeNull();
  });
});

describe("mergeDiscovery", () => {
  it("sorts by serial, updates found CLUs and keeps missing ones offline", () => {
    const known = [clu(2, "10.0.0.2"), clu(1, "10.0.0.1")];
    const merged = mergeDiscovery(known, [clu(3, "10.0.0.3"), clu(2, "10.0.0.22")]);
    expect(merged.map((c) => [c.serial, c.address, c.online])).toEqual([
      [1, "10.0.0.1", false],
      [2, "10.0.0.22", true],
      [3, "10.0.0.3", true],
    ]);
    expect(known[1].online).toBe(true); // input untouched
  });
});

describe("mergeProject (no discovery needed)", () => {
  const project = [
    { serial: 5, ip: "10.0.0.5", name: "PARTER", gate: false },
    { serial: 9, ip: "10.0.0.9", name: "MODBUS", gate: true },
  ];
  it("lists project CLUs / GATEs by name with their project IP, reachable without discovery", () => {
    const list = mergeProject([], project);
    expect(list.map((c) => [c.name, c.address, c.online, c.lastSeen, c.gate, reachable(c)])).toEqual([
      ["MODBUS", "10.0.0.9", false, undefined, true, true],
      ["PARTER", "10.0.0.5", false, undefined, undefined, true],
    ]);
  });
  it("keeps discovery data and the project name across later discoveries; other discovered CLUs follow", () => {
    let list = mergeProject([clu(5, "10.0.0.55"), clu(7, "10.0.0.7")], project);
    expect(list.map((c) => [c.name ?? c.serial, c.address, c.online])).toEqual([["MODBUS", "10.0.0.9", false], ["PARTER", "10.0.0.55", true], [7, "10.0.0.7", true]]);
    list = mergeDiscovery(list, [clu(7, "10.0.0.7")]);
    expect(list.map((c) => [c.name ?? c.serial, c.online, reachable(c)])).toEqual([["MODBUS", false, true], ["PARTER", false, true], [7, true, true]]);
  });
  it("drops project-only entries that left the project; discovered ones stay without the name", () => {
    const list = mergeProject(mergeProject([clu(5, "10.0.0.5")], project), []);
    expect(list.map((c) => [c.serial, c.name, c.inProject])).toEqual([[5, undefined, undefined]]);
  });
});

describe("remembered CLUs (workspaceState)", () => {
  it("round-trips discovered CLUs only, restored offline; junk is skipped", () => {
    const list = [clu(1, "10.0.0.1", { mac: "aa:bb:cc:dd:ee:ff", keySource: "project" }), { ...clu(2, "10.0.0.2"), lastSeen: undefined, inProject: true, name: "P" }];
    const stored = JSON.parse(JSON.stringify(rememberClus(list)));
    expect(stored).toEqual([{ serial: 1, address: "10.0.0.1", mac: "aa:bb:cc:dd:ee:ff", cipher: "NONE", lastSeen: t0.toISOString() }]);
    expect(restoreClus(stored)).toEqual([{ serial: 1, address: "10.0.0.1", mac: "aa:bb:cc:dd:ee:ff", cipher: "NONE", online: false, lastSeen: t0 }]);
    expect(restoreClus([{ serial: "x" }, null, { serial: 3, lastSeen: "nope" }])).toEqual([]);
    expect(restoreClus(undefined)).toEqual([]);
  });
});

describe("cluDetails", () => {
  it("shows the OM id and padded hex serial", () => {
    const c = clu(100000013, "10.0.0.13", { mac: "aa:bb:cc:00:11:22" });
    expect(cluObjectId(c)).toBe("CLU100000013");
    expect(cluDetails(c).slice(0, 5)).toEqual([
      ["Serial", "100000013 (0x05f5e10d)"],
      ["IP", "10.0.0.13"],
      ["MAC", "aa:bb:cc:00:11:22"],
      ["Cipher", "NONE"],
      ["Stored key", "none"],
    ]);
    expect(cluDetails({ ...c, keySource: "project" })[4]).toEqual(["Stored key", "project key"]);
  });
});

describe("DevicesTreeProvider", () => {
  it("shows project CLUs by name, usable (modules) without discovery", async () => {
    const tree = new DevicesTreeProvider(async () => ({ modules: [] }) as unknown as CluConfigView);
    tree.setProject([{ serial: 9, ip: "10.0.0.9", name: "MODBUS", gate: true }]);
    const [root] = await tree.getChildren();
    expect(tree.getTreeItem(root)).toMatchObject({ label: "MODBUS", contextValue: "clu", description: "10.0.0.9 · CLU9 · GATE" });
    expect((await tree.getChildren(root)).some((n) => n.kind === "modules")).toBe(true);
  });

  it("lists CLUs with details and marks offline ones", async () => {
    const tree = new DevicesTreeProvider();
    let fired = 0;
    tree.onDidChangeTreeData(() => fired++);
    tree.update([clu(1, "10.0.0.1"), clu(2, "10.0.0.2")]);
    tree.update([clu(2, "10.0.0.2")]);
    expect(fired).toBe(2);

    const roots = await tree.getChildren();
    expect(roots).toHaveLength(2);
    // not seen any more, but its address is known: still usable (no discovery needed)
    expect(tree.getTreeItem(roots[0])).toMatchObject({ label: "CLU1", contextValue: "clu", description: "10.0.0.1 (not seen in the last discovery)" });
    expect(tree.getTreeItem(roots[1])).toMatchObject({ label: "CLU2", contextValue: "clu", description: "10.0.0.2", id: "clu:2" });

    const details = (await tree.getChildren(roots[1])).map((n) => tree.getTreeItem(n));
    expect(details[1]).toMatchObject({ label: "IP", description: "10.0.0.2" });
    expect(details.some((d) => d.label === "Modules")).toBe(false); // no loader

    tree.patch(2, { keySource: "project" });
    tree.patch(99, { keySource: "project" }); // unknown serial: ignored
    expect(tree.all.map((c) => c.keySource)).toEqual([undefined, "project"]);
    expect(fired).toBe(3);
  });

  const cfg: CluConfigView = {
    serial: 2, typeName: "CLU_ZWAVE_2", hwType: 19, hwVer: 1, fwType: 3, fwApiVer: 515, fwVer: "5.12.1", status: "OK", cluFeatures: [],
    modules: [{
      serial: 330000009, bus: "tfbus", name: "DIMMER_MOSFET_DIN", known: true, hwType: 26, fwType: 2, fwApiVer: 2, fwVer: "2.2.4", status: "OK",
      ios: [{
        label: "DIMM_01", defaultName: "x330000009_DIMM_01", objectName: "DIMM", objectClass: 5, channel: 0, objectId: "DIM1186", name: "LAMP",
        features: [
          { name: "Value", type: "num", unit: "%", get: true, set: true, index: 0, enums: [] },
          { name: "MinValue", type: "num", get: true, set: false, index: 3, enums: [] },
          { name: "Hidden", type: "num", get: false, set: true, index: 9, enums: [] },
        ],
        methods: [{ index: 0, call: "set", name: "SetValue", params: [{ name: "Value", type: "num" }] }],
      }],
    }],
  };

  it("loads modules lazily once, then shows type, firmware, modules and IOs", async () => {
    let loads = 0;
    const tree = new DevicesTreeProvider(async () => (loads++, cfg));
    tree.update([clu(1, "10.0.0.1"), clu(2, "10.0.0.2")]);
    tree.update([clu(2, "10.0.0.2")]); // CLU1 not seen any more: still has Modules (address known)
    const [offline, online] = await tree.getChildren();
    expect((await tree.getChildren(offline)).some((n) => n.kind === "modules")).toBe(true);

    const modulesNode = (await tree.getChildren(online)).find((n) => n.kind === "modules")!;
    expect(tree.getTreeItem(modulesNode)).toMatchObject({ label: "Modules", description: "from CONFIG.JSON" });
    const modules = await tree.getChildren(modulesNode);
    await tree.getChildren(modulesNode);
    expect(loads).toBe(1);
    expect(tree.getTreeItem(modules[0])).toMatchObject({ label: "DIMMER_MOSFET_DIN", description: "LAMP", contextValue: "module" });
    const ios = await tree.getChildren(modules[0]);
    expect(tree.getTreeItem(ios[0])).toMatchObject({ label: "LAMP", description: "DIM1186 · DIMM_01", contextValue: "io.mapped" });
    const features = await tree.getChildren(ios[0]);
    expect(features.map((f) => tree.getTreeItem(f)).map((i) => [i.label, i.description, i.contextValue])).toEqual([
      ["Value", "…", "feature.set"],
      ["MinValue", "…", "feature"],
    ]);

    expect(tree.getTreeItem(online).description).toBe("10.0.0.2 · CLU_ZWAVE_2 5.12.1");
    expect((await tree.getChildren(online)).map((n) => tree.getTreeItem(n).label)).toContain("Firmware");
    expect(tree.config(2)?.modules).toHaveLength(1);

    tree.invalidate(2);
    expect(tree.config(2)).toBeUndefined();
    await tree.getChildren(modulesNode);
    expect(loads).toBe(2);
  });

  it("shows live values and the last live error", async () => {
    const values = new Map([["DIM1186/0", "0.32"]]);
    let err: string | undefined;
    const tree = new DevicesTreeProvider(async () => cfg, { value: (_s, r) => values.get(`${r.id}/${r.index}`), error: () => err });
    const io = cfg.modules[0].ios[0];
    expect(ioReads(io)).toEqual([{ id: "DIM1186", index: 0 }, { id: "DIM1186", index: 3 }]);
    const ioNode = { kind: "io", serial: 2, module: cfg.modules[0], io } as const;
    const [value] = await tree.getChildren(ioNode);
    expect(tree.getTreeItem(value).description).toBe("0.32 %");
    err = "no answer";
    expect(tree.getTreeItem((await tree.getChildren(ioNode))[0]).label).toBe("live values: no answer");
    expect(ioReads({ ...io, objectId: undefined })).toEqual([]);
  });

  it("shows load errors as a node and retries on the next expand", async () => {
    let fail = true;
    const tree = new DevicesTreeProvider(async () => {
      if (fail) throw new Error("no key for CLU2: adopt it or import keys");
      return cfg;
    });
    tree.update([clu(2, "10.0.0.2")]);
    const modulesNode = { kind: "modules", serial: 2 } as const;
    const [msg] = await tree.getChildren(modulesNode);
    expect(tree.getTreeItem(msg)).toMatchObject({ label: "no key for CLU2: adopt it or import keys" });
    fail = false;
    expect((await tree.getChildren(modulesNode))[0].kind).toBe("module");
  });
});
