import * as vscode from "vscode";
import { l10n } from "vscode";
import { cluDetails, cluObjectId, mergeDiscovery, mergeProject, reachable, type CluInfo, type ProjectDevice } from "../device/cluInfo";
import type { ParsedFeature } from "opengr8on-node/client";
import type { CluConfigView, IoView, ModuleView } from "../device/cluConfig";
import type { FeatureRead } from "../device/liveValues";

export type DeviceNode =
  | { kind: "clu"; clu: CluInfo }
  | { kind: "detail"; label: string; value: string }
  | { kind: "modules"; serial: number }
  | { kind: "module"; serial: number; module: ModuleView }
  | { kind: "io"; serial: number; module: ModuleView; io: IoView }
  | { kind: "feature"; serial: number; io: IoView; feature: ParsedFeature }
  | { kind: "message"; text: string; error: boolean };

/** Loads a CLU's CONFIG.JSON (download + parse); errors are shown as a node. */
export type ConfigLoader = (serial: number) => Promise<CluConfigView>;

/** Live values source (LivePoller). */
export interface LiveValues {
  value(serial: number, read: FeatureRead): string | undefined;
  error(serial: number): string | undefined;
}

/** Features of an IO that can be polled (`get` in the interface XML); empty if not in OM.LUA. */
export function ioReads(io: IoView): FeatureRead[] {
  return io.objectId ? io.features.filter((f) => f.get).map((f) => ({ id: io.objectId!, index: f.index })) : [];
}

/** Stable node id of an IO (also the LivePoller watch owner). */
export const ioNodeId = (serial: number, module: ModuleView, io: IoView) =>
  module.kind ? `clu:${serial}:${module.kind}:${io.objectId}` : `clu:${serial}:mm:${module.serial}:${io.objectName}:${io.channel}`;

