import { GATE_HW_TYPE } from "../generator/omLua";
import * as vscode from "vscode";
import { l10n } from "vscode";
import { cluDetails, type CluInfo } from "../device/cluInfo";
import type { IoView } from "../device/cluConfig";
import type { CluSource, Located, ObjectSource, ProjectSource } from "../project/load";
import type { Clu } from "../project/model";
import type { DeviceNode, DevicesTreeProvider } from "./devicesTree";

/**
 * Like Object Manager: objects by their friendly names (NAME_IO / OM default name), never by module
 * ids (mm_<serial>). Module, channel and object id are shown as details only.
 *
 * With a Devices provider attached, each project CLU also gets the live part of the Devices view
 * (Device details, Modules → IOs → values, set / execute), and the project's objects expand into
 * their live values. Device rows are DeviceNodes as-is, so the CLU commands accept them unchanged.
 */
type ProjectNode =
  | { kind: "projectClu"; clu: CluSource }
  | { kind: "group"; clu: CluSource; group: "ios" | "objects" | "scripts"; count: number }
  | { kind: "device"; clu: CluSource }
  | { kind: "projectIo"; clu: CluSource; id: string; name: string; detail: string; at: Located; inactive: boolean; events: number }
  | { kind: "object"; clu: CluSource; obj: ObjectSource }
  | { kind: "script"; clu: CluSource; name: string; file: string };

/** A live row (from the Devices provider); `via` keeps ids unique when one IO shows twice. */
type LiveNode = DeviceNode & { via?: string };
export type ProjectTreeNode = ProjectNode | LiveNode;

/** Live part of the project view (the Devices provider + what it knows about each CLU). */
export interface ProjectLive {
  devices: DevicesTreeProvider;
  /** A project object row is expanded: watch its values under `owner` (see liveOwner). */
  onIoShown?(serial: number, owner: string, io: IoView): void;
}

/** LivePoller watch owner of a project object row (unwatched on collapse, by prefix per CLU). */
export const liveOwner = (serial: number, id: string) => `project:${serial}:${id}`;

const groupLabel = (g: "ios" | "objects" | "scripts"): string => ({ ios: l10n.t("Objects"), objects: l10n.t("Virtual objects"), scripts: l10n.t("Scripts") })[g];
const isProjectNode = (n: ProjectTreeNode): n is ProjectNode => ["projectClu", "group", "device", "projectIo", "object", "script"].includes(n.kind);

