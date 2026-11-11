import * as vscode from "vscode";
import type { InterfaceRegistry } from "opengr8on-node/client";
import { loadProject, ROOT_FILE, type Diagnostic, type ProjectFiles, type ProjectSource } from "../project/load";
import type { Clu } from "../project/model";
import { resolveProject } from "../project/resolve";

/** ProjectFiles over vscode.workspace.fs (works for remote workspaces too). */
export function workspaceFiles(root: vscode.Uri): ProjectFiles {
  const uri = (p: string) => vscode.Uri.joinPath(root, ...p.split("/"));
  return {
    read: async (p) => {
      // open editors first: validation follows unsaved edits
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri(p).toString());
      if (open) return open.getText();
      try {
        return new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(uri(p)));
      } catch {
        return undefined;
      }
    },
    list: async (dir) => {
      try {
        return (await vscode.workspace.fs.readDirectory(uri(dir))).filter(([, t]) => t === vscode.FileType.File).map(([n]) => n);
      } catch {
        return [];
      }
    },
  };
}

const toVscode = (d: Diagnostic) => {
  const r = new vscode.Range(d.range.start.line, d.range.start.col, d.range.end.line, d.range.end.col);
  const v = new vscode.Diagnostic(r, d.message, d.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
  v.source = "opengr8on";
  return v;
};

/**
 * Loads the project of the first workspace folder containing opengr8on.yaml, publishes diagnostics,
 * and reloads (debounced) when project files change. `current` is the last successfully loaded
 * project (undefined while the root is broken).
 */
export class ProjectWatcher implements vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("opengr8on");
  private readonly disposables: vscode.Disposable[] = [this.diagnostics];
  private readonly changed = new vscode.EventEmitter<ProjectSource | undefined>();
  readonly onDidLoad = this.changed.event;
  private timer: ReturnType<typeof setTimeout> | undefined;
  current: ProjectSource | undefined;
  /** Resolved generator model of `current` (also when it has errors; check errorCount). */
  resolved: Clu[] = [];
  errorCount = 0;
  /** error count per project-relative file */
  errorsByFile = new Map<string, number>();

  constructor(
    readonly root: vscode.Uri,
    private readonly log: vscode.OutputChannel,
    private readonly registry: () => InterfaceRegistry,
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, `{${ROOT_FILE},clus/**,scripts/**}`));
    const schedule = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.reload(), 400);
    };
    // live: also while typing (unsaved editor content), debounced
    const isProjectDoc = (d: vscode.TextDocument) => {
      const rel = d.uri.path.startsWith(root.path + "/") ? d.uri.path.slice(root.path.length + 1) : undefined;
      return rel !== undefined && (rel === ROOT_FILE || rel.startsWith("clus/") || rel.startsWith("scripts/"));
    };
    const onEdit = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length && isProjectDoc(e.document)) schedule();
    });
    const onClose = vscode.workspace.onDidCloseTextDocument((d) => {
      if (isProjectDoc(d)) schedule(); // back to the content on disk
    });
    this.disposables.push(watcher, watcher.onDidChange(schedule), watcher.onDidCreate(schedule), watcher.onDidDelete(schedule), onEdit, onClose, this.changed);
  }

  async reload(): Promise<ProjectSource | undefined> {
    const loaded = await loadProject(workspaceFiles(this.root), vscode.l10n.t);
    const { project } = loaded;
    const diagnostics = [...loaded.diagnostics];
    this.resolved = [];
    if (project) {
      try {
        const r = resolveProject(project, this.registry(), vscode.l10n.t);
        diagnostics.push(...r.diagnostics);
        this.resolved = r.clus;
      } catch (e) {
        diagnostics.push({ file: ROOT_FILE, range: { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }, severity: "error", message: vscode.l10n.t("resolve failed: {0}", (e as Error).message) });
      }
    }
    this.diagnostics.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const d of diagnostics) byFile.set(d.file, [...(byFile.get(d.file) ?? []), toVscode(d)]);
    for (const [file, list] of byFile) this.diagnostics.set(vscode.Uri.joinPath(this.root, ...file.split("/")), list);
    this.errorCount = diagnostics.filter((d) => d.severity === "error").length;
    this.errorsByFile = new Map();
    for (const d of diagnostics) if (d.severity === "error") this.errorsByFile.set(d.file, (this.errorsByFile.get(d.file) ?? 0) + 1);
    this.current = project;
    this.log.appendLine(`project: ${project ? `${project.name}, ${project.clus.length} CLU(s)` : "not loaded"}, ${this.errorCount} error(s)`);
    this.changed.fire(project);
    return project;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}

/** First workspace folder that holds opengr8on.yaml. */
export async function findProjectRoot(): Promise<vscode.Uri | undefined> {
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(f.uri, ROOT_FILE));
      return f.uri;
    } catch {
      /* not this one */
    }
  }
  return undefined;
}