/** `opengr8on.devices`: CLUs found on the network → discovery details + modules (CONFIG.JSON) → IOs. */
export class DevicesTreeProvider implements vscode.TreeDataProvider<DeviceNode> {
  private clus: CluInfo[] = [];
  private readonly configs = new Map<number, Promise<CluConfigView>>();
  private readonly loaded = new Map<number, CluConfigView>();
  private readonly changed = new vscode.EventEmitter<DeviceNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly loadConfig?: ConfigLoader,
    private readonly live?: LiveValues,
  ) {}

  /** Re-renders (new live values). */
  refresh(): void {
    this.changed.fire(undefined);
  }

  get all(): readonly CluInfo[] {
    return this.clus;
  }

  /** CONFIG.JSON of a CLU if it was loaded (for live values, project skeleton, ...). */
  config(serial: number): CluConfigView | undefined {
    return this.loaded.get(serial);
  }

  /** Applies a discovery result (see mergeDiscovery) and refreshes the view. */
  update(found: CluInfo[]): void {
    this.clus = mergeDiscovery(this.clus, found);
    this.changed.fire(undefined);
  }

  /** Restores CLUs remembered from earlier discoveries (offline until discovered again). */
  restore(list: CluInfo[]): void {
    this.clus = mergeDiscovery(list, []);
    this.changed.fire(undefined);
  }

  /** CLUs / GATEs of the open project: listed and usable without discovery (see mergeProject). */
  setProject(project: ProjectDevice[]): void {
    this.clus = mergeProject(this.clus, project);
    this.changed.fire(undefined);
  }

  /** Changes fields of one known CLU (e.g. keySource after keys changed) and refreshes it. */
  patch(serial: number, fields: Partial<CluInfo>): void {
    const i = this.clus.findIndex((c) => c.serial === serial);
    if (i < 0) return;
    this.clus[i] = { ...this.clus[i], ...fields, serial };
    this.changed.fire(undefined);
  }

  /** Forgets the cached CONFIG.JSON (after refresh modules, key change, ...); reloaded on expand. */
  invalidate(serial: number): void {
    this.configs.delete(serial);
    this.loaded.delete(serial);
    this.changed.fire(undefined);
  }

  clear(): void {
    this.clus = [];
    this.configs.clear();
    this.loaded.clear();
    this.changed.fire(undefined);
  }

  /** CONFIG.JSON view of a CLU, loading it if needed (cached like the Modules node). */
  loadConfigFor(serial: number): Promise<CluConfigView> {
    if (!this.loadConfig) return Promise.reject(new Error("no config loader"));
    return this.loadOnce(serial);
  }

  private loadOnce(serial: number): Promise<CluConfigView> {
    let p = this.configs.get(serial);
    if (!p) {
      p = this.loadConfig!(serial).then((v) => {
        const first = !this.loaded.has(serial);
        this.loaded.set(serial, v);
        if (first) this.changed.fire(undefined); // CLU label gains type + fw
        return v;
      });
      // failed loads are retried on the next expand
      p.catch(() => this.configs.delete(serial));
      this.configs.set(serial, p);
    }
    return p;
  }

  async getChildren(node?: DeviceNode): Promise<DeviceNode[]> {
    if (!node) return this.clus.map((clu) => ({ kind: "clu", clu }));
    switch (node.kind) {
      case "clu": {
        const details: DeviceNode[] = cluDetails(node.clu, l10n.t).map(([label, value]) => ({ kind: "detail", label, value }));
        const cfg = this.loaded.get(node.clu.serial);
        if (cfg) details.push({ kind: "detail", label: l10n.t("Firmware"), value: cfg.status ? l10n.t("{0} (api {1}), status {2}", cfg.fwVer, cfg.fwApiVer, cfg.status) : cfg.fwVer });
        if (this.loadConfig && reachable(node.clu)) details.push({ kind: "modules", serial: node.clu.serial });
        return details;
      }
      case "modules":
        try {
          const cfg = await this.loadOnce(node.serial);
          if (cfg.modules.length === 0) return [{ kind: "message", text: l10n.t("no modules in CONFIG.JSON"), error: false }];
          return cfg.modules.map((module) => ({ kind: "module", serial: node.serial, module }));
        } catch (e) {
          return [{ kind: "message", text: (e as Error).message, error: true }];
        }
      case "module":
        return node.module.ios.map((io) => ({ kind: "io", serial: node.serial, module: node.module, io }));
      case "io": {
        const features: DeviceNode[] = node.io.features
          .filter((f) => f.get)
          .map((feature) => ({ kind: "feature", serial: node.serial, io: node.io, feature }));
        const err = this.live?.error(node.serial);
        return err ? [{ kind: "message", text: `live values: ${err}`, error: true }, ...features] : features;
      }
      default:
        return [];
    }
  }

  /** Needed by TreeView.reveal; only CLU nodes (roots) are revealed. */
  getParent(node: DeviceNode): DeviceNode | undefined {
    if (node.kind === "clu") return undefined;
    const serial = "serial" in node ? node.serial : undefined;
    const clu = this.clus.find((c) => c.serial === serial);
    return clu ? { kind: "clu", clu } : undefined;
  }

  getTreeItem(node: DeviceNode): vscode.TreeItem {
    switch (node.kind) {
      case "detail": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.description = node.value;
        item.tooltip = `${node.label}: ${node.value}`;
        return item;
      }
      case "modules": {
        const cfg = this.loaded.get(node.serial);
        const item = new vscode.TreeItem(l10n.t("Modules"), vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `clu:${node.serial}:modules`;
        const fromProject = this.clus.find((c) => c.serial === node.serial)?.inProject;
        item.description = cfg ? `${cfg.modules.filter((m) => !m.kind).length}` : fromProject ? l10n.t("from the project") : l10n.t("from CONFIG.JSON");
        item.iconPath = new vscode.ThemeIcon("extensions");
        item.contextValue = "modules";
        return item;
      }
      case "module": {
        const m = node.module;
        const item = new vscode.TreeItem(m.name, m.ios.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = m.kind ? `clu:${node.serial}:${m.kind}` : `clu:${node.serial}:mm:${m.serial}`;
        // like OM: what is on the module (its objects' names), not the internal mm_<serial> id
        const named = m.ios.filter((io) => io.name).map((io) => io.name!);
        const status = m.status && m.status !== "OK" ? ` · ${m.status}` : "";
        item.description = `${named.length ? named.slice(0, 3).join(", ") + (named.length > 3 ? ", …" : "") : l10n.t("serial {0}", m.serial)}${status}`;
        if (m.kind) {
          item.description = m.kind === "clu" ? l10n.t("own features") : String(m.ios.length);
          item.tooltip = m.name;
          item.iconPath = new vscode.ThemeIcon(m.kind === "clu" ? "circuit-board" : "symbol-class");
          item.contextValue = "module";
          return item;
        }
        item.tooltip = [
          l10n.t("{0} module, serial {1} ({2})", m.bus === "zwave" ? "Z-Wave" : "TF-Bus", m.serial, `0x${m.serial.toString(16).padStart(8, "0")}`),
          `hw type 0x${m.hwType.toString(16)}${m.fwType !== undefined ? `, fw type 0x${m.fwType.toString(16)}` : ""}, api ${m.fwApiVer}`,
          m.fwVer ? l10n.t("firmware {0}", m.fwVer) : "",
          l10n.t("status {0}", m.status),
        ]
          .filter(Boolean)
          .join("\n");
        item.iconPath = new vscode.ThemeIcon(m.known ? (m.status === "OK" || m.status === "" ? "chip" : "warning") : "question");
        item.contextValue = "module";
        return item;
      }
      case "io": {
        const { io } = node;
        const pollable = ioReads(io).length > 0;
        const item = new vscode.TreeItem(io.name ?? io.label, pollable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = ioNodeId(node.serial, node.module, io);
        item.description = io.objectId
          ? [io.objectId, io.inactive ? l10n.t("inactive") : "", io.name ? io.label : ""].filter(Boolean).join(" · ")
          : l10n.t("class {0} · not in OM.LUA", io.objectClass);
        item.tooltip = [
          io.defaultName,
          l10n.t("object {0}, class {1}, channel {2}", io.objectName, io.objectClass, io.channel),
          io.objectId ? `OM.LUA id ${io.objectId}${io.name ? `, NAME_IO ${io.name}` : ""}` : l10n.t("not declared in the CLU's OM.LUA: no live values"),
        ].join("\n");
        item.iconPath = new vscode.ThemeIcon(io.inactive ? "circle-slash" : "symbol-field");
        item.contextValue = io.objectId ? "io.mapped" : "io";
        return item;
      }
      case "feature": {
        const { feature: f, io } = node;
        const value = io.objectId ? this.live?.value(node.serial, { id: io.objectId, index: f.index }) : undefined;
        const item = new vscode.TreeItem(f.name, vscode.TreeItemCollapsibleState.None);
        item.id = `clu:${node.serial}:${io.objectId}:f${f.index}`;
        const unit = f.unit && f.unit !== "-" ? ` ${f.unit}` : "";
        item.description = value === undefined ? "…" : `${value}${unit}`;
        item.tooltip = [`${io.objectId}:get(${f.index})`, f.type, f.range ? l10n.t("range {0}", f.range) : "", f.set ? l10n.t("settable") : ""].filter(Boolean).join(" · ");
        item.iconPath = new vscode.ThemeIcon(f.set ? "edit" : "eye");
        item.contextValue = f.set ? "feature.set" : "feature";
        return item;
      }
      case "message": {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(node.error ? "error" : "info");
        item.tooltip = node.text;
        return item;
      }
      case "clu": {
        const { clu } = node;
        const cfg = this.loaded.get(clu.serial);
        // like OM: the project name first; the id and address as details
        const item = new vscode.TreeItem(clu.name ?? cluObjectId(clu), vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `clu:${clu.serial}`;
        const type = cfg ? ` · ${cfg.typeName ?? l10n.t("unknown type")} ${cfg.fwVer}` : clu.gate ? " · GATE" : "";
        const where = `${clu.address ?? ""}${clu.name ? ` · ${cluObjectId(clu)}` : ""}`;
        item.description = clu.online || (clu.inProject && !clu.lastSeen) ? `${where}${type}` : l10n.t("{0} (not seen in the last discovery)", where);
        item.tooltip = [clu.name, ...cluDetails(clu, l10n.t).map(([l, v]) => `${l}: ${v}`)].filter(Boolean).join("\n");
        item.iconPath = new vscode.ThemeIcon(reachable(clu) ? (clu.gate ? "server" : "circuit-board") : "debug-disconnect");
        item.contextValue = reachable(clu) ? "clu" : "clu.offline";
        return item;
      }
    }
  }
}
