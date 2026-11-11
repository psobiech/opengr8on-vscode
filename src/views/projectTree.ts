import * as vscode from "vscode";
import { l10n } from "vscode";
import type { CluSource, Located, ObjectSource, ProjectSource } from "../project/load";
import type { Clu } from "../project/model";

/**
 * Like Object Manager: objects by their friendly names (NAME_IO / OM default name), never by module
 * ids (mm_<serial>). Module, channel and object id are shown as details only.
 */
type Node =
  | { kind: "clu"; clu: CluSource }
  | { kind: "group"; clu: CluSource; group: "ios" | "objects" | "scripts"; count: number }
  | { kind: "io"; clu: CluSource; id: string; name: string; detail: string; at: Located; inactive: boolean; events: number }
  | { kind: "object"; clu: CluSource; obj: ObjectSource }
  | { kind: "script"; clu: CluSource; name: string; file: string };

const groupLabel = (g: "ios" | "objects" | "scripts"): string => ({ ios: l10n.t("Objects"), objects: l10n.t("Virtual objects"), scripts: l10n.t("Scripts") })[g];

export class ProjectTreeProvider implements vscode.TreeDataProvider<Node> {
  private project: ProjectSource | undefined;
  private resolved = new Map<string, Clu>();
  private errors = new Map<string, number>();
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly root: () => vscode.Uri | undefined) {}

  /** errorsByFile: diagnostics count per project-relative file; resolved: names incl. OM defaults. */
  update(project: ProjectSource | undefined, errorsByFile: Map<string, number>, resolved: Clu[] = []): void {
    this.project = project;
    this.errors = errorsByFile;
    this.resolved = new Map(resolved.map((c) => [c.name, c]));
    void vscode.commands.executeCommand("setContext", "opengr8on.hasProject", !!project);
    this.changed.fire(undefined);
  }

  private ios(clu: CluSource): Node[] {
    const model = this.resolved.get(clu.name);
    const names = new Map(model?.modules.flatMap((m) => m.ios.map((io) => [io.id, io.name] as const)) ?? []);
    const out: Node[] = [];
    for (const m of clu.modules) {
      for (const io of m.ios) {
        out.push({
          kind: "io",
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
    return out.sort((a, b) => (a.kind === "io" && b.kind === "io" ? a.name.localeCompare(b.name) : 0));
  }

  getChildren(node?: Node): Node[] {
    if (!this.project) return [];
    if (!node) return this.project.clus.map((clu) => ({ kind: "clu", clu }));
    if (node.kind === "clu") {
      const c = node.clu;
      const groups: Node[] = [{ kind: "group", clu: c, group: "ios", count: c.modules.reduce((n, m) => n + m.ios.length, 0) }];
      if (c.objects.length) groups.push({ kind: "group", clu: c, group: "objects", count: c.objects.length });
      groups.push({ kind: "group", clu: c, group: "scripts", count: c.scripts.length }); // always: new scripts go here
      return groups;
    }
    if (node.kind === "group") {
      if (node.group === "ios") return this.ios(node.clu);
      if (node.group === "objects") return node.clu.objects.map((obj) => ({ kind: "object", clu: node.clu, obj }));
      return node.clu.scripts.map((s) => ({ kind: "script", clu: node.clu, name: s.name, file: s.file }));
    }
    return [];
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

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "clu": {
        const c = node.clu;
        const item = new vscode.TreeItem(c.name, vscode.TreeItemCollapsibleState.Collapsed);
        const errs = this.errors.get(c.file) ?? 0;
        item.description = `${c.ip}${errs ? ` · ${l10n.t("{0} problem(s)", errs)}` : ""}`;
        item.tooltip = `${c.name} · ${c.id} · ${c.ip}`;
        item.iconPath = new vscode.ThemeIcon(errs ? "error" : "circuit-board");
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
      case "io": {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
        item.description = [node.inactive ? l10n.t("inactive") : "", node.events ? l10n.t("{0} event(s)", node.events) : ""].filter(Boolean).join(" · ");
        item.tooltip = `${node.name}\n${node.detail}`;
        item.iconPath = new vscode.ThemeIcon(node.inactive ? "circle-slash" : "symbol-field");
        item.command = this.open(node.at);
        return item;
      }
      case "object": {
        const o = node.obj;
        const item = new vscode.TreeItem(o.name, vscode.TreeItemCollapsibleState.None);
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
}
