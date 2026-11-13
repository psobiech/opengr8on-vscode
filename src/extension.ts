import * as vscode from "vscode";
import { l10n } from "vscode";
import * as path from "node:path";
import { CLUDevice, type CipherKey } from "opengr8on-node/client";
import { adoptClu, adoptionCandidates, dropAnswering, type AdoptionCandidate } from "./device/adopt";
import { discoverClus, interfaceChoices, pickInterface, type LocalInterface } from "./device/discovery";
import { reachable, rememberClus, restoreClus, toCluInfo, type CluInfo } from "./device/cluInfo";
import { projectCluView } from "./device/projectView";
import { PushReceiver } from "./device/pushReceiver";
import { macFromArp } from "./device/arp";
import { AlivePoller } from "./device/alivePoller";
import { GATE_HW_TYPE } from "./generator/omLua";
import { KeyStore, parseKeysFile, pinToPrivateKey } from "./device/keyStore";
import { INTERFACES_DIR, loadInterfaceRegistry } from "./interfaces/registry";
import { CLUFiles } from "opengr8on-node/client";
import { attachOmObjects, parseCluConfig } from "./device/cluConfig";
import { LivePoller } from "./device/liveValues";
import { parseOmObjects } from "./project/omLuaObjects";
import { CluRunner } from "./device/cluRunner";
import { registerCluCommands } from "./views/cluCommands";
import { DevicesTreeProvider, moduleNodeId, moduleReads, type DeviceNode } from "./views/devicesTree";
import { LogTerminals } from "./views/logTerminal";
import { registerProjectCommands } from "./views/projectCommands";
import { ProjectWatcher, findProjectRoot } from "./views/projectWatcher";
import { ProjectTreeProvider } from "./views/projectTree";
import { PLUGIN, luaStubs } from "./lua/stubs";
import { PLUGIN_FILE, STUB_DIR, mergeLuarc } from "./lua/luarc";
import { buildIndex, type ProjectIndex } from "./project/assist";
import { registerEditorAssist } from "./views/editorAssist";
import { CluStatusBar } from "./views/statusBar";

/**
 * Entry point: wires views, commands and services together.
 * Keep this file thin: logic lives in src/{project,generator,device,omp,views} and is unit-tested
 * without vscode.
 */
