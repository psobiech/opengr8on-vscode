import { vi } from "vitest";
import { CLUDevice, CipherType } from "opengr8on-node/client";
import { cluDetails, cluObjectId, markSeen, mergeDiscovery, mergeProject, normalizeMac, reachable, rememberClus, restoreClus, toCluInfo, type CluInfo } from "../../src/device/cluInfo";
import { macFromArp, macFromProcArp } from "../../src/device/arp";
import type { CluConfigView } from "../../src/device/cluConfig";
import { DevicesTreeProvider, ioReads, type DeviceNode } from "../../src/views/devicesTree";

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

describe("contact (any answer fills online / lastSeen / MAC)", () => {
  it("normalizes MACs", () => {
    expect(normalizeMac("AABBCC001122")).toBe("aa:bb:cc:00:11:22");
    expect(normalizeMac("aa-bb-cc-00-11-22")).toBe("aa:bb:cc:00:11:22");
    expect(normalizeMac("00:00:00:00:00:00")).toBeNull();
    expect(normalizeMac("aabb")).toBeNull();
    expect(normalizeMac(undefined)).toBeNull();
  });

  it("markSeen sets online and lastSeen, keeps a known MAC unless a new one is given", () => {
    const t1 = new Date(t0.getTime() + 1000);
    const off = { ...clu(1, "10.0.0.1", { mac: "aa:bb:cc:dd:ee:ff" }), online: false };
    expect(markSeen(off, t1)).toEqual({ clu: { ...off, online: true, lastSeen: t1 }, flipped: true });
    expect(markSeen(off, t1, { mac: "112233445566" }).clu.mac).toBe("11:22:33:44:55:66");
    expect(markSeen(clu(1, "10.0.0.1"), t1).flipped).toBe(false);
  });

  it("reads the MAC of an IP from /proc/net/arp (complete entries only)", async () => {
    const arp = [
      "IP address       HW type     Flags       HW address            Mask     Device",
      "10.0.0.13        0x1         0x2         aa:bb:cc:00:11:22     *        eth0",
      "10.0.0.14        0x1         0x0         00:00:00:00:00:00     *        eth0",
    ].join("\n");
    expect(macFromProcArp(arp, "10.0.0.13")).toBe("aa:bb:cc:00:11:22");
    expect(macFromProcArp(arp, "10.0.0.14")).toBeNull();
    expect(macFromProcArp(arp, "10.0.0.1")).toBeNull();
    if (process.platform === "linux") {
      expect(await macFromArp("10.0.0.13", async () => arp)).toBe("aa:bb:cc:00:11:22");
      expect(await macFromArp("10.0.0.13", async () => Promise.reject(new Error("EACCES")))).toBeNull();
    }
  });
});

describe("DevicesTreeProvider", () => {
  it("seen / lost: project CLUs come online on any answer, refresh is throttled, CONFIG.JSON fills the MAC", async () => {
    const tree = new DevicesTreeProvider(async () => ({ ...({ modules: [] } as unknown as CluConfigView), mac: "AABBCCDDEEFF" }));
    tree.setProject([{ serial: 9, ip: "10.0.0.9", name: "MODBUS", gate: false }]);
    let fired = 0;
    tree.onDidChangeTreeData(() => fired++);
    const t1 = new Date(t0.getTime() + 1000);
    expect(tree.seen(9, {}, t1)).toBe(true); // came online: worth remembering
    expect(tree.all[0]).toMatchObject({ online: true, lastSeen: t1, inProject: true, address: "10.0.0.9" });
    expect(fired).toBe(1);
    expect(tree.seen(9, {}, new Date(t1.getTime() + 1000))).toBe(false); // push every second: no refresh
    expect(fired).toBe(1);
    tree.seen(9, {}, new Date(t1.getTime() + 11_000));
    expect(fired).toBe(2);
    expect(tree.seen(9, { address: "10.0.0.99" })).toBe(false); // project IP stays
    expect(tree.lost(9)).toBe(true);
    expect(tree.lost(9)).toBe(false);
    expect(tree.getTreeItem({ kind: "clu", clu: tree.all[0] }).description).toMatch(/^10\.0\.0\.9 · CLU9 \(offline, last seen .+\)$/);
    await tree.loadConfigFor(9);
    expect(tree.all[0]).toMatchObject({ online: true, mac: "aa:bb:cc:dd:ee:ff" });
    expect(tree.seen(123)).toBe(false); // unknown serial
  });

  it("knows project CLUs by name, usable (modules) without discovery, but lists them in the Project view", async () => {
    const tree = new DevicesTreeProvider(async () => ({ modules: [] }) as unknown as CluConfigView);
    tree.setProject([{ serial: 9, ip: "10.0.0.9", name: "MODBUS", gate: true }]);
    const root: DeviceNode = { kind: "clu", clu: tree.all[0] };
    expect(tree.getTreeItem(root)).toMatchObject({ label: "MODBUS", contextValue: "clu", description: "10.0.0.9 · CLU9 · GATE" });
    expect((await tree.getChildren(root)).some((n) => n.kind === "modules")).toBe(true);
    // Devices lists only CLUs outside the project (to adopt / import)
    expect((await tree.getChildren()).map((n) => tree.getTreeItem(n).label)).toEqual(["1 project CLU(s): see the Project view"]);
    tree.update([clu(9, "10.0.0.9"), clu(3, "10.0.0.3")]);
    expect((await tree.getChildren()).map((n) => tree.getTreeItem(n).label)).toEqual(["CLU3"]);
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
    expect(tree.getTreeItem(roots[0])).toMatchObject({ label: "CLU1", contextValue: "clu", description: expect.stringMatching(/^10\.0\.0\.1 \(offline, last seen .+\)$/) });
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

  it("throttles live re-renders (VS Code's 200 ms debounce would starve on fast pushes); the last one always shows", () => {
    vi.useFakeTimers();
    try {
      const tree = new DevicesTreeProvider();
      let fired = 0;
      tree.onDidChangeTreeData(() => fired++);
      for (let i = 0; i < 10; i++) {
        tree.refresh(); // a push every 100 ms
        vi.advanceTimersByTime(100);
      }
      expect(fired).toBe(4); // t=0, 300, 600, 900
      vi.advanceTimersByTime(1000);
      expect(fired).toBe(5); // trailing one for the refresh at 900, at 1200; then quiet
      tree.refresh();
      tree.refresh();
      vi.advanceTimersByTime(300);
      expect(fired).toBe(7); // immediate + trailing
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports shown (expanded) module rows, also ones VS Code restores without an expand event", async () => {
    const tree = new DevicesTreeProvider(async () => cfg);
    const shown: string[] = [];
    tree.onModuleShown = (serial, m) => shown.push(`${serial}/${m.serial}`);
    await tree.getChildren({ kind: "module", serial: 2, module: cfg.modules[0] });
    expect(shown).toEqual(["2/330000009"]);
  });

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