export class ProjectTreeProvider implements vscode.TreeDataProvider<ProjectTreeNode> {
  private project: ProjectSource | undefined;
  private resolved = new Map<string, Clu>();
  private errors = new Map<string, number>();
  private readonly changed = new vscode.EventEmitter<ProjectTreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly root: () => vscode.Uri | undefined,
    private readonly live?: ProjectLive,
  ) {
    // live values / online state changed (already throttled by the Devices provider)
    if (live) live.devices.onDidChangeTreeData(() => this.changed.fire(undefined));
  }

  /** errorsByFile: diagnostics count per project-relative file; resolved: names incl. OM defaults. */
  update(project: ProjectSource | undefined, errorsByFile: Map<string, number>, resolved: Clu[] = []): void {
    this.project = project;
    this.errors = errorsByFile;
    this.resolved = new Map(resolved.map((c) => [c.name, c]));
    void vscode.commands.executeCommand("setContext", "opengr8on.hasProject", !!project);
    this.changed.fire(undefined);
  }

  /** Root row of a project CLU by serial (for TreeView.reveal). */
  cluNode(serial: number): ProjectTreeNode | undefined {
    const clu = this.project?.clus.find((c) => c.serial === serial);
    return clu ? { kind: "projectClu", clu } : undefined;
  }

  private info(clu: CluSource): CluInfo | undefined {
    return this.live?.devices.all.find((c) => c.serial === clu.serial);
  }

  private ios(clu: CluSource): ProjectNode[] {
    const model = this.resolved.get(clu.name);
    const names = new Map(model?.modules.flatMap((m) => m.ios.map((io) => [io.id, io.name] as const)) ?? []);
    const out: ProjectNode[] = [];
    for (const m of clu.modules) {
      for (const io of m.ios) {
        out.push({
          kind: "projectIo",
          clu,
          id: io.id,
          name: io.name ?? names.get(io.id) ?? io.id,
          detail: l10n.t("{0} · class {1} · module {2} channel {3}", io.id, io.objectClass, m.serial, io.channel),
          at: io.at,
          inactive: io.inactive,
          events: io.events.length,
        });
      }
    }
    return out.sort((a, b) => (a.kind === "projectIo" && b.kind === "projectIo" ? a.name.localeCompare(b.name) : 0));
  }

  /** Live values of a project object (by OM.LUA id), from the CLU's config view. */
  private async liveFeatures(clu: CluSource, id: string): Promise<ProjectTreeNode[]> {
    const devices = this.live!.devices;
    try {
      const cfg = await devices.loadConfigFor(clu.serial);
      const io = cfg.modules.flatMap((m) => m.ios).find((x) => x.objectId === id);
      if (!io) return [];
      const owner = liveOwner(clu.serial, id);
      this.live!.onIoShown?.(clu.serial, owner, io);
      const module = cfg.modules.find((m) => m.ios.includes(io))!;
      return (await devices.getChildren({ kind: "io", serial: clu.serial, module, io })).map((n) => ({ ...n, via: owner }));
    } catch (e) {
      return [{ kind: "message", text: (e as Error).message, error: true }];
    }
  }

  async getChildren(node?: ProjectTreeNode): Promise<ProjectTreeNode[]> {
    if (!this.project) return [];
    if (!node) return this.project.clus.map((clu) => ({ kind: "projectClu", clu }));
    if (!isProjectNode(node)) {
      if (!this.live) return [];
      const via = node.via;
      return (await this.live.devices.getChildren(node)).map((n) => (via ? { ...n, via } : n));
    }
    switch (node.kind) {
      case "projectClu": {
        const c = node.clu;
        const groups: ProjectTreeNode[] = [{ kind: "group", clu: c, group: "ios", count: c.modules.reduce((n, m) => n + m.ios.length, 0) }];
        groups.push({ kind: "group", clu: c, group: "objects", count: c.objects.length }); // always: new objects go here
        groups.push({ kind: "group", clu: c, group: "scripts", count: c.scripts.length }); // always: new scripts go here
        if (this.live) {
          groups.push({ kind: "modules", serial: c.serial }); // same as Devices: modules → IOs → live values
          if (this.info(c)) groups.push({ kind: "device", clu: c });
        }
        return groups;
      }
      case "group":
        if (node.group === "ios") return this.ios(node.clu);
        if (node.group === "objects") return node.clu.objects.map((obj) => ({ kind: "object", clu: node.clu, obj }));
        return node.clu.scripts.map((s) => ({ kind: "script", clu: node.clu, name: s.name, file: s.file }));
      case "device": {
        const info = this.info(node.clu);
        if (!info || !this.live) return [];
        return (await this.live.devices.getChildren({ kind: "clu", clu: info })).filter((n) => n.kind === "detail");
      }
      case "projectIo":
        return this.live ? this.liveFeatures(node.clu, node.id) : [];
      case "object":
        return this.live && !node.obj.removed ? this.liveFeatures(node.clu, node.obj.id) : [];
      default:
        return [];
    }
  }

  /** Needed by TreeView.reveal; only CLU rows (roots) are revealed. */
  getParent(): ProjectTreeNode | undefined {
    return undefined;
  }

  private open(at: Located): vscode.Command | undefined {
    const root = this.root();
    if (!root) return undefined;
    const r = at.range;
    return {
      command: "vscode.open",
      title: "Open",
      arguments: [vscode.Uri.joinPath(root, ...at.file.split("/")), { selection: new vscode.Range(r.start.line, r.start.col, r.start.line, r.start.col) }],
    };
  }

  getTreeItem(node: ProjectTreeNode): vscode.TreeItem {
    if (!isProjectNode(node)) {
      const item = this.live!.devices.getTreeItem(node);
      // ids are per view: prefix them (the same IO may show under Modules and under Objects)
      if (item.id) item.id = `project:${node.via ?? "m"}:${item.id}`;
      return item;
    }
    const expandable = this.live ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
    switch (node.kind) {
      case "projectClu": {
        const c = node.clu;
        const info = this.info(c);
        const cfg = this.live?.devices.config(c.serial);
        const item = new vscode.TreeItem(c.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `project:${c.serial}`;
        const errs = this.errors.get(c.file) ?? 0;
        const state = info && !info.online && info.lastSeen ? ` · ${l10n.t("offline")}` : "";
        const fw = cfg?.mac && cfg.typeName ? ` · ${cfg.typeName} ${cfg.fwVer}` : "";
        item.description = `${c.ip}${fw}${state}${errs ? ` · ${l10n.t("{0} problem(s)", errs)}` : ""}`;
        item.tooltip = [`${c.name} · ${c.id} · ${c.ip}`, ...(info ? cluDetails(info, l10n.t).map(([l, v]) => `${l}: ${v}`) : [])].join("\n");
        // same icons as the Devices view: GATE (hw type 0x12) a server, CLU a circuit board
        item.iconPath = new vscode.ThemeIcon(errs ? "error" : state ? "debug-disconnect" : c.hw.type === GATE_HW_TYPE ? "server" : "circuit-board");
        item.contextValue = "projectClu";
        item.command = this.open(c.at);
        return item;
      }
      case "group": {
        const item = new vscode.TreeItem(groupLabel(node.group), node.count ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = `${node.clu.name}:${node.group}`;
        item.description = String(node.count);
        item.iconPath = new vscode.ThemeIcon(node.group === "scripts" ? "symbol-function" : node.group === "objects" ? "symbol-class" : "symbol-field");
        item.contextValue = `group.${node.group}`;
        return item;
      }
      case "device": {
        const item = new vscode.TreeItem(l10n.t("Device"), vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `${node.clu.name}:device`;
        item.description = this.info(node.clu)?.address ?? undefined;
        item.iconPath = new vscode.ThemeIcon("info");
        return item;
      }
      case "projectIo": {
        const item = new vscode.TreeItem(node.name, expandable);
        item.id = `${node.clu.name}:io:${node.id}`;
        item.description = [node.inactive ? l10n.t("inactive") : "", node.events ? l10n.t("{0} event(s)", node.events) : ""].filter(Boolean).join(" · ");
        item.tooltip = `${node.name}\n${node.detail}`;
        item.iconPath = new vscode.ThemeIcon(node.inactive ? "circle-slash" : "symbol-field");
        item.command = this.open(node.at);
        // set / execute like a mapped IO in the Devices view (resolved via liveIo)
        if (this.live) item.contextValue = "projectIo";
        return item;
      }
      case "object": {
        const o = node.obj;
        const item = new vscode.TreeItem(o.name, o.removed ? vscode.TreeItemCollapsibleState.None : expandable);
        item.id = `${node.clu.name}:obj:${o.id}`;
        item.description = [o.objectClass, o.removed ? l10n.t("removed") : "", o.events.length ? l10n.t("{0} event(s)", o.events.length) : ""].filter(Boolean).join(" · ");
        item.tooltip = `${o.name}\n${o.id} · ${o.objectClass}${o.version !== undefined ? ` v${o.version}` : ""}`;
        item.iconPath = new vscode.ThemeIcon(o.removed ? "circle-slash" : "symbol-class");
        item.contextValue = "projectObject";
        item.command = this.open(o.at);
        return item;
      }
      case "script": {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("symbol-function");
        item.contextValue = "projectScript";
        const root = this.root();
        if (root) item.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.joinPath(root, ...node.file.split("/"))] };
        return item;
      }
    }
  }

  /**
   * The live IO behind a project object row ({ serial, io } like a Devices IO node), for Execute
   * Method on project rows. undefined when the CLU's config has no such object.
   */
  async liveIo(node: ProjectTreeNode): Promise<{ serial: number; io: IoView } | undefined> {
    if (!this.live || (node.kind !== "projectIo" && node.kind !== "object")) return undefined;
    const id = node.kind === "projectIo" ? node.id : node.obj.id;
    const cfg = await this.live.devices.loadConfigFor(node.clu.serial);
    const io = cfg.modules.flatMap((m) => m.ios).find((x) => x.objectId === id);
    return io ? { serial: node.clu.serial, io } : undefined;
  }
}