/** workspaceState key of the CLUs found by earlier discoveries (address, MAC; never keys). */
const REMEMBERED_KEY = "opengr8on.discoveredClus";

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("OpenGr8on");
  context.subscriptions.push(log);


  const keys = new KeyStore(context.secrets);
  // Project key scope: the (first) workspace folder. Multi-root projects are not supported yet.
  const projectScope = () => vscode.workspace.workspaceFolders?.[0]?.uri.toString();

  // Last discovery: devices (with their discovery iv, needed to adopt) and the interface used.
  const discovered = new Map<number, CLUDevice>();
  // CLUs whose adoption proposal was declined ("Not now"): not proposed again this session.
  const adoptionDeclined = new Set<number>();
  let discoveryIface: LocalInterface | undefined;
  // Project CLUs need no discovery: a device from the project IP, the configured network interface.
  const projectDevices = new Map<number, CLUDevice>();
  const target = (serial: number): { device: CLUDevice; local: string } | string => {
    const device = discovered.get(serial);
    if (device && discoveryIface) return { device, local: discoveryIface.address };
    // no discovery needed: the project IP, or the address remembered from an earlier discovery
    const known = devices.all.find((c) => c.serial === serial && c.address);
    if (!known?.address) return l10n.t("No address known for CLU{0}: add it to the project or run Discover CLUs", serial);
    let d = projectDevices.get(serial);
    if (!d || d.address !== known.address) projectDevices.set(serial, (d = new CLUDevice({ serialNumber: serial, address: known.address })));
    return { device: d, local: discoveryIface?.address ?? pickInterface(vscode.workspace.getConfiguration("opengr8on").get<string>("network.interface", "")).address };
  };
  const runner = new CluRunner(keys, projectScope);

  const execute = async (serial: number, script: string): Promise<string> => {
    const t = target(serial);
    if (typeof t === "string") throw new Error(t);
    return runner.execute(t.local, t.device, script);
  };
  // CLUs push changed values to this socket (SYSTEM:clientRegister); polling is the fallback
  const pushEnabled = vscode.workspace.getConfiguration("opengr8on").get<boolean>("liveValues.push", true);
  const push: PushReceiver = new PushReceiver(
    async (address: string): Promise<CipherKey | undefined> => {
      const clu = devices.all.find((c) => c.address === address);
      return clu ? (await keys.cipherKeyFor(clu.serial, projectScope())).key : undefined;
    },
    (text) => void live.applyPush(text),
  );
  if (pushEnabled) push.start().catch((e) => log.appendLine(`live values: push receiver not started (${(e as Error).message}), polling`));
  const live: LivePoller = new LivePoller(
    execute,
    () => {
      devices.refresh();
      status.render();
    },
    Math.max(500, vscode.workspace.getConfiguration("opengr8on").get<number>("liveValues.intervalMs", 2000)),
    pushEnabled
      ? {
          port: () => push.port,
          localFor: (serial) => {
            const t = target(serial);
            return typeof t === "string" ? undefined : t.local;
          },
        }
      : undefined,
    (line) => log.appendLine(line),
  );
  context.subscriptions.push({ dispose: () => (live.dispose(), push.close()) });

  const devices = new DevicesTreeProvider(async (serial) => {
    // project CLUs / GATEs: modules, objects and ids from the project (no TFTP; values via req: only)
    const model = project?.resolved.find((c) => c.id === `CLU${serial}`);
    if (model) return projectCluView(model, loadInterfaceRegistry(path.join(context.extensionPath, INTERFACES_DIR)), l10n.t);
    const t = target(serial);
    if (typeof t === "string") throw new Error(t);
    const json = await runner.download(t.local, t.device, CLUFiles.CONFIG_JSON);
    if (!json) throw new Error(l10n.t("CLU has no CONFIG.JSON (try Refresh Modules)"));
    const view = parseCluConfig(json.toString("utf8"), loadInterfaceRegistry(path.join(context.extensionPath, INTERFACES_DIR)));
    // Object ids live in the CLU's OM.LUA; without it IOs are listed but cannot be polled.
    const om = await runner.download(t.local, t.device, CLUFiles.OM_LUA);
    const matched = om ? attachOmObjects(view, parseOmObjects(om.toString("utf8"))) : 0;
    log.appendLine(`CLU${serial}: ${view.modules.length} module(s), ${matched} IO(s) matched in OM.LUA${om ? "" : " (no OM.LUA)"}`);
    return view;
  }, live);
  devices.restore(restoreClus(context.workspaceState.get(REMEMBERED_KEY)));
  const remember = () => void context.workspaceState.update(REMEMBERED_KEY, rememberClus(devices.all));
  void (async () => {
    // restored CLUs: show which key we hold
    for (const c of devices.all) if (!c.keySource) devices.patch(c.serial, { keySource: (await keys.cipherKeyFor(c.serial, projectScope())).source });
  })().catch((e) => log.appendLine(`keys: ${(e as Error).message}`));

  // Every answer (check alive, req:, TFTP, pushes) keeps online / lastSeen / MAC current.
  const arpTried = new Set<number>();
  const seen = (serial: number) => {
    if (devices.seen(serial)) remember();
    const clu = devices.all.find((c) => c.serial === serial);
    if (!clu?.mac && clu?.address && !arpTried.has(serial)) {
      arpTried.add(serial);
      void macFromArp(clu.address).then((mac) => {
        if (mac && devices.seen(serial, { mac })) {
          log.appendLine(`CLU${serial}: MAC ${mac} (ARP)`);
          remember();
        }
      });
    }
  };
  const lost = (serial: number) => {
    if (devices.lost(serial)) log.appendLine(`CLU${serial}: not answering, offline`);
  };
  runner.onContact = (serial, answered) => (answered ? seen(serial) : lost(serial));
  live.onContact = (serial, answered) => (answered ? seen(serial) : lost(serial));

  // Background check alive of every CLU we can talk to (no module values: those only when expanded)
  const aliveSec = vscode.workspace.getConfiguration("opengr8on").get<number>("devices.checkAliveIntervalSec", 30);
  if (aliveSec > 0) {
    const alive = new AlivePoller(
      () => devices.all.filter((c) => reachable(c) && (c.keySource === "clu" || c.keySource === "project")),
      async (serial) => {
        const t = target(serial);
        if (typeof t !== "string") await runner.checkAlive(t.local, t.device);
      },
      Math.max(5, aliveSec) * 1000,
    );
    alive.start();
    context.subscriptions.push({ dispose: () => alive.stop() });
  }

  const status = new CluStatusBar(context.workspaceState, (serial) => devices.all.find((c) => c.serial === serial), (serial) => live.error(serial));
  context.subscriptions.push(
    status,
    devices.onDidChangeTreeData(() => status.render()),
    vscode.commands.registerCommand("opengr8on.selectClu", async () => {
      const items = devices.all.map((c) => ({
        label: c.name ?? `CLU${c.serial}`,
        description: `${c.address ?? ""}${c.name ? ` · CLU${c.serial}` : ""}${reachable(c) ? "" : ` (${l10n.t("offline")})`}`,
        serial: c.serial as number | undefined,
      }));
      if (items.length === 0) {
        void vscode.commands.executeCommand("opengr8on.discover");
        return;
      }
      const pick = await vscode.window.showQuickPick([...items, { label: `$(close) ${l10n.t("none")}`, description: "", serial: undefined }], { title: l10n.t("OpenGr8on: selected CLU") });
      if (!pick) return;
      status.select(pick.serial);
      const node = pick.serial === undefined ? undefined : (await devices.getChildren()).find((n) => n.kind === "clu" && n.clu.serial === pick.serial);
      if (node) await devicesView.reveal(node, { select: true, focus: false });
    }),
  );

  devices.onModuleShown = (serial, module) => {
    const reads = moduleReads(module);
    if (reads.length) live.watch(serial, moduleNodeId(serial, module), reads);
  };
  const devicesView = vscode.window.createTreeView<DeviceNode>("opengr8on.devices", { treeDataProvider: devices, showCollapseAll: true });
  context.subscriptions.push(
    devicesView,
    // clientRegister only for expanded module rows (watched from getChildren, see onModuleShown);
    // collapsing a module, its Modules row or its CLU ends the subscriptions below it
    devicesView.onDidCollapseElement(({ element: n }) => {
      if (n.kind === "module") live.unwatch(n.serial, moduleNodeId(n.serial, n.module));
      else if (n.kind === "modules" || n.kind === "clu") {
        const serial = n.kind === "clu" ? n.clu.serial : n.serial;
        live.unwatchPrefix(serial, `clu:${serial}:`);
      }
    }),
    devicesView.onDidChangeSelection(({ selection }) => {
      const n = selection[0];
      if (!n) return;
      const serial = n.kind === "clu" ? n.clu.serial : "serial" in n ? n.serial : undefined;
      if (serial !== undefined) status.select(serial);
    }),
    devicesView.onDidChangeVisibility(({ visible }) => (visible ? live.resume() : live.pause())),
  );

  const logs = new LogTerminals();
  context.subscriptions.push(
    logs,
    vscode.commands.registerCommand("opengr8on.openLogs", async (node?: { clu?: CluInfo }) => {
      let serial = node?.clu?.serial;
      if (serial === undefined) {
        const online = devices.all.filter((c) => reachable(c) && c.address);
        if (online.length === 0) {
          void vscode.window.showErrorMessage(l10n.t("OpenGr8on: no CLU discovered yet; run Discover CLUs."));
          return;
        }
        const pick = online.length === 1 ? online[0] : (await vscode.window.showQuickPick(online.map((c) => ({ label: c.name ?? `CLU${c.serial}`, description: `${c.address ?? ""}${c.name ? ` · CLU${c.serial}` : ""}`, c })), { title: l10n.t("Open logs of") }))?.c;
        if (!pick) return;
        serial = pick.serial;
      }
      const address = discovered.get(serial)?.address ?? devices.all.find((c) => c.serial === serial)?.address;
      if (!address) {
        void vscode.window.showErrorMessage(l10n.t("OpenGr8on: no address for CLU{0}; run Discover CLUs.", serial));
        return;
      }
      logs.show(serial, address);
    }),
    vscode.commands.registerCommand("opengr8on.setLogLevel", async (node?: { clu?: CluInfo }) => {
      const serial = node?.clu?.serial;
      if (serial === undefined) return;
      try {
        const cfg = await devices.loadConfigFor(serial);
        const f = cfg.cluFeatures.find((x) => x.name === "TelnetLogLevel");
        if (!f) throw new Error(l10n.t("no TelnetLogLevel feature in the {0} CLU interface", cfg.typeName ?? "?"));
        const pick = await vscode.window.showQuickPick(
          f.enums.map((e) => ({ label: e.name, description: String(e.value), value: e.value })),
          { title: l10n.t("CLU{0} telnet log level", serial) },
        );
        if (!pick) return;
        const answer = await execute(serial, `CLU${serial}:set(${f.index}, ${pick.value})`);
        log.appendLine(`CLU${serial}: TelnetLogLevel = ${pick.label} (${answer})`);
        vscode.window.setStatusBarMessage(`CLU${serial}: log level ${pick.label}`, 5000);
      } catch (e) {
        void vscode.window.showErrorMessage(l10n.t("OpenGr8on: CLU{0} log level: {1}", serial, (e as Error).message));
      }
    }),
  );

  registerCluCommands(context, {
    runner,
    log,
    target,
    onAddressChanged: (serial, address) => {
      discovered.get(serial)?.setAddress(address);
      logs.addressChanged(serial, address);
      devices.patch(serial, { address });
      remember();
      devices.invalidate(serial);
    },
    onModulesChanged: (serial) => devices.invalidate(serial),
    execute,
    afterChange: () => void live.tick(),
  });

  const selectInterface = async (): Promise<boolean> => {
    const config = vscode.workspace.getConfiguration("opengr8on");
    const choices = interfaceChoices(config.get<string>("network.interface", ""), undefined, l10n.t);
    const picked = await vscode.window.showQuickPick(
      choices.map((c) => ({ ...c, label: c.picked ? `$(check) ${c.label}` : c.label })),
      { title: l10n.t("OpenGr8on: network interface for CLU discovery"), matchOnDescription: true, matchOnDetail: true },
    );
    if (!picked) return false;
    const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await config.update("network.interface", picked.value, target);
    log.appendLine(`network interface: ${picked.value || "automatic"}`);
    return true;
  };

  /**
   * After a discovery: offer to adopt CLUs that do not answer under this project's key (new ones,
   * or ones holding another project key). One CLU: Adopt / Not now; several: a quick pick.
   * Declined CLUs are not proposed again this session. Off with opengr8on.discovery.proposeAdoption.
   */
  const proposeAdoption = async (found: CLUDevice[]): Promise<void> => {
    if (!projectScope() || !vscode.workspace.getConfiguration("opengr8on").get<boolean>("discovery.proposeAdoption", true)) return;
    const iface = discoveryIface;
    if (!iface) return;
    // check alive under the key we have for it (CLU or project key); run(), not checkAlive(): a
    // CLU that does not answer must not be marked offline
    const candidates = await dropAnswering(adoptionCandidates(found, adoptionDeclined), async (serial) => {
      const device = discovered.get(serial);
      if (!device || (await keys.cipherKeyFor(serial, projectScope())).source === "none") return null;
      return runner.run(iface.address, device, (c) => c.checkAlive());
    });
    if (candidates.length === 0) return;
    const nameOf = (c: AdoptionCandidate): string => devices.all.find((x) => x.serial === c.serial)?.name ?? `CLU${c.serial}`;
    const adopt = l10n.t("Adopt");
    const notNow = l10n.t("Not now");
    const describe = (c: AdoptionCandidate): string =>
      c.reason === "rekey" ? l10n.t("holds another project key") : l10n.t("not in this project");
    let picked: AdoptionCandidate | undefined;
    if (candidates.length === 1) {
      const c = candidates[0];
      const action = await vscode.window.showInformationMessage(
        l10n.t("OpenGr8on: found {0} ({1}), {2}. Adopt it?", nameOf(c), c.address, describe(c)),
        adopt,
        notNow,
      );
      if (action === adopt) picked = c;
    } else {
      const action = await vscode.window.showInformationMessage(
        l10n.t("OpenGr8on: found {0} CLUs not adopted by this project.", candidates.length),
        l10n.t("Adopt…"),
        notNow,
      );
      if (action === l10n.t("Adopt…")) {
        const item = await vscode.window.showQuickPick(
          candidates.map((c) => ({ label: nameOf(c), description: `CLU${c.serial} · ${c.address}`, detail: describe(c), c })),
          { title: l10n.t("OpenGr8on: adopt a CLU into this project") },
        );
        picked = item?.c;
        if (!picked) return; // closed: ask again on the next discovery
      }
    }
    if (!picked) {
      for (const c of candidates) adoptionDeclined.add(c.serial);
      return;
    }
    const clu = devices.all.find((x) => x.serial === picked!.serial);
    if (clu) await vscode.commands.executeCommand("opengr8on.adoptClu", { kind: "clu", clu });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("opengr8on.selectInterface", selectInterface),
    vscode.commands.registerCommand("opengr8on.discover", async () => {
      try {
        const iface = pickInterface(vscode.workspace.getConfiguration("opengr8on").get<string>("network.interface", ""));
        const found = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: l10n.t("OpenGr8on: discovering CLUs on {0} ({1})…", iface.name, iface.address) },
          async () => {
            const scope = projectScope();
            const projectKey = scope ? await keys.getProjectKey(scope) : undefined;
            return discoverClus({ iface, projectKey, privateKeys: await keys.privateKeys() });
          },
        );
        discoveryIface = iface;
        for (const d of found) if (d.serialNumber != null) discovered.set(d.serialNumber, d);
        log.appendLine(`discovery on ${iface.name} ${iface.address}: ${found.length} CLU(s)`);
        for (const d of found) log.appendLine(`  serial=${d.serialNumber} mac=${d.macAddress} ip=${d.address} cipher=${String(d.cipherType)}`);
        const infos = found.map((d) => toCluInfo(d)).filter((c): c is CluInfo => c !== null);
        for (const c of infos) c.keySource = (await keys.cipherKeyFor(c.serial, projectScope())).source;
        devices.update(infos);
        remember();
        if (found.length === 0) void vscode.window.showInformationMessage(l10n.t("OpenGr8on: no CLU answered on {0} ({1}).", iface.name, iface.address));
        void proposeAdoption(found);
      } catch (e) {
        const action = await vscode.window.showErrorMessage(l10n.t("OpenGr8on: discovery failed: {0}", (e as Error).message), l10n.t("Select Network Interface"));
        if (action && (await selectInterface())) await vscode.commands.executeCommand("opengr8on.discover");
      }
    }),
    vscode.commands.registerCommand("opengr8on.importKeys", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        void vscode.window.showErrorMessage(l10n.t("OpenGr8on: open the project folder first (the project key is stored per workspace folder)."));
        return;
      }
      let file = vscode.Uri.joinPath(folder.uri, ".opengr8on", "keys.json");
      try {
        await vscode.workspace.fs.stat(file);
      } catch {
        const picked = await vscode.window.showOpenDialog({ title: l10n.t("OpenGr8on: import keys.json"), canSelectMany: false, filters: { "keys.json": ["json"] } });
        if (!picked?.[0]) return;
        file = picked[0];
      }
      try {
        const parsed = parseKeysFile(Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8"));
        const r = await keys.importKeys(parsed, folder.uri.toString());
        const from = vscode.workspace.asRelativePath(file);
        log.appendLine(`keys: imported ${r.project ? "project key" : "no project key"} and ${r.clus.length} CLU key set(s) from ${from}${r.clus.length ? ` (serials ${r.clus.join(", ")})` : ""}`);
        const msg = r.project
          ? l10n.t("OpenGr8on: imported the project key and {0} CLU key set(s) from {1}.", r.clus.length, from)
          : l10n.t("OpenGr8on: imported no project key and {0} CLU key set(s) from {1}.", r.clus.length, from);
        for (const c of devices.all) {
          devices.patch(c.serial, { keySource: (await keys.cipherKeyFor(c.serial, projectScope())).source });
          devices.invalidate(c.serial);
        }
        void vscode.window.showInformationMessage(msg);
      } catch (e) {
        void vscode.window.showErrorMessage(l10n.t("OpenGr8on: keys not imported: {0}", (e as Error).message));
      }
    }),
    vscode.commands.registerCommand("opengr8on.adoptClu", async (node?: { kind: string; clu?: CluInfo }) => {
      const serial = node?.clu?.serial;
      const device = serial !== undefined ? discovered.get(serial) : undefined;
      const scope = projectScope();
      if (serial === undefined || !device || !discoveryIface) {
        void vscode.window.showErrorMessage(l10n.t("OpenGr8on: discover the CLU first."));
        return;
      }
      if (!scope) {
        void vscode.window.showErrorMessage(l10n.t("OpenGr8on: open the project folder first (the project key is stored per workspace folder)."));
        return;
      }
      let privateKey = (await keys.getCluKeys(serial))?.privateKey;
      if (!privateKey) {
        const pin = await vscode.window.showInputBox({
          title: l10n.t("Adopt CLU{0}", serial),
          prompt: l10n.t("PIN printed on the CLU (8 characters)"),
          password: true,
          ignoreFocusOut: true,
          validateInput: (v) => {
            try {
              pinToPrivateKey(v);
              return undefined;
            } catch (e) {
              return (e as Error).message;
            }
          },
        });
        if (pin === undefined) return;
        privateKey = pinToPrivateKey(pin);
      }
      const adopt = l10n.t("Adopt");
      const ok = await vscode.window.showWarningMessage(
        l10n.t("Adopt CLU{0} ({1}) into this project?", serial, device.address ?? ""),
        {
          modal: true,
          detail: l10n.t(
            "The CLU gets this project's cipher key. Object Manager (or another project) that used the old key can no longer talk to it until it adopts the CLU again.",
          ),
        },
        adopt,
      );
      if (ok !== adopt) return;
      try {
        const iface = discoveryIface;
        const r = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: l10n.t("OpenGr8on: adopting CLU{0}…", serial) },
          () => adoptClu({ device, privateKey: privateKey!, scope, keys, localAddress: iface.address }),
        );
        log.appendLine(`adopt CLU${serial}: ok${r.generatedProjectKey ? " (new project key generated)" : ""}, check alive: ${String(r.alive)}`);
        devices.patch(serial, { keySource: (await keys.cipherKeyFor(serial, scope)).source });
        devices.invalidate(serial);
        void vscode.window.showInformationMessage(
          r.alive
            ? l10n.t("OpenGr8on: CLU{0} adopted.", serial)
            : r.alive === null
              ? l10n.t("OpenGr8on: CLU{0} adopted, but it did not answer check alive.", serial)
              : l10n.t("OpenGr8on: CLU{0} adopted, but check alive failed.", serial),
        );
      } catch (e) {
        log.appendLine(`adopt CLU${serial}: ${(e as Error).message}`);
        void vscode.window.showErrorMessage(`OpenGr8on: ${(e as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("opengr8on.forgetCluKeys", async (node?: { kind: string; clu?: CluInfo }) => {
      const serial = node?.clu?.serial;
      if (serial === undefined) return;
      const forget = l10n.t("Forget");
      const ok = await vscode.window.showWarningMessage(l10n.t("Forget stored keys of CLU{0}? The project key stays.", serial), { modal: true }, forget);
      if (ok !== forget) return;
      await keys.deleteCluKeys(serial);
      log.appendLine(`keys: forgot CLU${serial}`);
      devices.patch(serial, { keySource: (await keys.cipherKeyFor(serial, projectScope())).source });
      devices.invalidate(serial);
    }),
  );

  // Device interfaces (~0.5 s sync parse of 350 XMLs): loaded right after activation, not inside it,
  // and cached for later users (resolver, explorer, LuaLS stubs). Missing dist/interfaces = broken
  // package: report it loudly.
  const interfacesTimer = setTimeout(() => {
    try {
      const t0 = Date.now();
      const reg = loadInterfaceRegistry(path.join(context.extensionPath, INTERFACES_DIR));
      log.appendLine(`interfaces: ${reg.cluCount} CLU, ${reg.moduleCount} module, ${reg.objectCount} object (${Date.now() - t0} ms)`);
    } catch (e) {
      log.appendLine(`interfaces: ${(e as Error).message}`);
      void vscode.window.showErrorMessage(l10n.t("OpenGr8on: device interfaces not loaded: {0}", (e as Error).message));
    }
  }, 0);
  context.subscriptions.push({ dispose: () => clearTimeout(interfacesTimer) });

  // Project (YAML + Lua): load + resolve with diagnostics; generate / upload use the resolved model.
  const registry = () => loadInterfaceRegistry(path.join(context.extensionPath, INTERFACES_DIR));
  let project: ProjectWatcher | undefined;
  const projectTree = new ProjectTreeProvider(() => project?.root);
  context.subscriptions.push(vscode.window.registerTreeDataProvider("opengr8on.project", projectTree));
  // LuaLS stubs: .opengr8on/luals/opengr8on.lua (git-ignored) + .luarc.json library entry.
  let lastStubs = "";
  const writeLuaStubs = async (w: ProjectWatcher) => {
    const { text, conflicts } = luaStubs(w.resolved, registry());
    if (text !== lastStubs) {
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(w.root, ...STUB_DIR.split("/"), "opengr8on.lua"), Buffer.from(text, "utf8"));
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(w.root, ...PLUGIN_FILE.split("/")), Buffer.from(PLUGIN, "utf8"));
      lastStubs = text;
    }
    if (conflicts.length) log.appendLine(`lua stubs: ids with different classes on different CLUs: ${conflicts.join(", ")}`);
    const luarc = vscode.Uri.joinPath(w.root, ".luarc.json");
    let existing: string | undefined;
    try {
      existing = Buffer.from(await vscode.workspace.fs.readFile(luarc)).toString("utf8");
    } catch {
      existing = undefined;
    }
    const merged = mergeLuarc(existing);
    if (merged.changed) {
      await vscode.workspace.fs.writeFile(luarc, Buffer.from(merged.text, "utf8"));
      log.appendLine(`lua stubs: added ${STUB_DIR} and the plugin to .luarc.json`);
      // LuaLS reads plugins only at startup: without a restart CLU->OBJECT->Member stays underlined
      const pick = await vscode.window.showInformationMessage(
        l10n.t("OpenGr8on: Lua support for CLU->OBJECT->Member was configured. Restart the Lua language server to activate it?"),
        l10n.t("Restart Lua Server"),
      );
      if (pick) {
        try {
          await vscode.commands.executeCommand("lua.stopServer");
          await vscode.commands.executeCommand("lua.startServer");
        } catch {
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      }
    }
  };

  // Friendly-name completion / inlay hints for scripts and project YAML.
  let projectIndex: ProjectIndex | undefined;
  const assist = registerEditorAssist(context, {
    index: () => projectIndex,
    registry,
    root: () => project?.root,
    selectedSerial: () => status.selected,
  });

  const watchProject = async (root: vscode.Uri) => {
    const w = new ProjectWatcher(root, log, registry);
    context.subscriptions.push(
      w,
      w.onDidLoad((p) => {
        projectTree.update(p, w.errorsByFile, w.resolved);
        // the project's CLUs / GATEs are listed (and usable) in the Devices view without discovery
        devices.setProject((p?.clus ?? []).map((c) => ({ serial: c.serial, ip: c.ip, name: c.name, gate: c.hw.type === GATE_HW_TYPE })));
        void (async () => {
          for (const c of devices.all) if (c.inProject && !c.keySource) devices.patch(c.serial, { keySource: (await keys.cipherKeyFor(c.serial, projectScope())).source });
        })().catch((e) => log.appendLine(`keys: ${(e as Error).message}`));
        try {
          projectIndex = buildIndex(w.resolved, registry());
          assist.refresh();
        } catch (e) {
          log.appendLine(`editor assist: ${(e as Error).message}`);
        }
        if (p) void writeLuaStubs(w).catch((e) => log.appendLine(`lua stubs: ${(e as Error).message}`));
      }),
    );
    project = w;
    await w.reload();
    return w;
  };
  const projectReady = findProjectRoot().then((root) => (root ? watchProject(root) : (projectTree.update(undefined, new Map()), undefined)));
  // welcome buttons (Discover, New Project, Import .omp) only once the project is loaded (or absent)
  void projectReady
    .catch((e) => log.appendLine(`project: ${(e as Error).message}`))
    .finally(() => void vscode.commands.executeCommand("setContext", "opengr8on.ready", true));

  /** Reloads the project and returns the resolved CLUs, or undefined (with a message) on errors. */
  const resolvedProject = async () => {
    const p = project ?? (await projectReady);
    if (!p) {
      void vscode.window.showErrorMessage(l10n.t("OpenGr8on: no opengr8on.yaml in this workspace."));
      return undefined;
    }
    // validation follows unsaved edits, but generated / uploaded files must match what is saved
    const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.path.startsWith(p.root.path + "/") && /\/(clus|scripts)\/|\/opengr8on\.yaml$/.test(d.uri.path));
    if (dirty.length) {
      const save = l10n.t("Save and Continue");
      const ok = await vscode.window.showWarningMessage(l10n.t("OpenGr8on: {0} project file(s) have unsaved changes.", dirty.length), { modal: true }, save);
      if (ok !== save) return undefined;
      for (const d of dirty) await d.save();
    }
    await p.reload();
    if (p.errorCount > 0 || !p.current) {
      void vscode.window.showErrorMessage(l10n.t("OpenGr8on: the project has {0} error(s); see the Problems panel.", p.errorCount));
      void vscode.commands.executeCommand("workbench.actions.view.problems");
      return undefined;
    }
    return { watcher: p, clus: p.resolved };
  };

  registerProjectCommands(context, {
    log,
    runner,
    resolvedProject,
    // discovered device, else one from the project IP (no discovery needed)
    discovered: (serial) => {
      const t = target(serial);
      return typeof t === "string" ? undefined : t.device;
    },
    localAddress: () => discoveryIface?.address ?? pickInterface(vscode.workspace.getConfiguration("opengr8on").get<string>("network.interface", "")).address,
    selectedSerial: () => status.selected,
    registry,
    eol: () => (vscode.workspace.getConfiguration("opengr8on").get<string>("generate.lineEndings", "crlf") === "lf" ? "\n" : "\r\n"),
    project: async () => {
      if (project ?? (await projectReady)) return project;
      const root = await findProjectRoot(); // created after activation (New Project)
      return root ? watchProject(root) : undefined;
    },
    loadConfig: (serial) => devices.loadConfigFor(serial),
    keys,
    execute,
    uploaded: (serial) => devices.invalidate(serial),
  });

  log.appendLine("OpenGr8on activated");
}

export function deactivate(): void {}
