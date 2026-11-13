import * as vscode from "vscode";
import { l10n } from "vscode";
import { CLUDevice, CLUFiles } from "opengr8on-node/client";
import type { CluRunner } from "../device/cluRunner";
import { emitMainLua, emitOmLua, emitUserLua } from "../generator/omLua";
import { readOmpProject, readProjectCipherKey, type InterfaceRegistry } from "opengr8on-node/client";
import type { KeyStore } from "../device/keyStore";
import { importOmp } from "../project/fromOmp";
import type { CluConfigView } from "../device/cluConfig";
import type { Clu } from "../project/model";
import { parseOmLua } from "../project/omLuaParse";
import { skeletonFromConfig } from "../project/skeleton";
import { cluToYaml } from "../project/toYaml";
import { buildIndex } from "../project/assist";
import { LUA_IDENTIFIER, addObjectToCluYaml, addScriptToCluYaml, removeFromCluYaml, scriptTemplate } from "../project/edit";
import { allocateId } from "../project/skeleton";
import { findUsages } from "../project/remove";
import { friendlyAction } from "../project/friendly";
import { parseUserLua } from "../project/userLuaParse";
import { findProjectRoot, type ProjectWatcher } from "./projectWatcher";

/** OM writes UTF-8 (observed: Polish characters in a script, OM 1.13.1). */
export function encodeOmFile(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

/** Line endings of generated files: OM writes its platform's (Windows CRLF, Linux LF). */
export type Eol = "\r\n" | "\n";

export function buildFiles(clu: Clu, eol: Eol = "\r\n"): { om: Buffer; user: Buffer; main: Buffer } {
  return { om: encodeOmFile(emitOmLua(clu, { eol })), user: encodeOmFile(emitUserLua(clu, { eol })), main: encodeOmFile(emitMainLua(clu, { eol })) };
}

export interface ProjectCommandDeps {
  log: vscode.OutputChannel;
  runner: CluRunner;
  /** Reloads + resolves; undefined (after telling the user) when the project has errors. */
  resolvedProject(): Promise<{ watcher: ProjectWatcher; clus: Clu[] } | undefined>;
  /** Device of the last discovery, if any. */
  discovered(serial: number): CLUDevice | undefined;
  localAddress(): string;
  selectedSerial(): number | undefined;
  registry(): InterfaceRegistry;
  /** configured line endings (opengr8on.generate.lineEndings) */
  eol(): Eol;
  /** Current project watcher (after New Project / activation), if any. */
  project(): Promise<ProjectWatcher | undefined>;
  loadConfig(serial: number): Promise<CluConfigView>;
  keys: KeyStore;
  /** Runs a Lua expression on a CLU (`req:`), via the runner queue. */
  execute(serial: number, script: string): Promise<string>;
  /** Files were (maybe partly) uploaded to a CLU: drop views cached from its old OM.LUA / CONFIG.JSON. */
  uploaded(serial: number): void;
}

/** CLU name from a script path inside the project (scripts/<CLU>/<file>.lua). */
export function cluOfScript(relPath: string): string | undefined {
  return /^scripts\/([^/]+)\/[^/]+\.lua$/.exec(relPath.replace(/\\/g, "/"))?.[1];
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GITIGNORE = "build/\n.opengr8on/\n*.omp\n";

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

const serialOf = (clu: Clu) => Number(/^CLU(\d+)$/.exec(clu.id)?.[1] ?? NaN);

const DIFF_SCHEME = "opengr8on-diff";

export function registerProjectCommands(context: vscode.ExtensionContext, deps: ProjectCommandDeps): void {
  const enc = (t: string) => Buffer.from(t, "utf8");
  const diffDocs = new Map<string, string>();
  const diffChanged = new vscode.EventEmitter<vscode.Uri>();
  context.subscriptions.push(
    diffChanged,
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, {
      onDidChange: diffChanged.event,
      provideTextDocumentContent: (uri) => diffDocs.get(uri.toString()) ?? "",
    }),
  );
  const diffDoc = (path: string, content: Buffer) => {
    const uri = vscode.Uri.from({ scheme: DIFF_SCHEME, path });
    diffDocs.set(uri.toString(), content.toString("utf8"));
    diffChanged.fire(uri);
    return uri;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("opengr8on.newProject", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        void vscode.window.showErrorMessage(l10n.t("OpenGr8on: open a folder first."));
        return;
      }
      if (await findProjectRoot()) {
        void vscode.window.showInformationMessage(l10n.t("OpenGr8on: this workspace already has an opengr8on.yaml."));
        return;
      }
      const name = await vscode.window.showInputBox({ title: l10n.t("OpenGr8on: project name"), value: folder.name });
      if (!name) return;
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder.uri, "opengr8on.yaml"), enc(`format: 1\nname: ${JSON.stringify(name)}\n`));
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, "clus"));
      const gi = vscode.Uri.joinPath(folder.uri, ".gitignore");
      if (!(await exists(gi))) await vscode.workspace.fs.writeFile(gi, enc(GITIGNORE));
      deps.log.appendLine(`new project ${name} in ${folder.uri.fsPath}`);
      void vscode.window.showInformationMessage(l10n.t("OpenGr8on: project created. Import CLUs from the Devices view (right click → Import into Project)."));
      await deps.project();
    }),

    vscode.commands.registerCommand("opengr8on.newScript", async (node?: { clu?: { name: string; file: string; scripts: Array<{ name: string }> } }) => {
      const watcher = await deps.project();
      if (!watcher?.current) {
        void vscode.window.showErrorMessage(l10n.t("OpenGr8on: no project loaded."));
        return;
      }
      let clu = node?.clu ? watcher.current.clus.find((c) => c.name === node.clu!.name) : undefined;
      if (!clu) {
        const pick = await vscode.window.showQuickPick(watcher.current.clus.map((c) => ({ label: c.name, c })), { title: l10n.t("OpenGr8on: new script for which CLU?") });
        if (!pick) return;
        clu = pick.c;
      }
      const target = clu;
      const name = await vscode.window.showInputBox({
        title: l10n.t("New script on {0}", target.name),
        prompt: l10n.t("Script name (function name on the CLU): letters, digits, _"),
        validateInput: (v) =>
          !LUA_IDENTIFIER.test(v) ? l10n.t("letters, digits and _; not starting with a digit") : target.scripts.some((x) => x.name === v) ? l10n.t("{0} already exists on {1}", v, target.name) : undefined,
      });
      if (!name) return;
      if (target.scripts.length >= 1) {
        const create = l10n.t("Create");
        const ok = await vscode.window.showWarningMessage(
          l10n.t(
            "{0} already has a script. Generation supports one script per CLU for now (the USER.LUA layout for several scripts is not known yet), so the project will show an error until one is removed. Create anyway?",
            target.name,
          ),
          { modal: true },
          create,
        );
        if (ok !== create) return;
      }
      try {
        const yamlUri = vscode.Uri.joinPath(watcher.root, ...target.file.split("/"));
        const yaml = new TextDecoder().decode(await vscode.workspace.fs.readFile(yamlUri));
        const scriptUri = vscode.Uri.joinPath(watcher.root, "scripts", target.name, `${name}.lua`);
        if (await exists(scriptUri)) throw new Error(l10n.t("scripts/{0}/{1}.lua already exists", target.name, name));
        await vscode.workspace.fs.writeFile(yamlUri, enc(addScriptToCluYaml(yaml, name)));
        await vscode.workspace.fs.writeFile(scriptUri, enc(scriptTemplate(target.name, name)));
        await watcher.reload();
        const doc = await vscode.window.showTextDocument(scriptUri);
        const end = doc.document.lineCount - 1;
        doc.selection = new vscode.Selection(end, 0, end, 0);
        deps.log.appendLine(`new script ${target.name}/${name}`);
      } catch (e) {
        void vscode.window.showErrorMessage(`OpenGr8on: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("opengr8on.newObject", async (node?: { clu?: { name: string } }) => {
      const watcher = await deps.project();
      if (!watcher?.current) {
        void vscode.window.showErrorMessage(l10n.t("OpenGr8on: no project loaded."));
        return;
      }
      let clu = node?.clu ? watcher.current.clus.find((c) => c.name === node.clu!.name) : undefined;
      if (!clu) {
        const pick = await vscode.window.showQuickPick(watcher.current.clus.map((c) => ({ label: c.name, c })), { title: l10n.t("OpenGr8on: new virtual object on which CLU?") });
        if (!pick) return;
        clu = pick.c;
      }
      const target = clu;
      const registry = deps.registry();
      // the object types this CLU's interface lists (name + version), else every known one
      const all = registry.allObjects();
      const supported = registry.getCLU(target.hw.type, target.hw.version, target.fw.type, target.fw.version)?.objects;
      const types = (supported ? all.filter((o) => supported.some((s) => s.name === o.name && Number(s.version) === Number(o.version))) : all)
        .filter((o, i, list) => list.findIndex((x) => x.name === o.name && x.version === o.version) === i)
        .sort((a, b) => a.name.localeCompare(b.name));
      if (types.length === 0) {
        void vscode.window.showErrorMessage(l10n.t("OpenGr8on: no virtual object types known for {0}.", target.name));
        return;
      }
      const type = await vscode.window.showQuickPick(
        types.map((o) => ({ label: o.name, description: l10n.t("class {0}, version {1}", o.class, o.version), o })),
        { title: l10n.t("New virtual object on {0}", target.name), matchOnDescription: true },
      );
      if (!type) return;
      const names = new Set([...target.objects.map((o) => o.name), ...target.modules.flatMap((m) => m.ios.map((io) => io.name).filter((n): n is string => !!n))]);
      const name = await vscode.window.showInputBox({
        title: l10n.t("New {0} on {1}", type.o.name, target.name),
        prompt: l10n.t("Object name (NAME_PERIPHERY): letters, digits, _"),
        validateInput: (v) => (!LUA_IDENTIFIER.test(v) ? l10n.t("letters, digits and _; not starting with a digit") : names.has(v) ? l10n.t("{0} already exists on {1}", v, target.name) : undefined),
      });
      if (!name) return;
      try {
        const yamlUri = vscode.Uri.joinPath(watcher.root, ...target.file.split("/"));
        if (vscode.workspace.textDocuments.some((d) => d.isDirty && d.uri.toString() === yamlUri.toString())) throw new Error(l10n.t("save {0} first", target.file));
        const taken = new Set([target.id, ...target.objects.map((o) => o.id), ...target.modules.flatMap((m) => m.ios.map((io) => io.id))]);
        const id = allocateId(type.o.name, taken);
        // version only when the class has several interface versions (Timer v1 / GATE Timer v2, ...)
        const versions = all.filter((o) => o.class === type.o.class).length;
        const yaml = new TextDecoder().decode(await vscode.workspace.fs.readFile(yamlUri));
        const next = addObjectToCluYaml(yaml, { id, className: type.o.name, version: versions > 1 ? Number(type.o.version) : undefined, name });
        await vscode.workspace.fs.writeFile(yamlUri, enc(next));
        await watcher.reload();
        const line = next.split(/\r?\n/).findIndex((l) => l.includes(id));
        await vscode.window.showTextDocument(yamlUri, { selection: line >= 0 ? new vscode.Range(line, 0, line, 0) : undefined });
        deps.log.appendLine(`new virtual object ${target.name}/${name} (${type.o.name} v${type.o.version}, ${id})`);
      } catch (e) {
        void vscode.window.showErrorMessage(`OpenGr8on: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("opengr8on.deleteItem", async (node?: { kind: string; clu?: { name: string }; obj?: { name: string }; name?: string }) => {
      const watcher = await deps.project();
      if (!watcher?.current || !node?.clu || (node.kind !== "object" && node.kind !== "script")) return;
      const kind = node.kind;
      const name = kind === "object" ? node.obj?.name : node.name;
      const clu = watcher.current.clus.find((c) => c.name === node.clu!.name);
      if (!name || !clu) return;
      const yamlUri = vscode.Uri.joinPath(watcher.root, ...clu.file.split("/"));
      try {
        // the check runs on what the editors show; the edit below goes to disk
        const unsaved = vscode.workspace.textDocuments.find((d) => d.isDirty && d.uri.toString() === yamlUri.toString());
        if (unsaved) throw new Error(l10n.t("save {0} first", clu.file));
        const usages = findUsages(watcher.current, deps.registry(), { clu: clu.name, kind, name });
        // show the referring source line (open editors first: the check followed unsaved edits)
        const lines = new Map<string, string[]>();
        for (const u of usages) {
          if (!lines.has(u.file)) {
            const uri = vscode.Uri.joinPath(watcher.root, ...u.file.split("/"));
            const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
            lines.set(u.file, (open?.getText() ?? new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))).split(/\r?\n/));
          }
          u.text = lines.get(u.file)?.[u.line]?.trim() || u.text;
        }
        if (usages.length) {
          const show = l10n.t("Show Usages");
          const more = usages.length > 12 ? `\n…` : "";
          const pick = await vscode.window.showWarningMessage(
            l10n.t("{0} is still used in {1} place(s). Remove those uses first.", name, usages.length),
            { modal: true, detail: usages.slice(0, 12).map((u) => `${u.file}:${u.line + 1}  ${u.text}`).join("\n") + more },
            show,
          );
          if (pick !== show) return;
          const go = await vscode.window.showQuickPick(
            usages.map((u) => ({ label: `${u.file}:${u.line + 1}`, detail: u.text, u })),
            { title: l10n.t("Usages of {0}", name), matchOnDetail: true },
          );
          if (go) {
            const at = new vscode.Range(go.u.line, go.u.col, go.u.line, go.u.col);
            await vscode.window.showTextDocument(vscode.Uri.joinPath(watcher.root, ...go.u.file.split("/")), { selection: at });
          }
          return;
        }
        const script = kind === "script" ? clu.scripts.find((s) => s.name === name) : undefined;
        const del = l10n.t("Delete");
        const ok = await vscode.window.showWarningMessage(
          script ? l10n.t("Delete script {0} from {1}?", name, clu.name) : l10n.t("Delete virtual object {0} from {1}?", name, clu.name),
          { modal: true, detail: script ? l10n.t("Nothing in the project uses it. {0} is moved to the trash.", script.file) : l10n.t("Nothing in the project uses it.") },
          del,
        );
        if (ok !== del) return;
        const yaml = new TextDecoder().decode(await vscode.workspace.fs.readFile(yamlUri));
        await vscode.workspace.fs.writeFile(yamlUri, enc(removeFromCluYaml(yaml, kind === "object" ? "objects" : "scripts", name)));
        if (script) {
          const file = vscode.Uri.joinPath(watcher.root, ...script.file.split("/"));
          try {
            await vscode.workspace.fs.delete(file, { useTrash: true });
          } catch {
            await vscode.workspace.fs.delete(file, { useTrash: false });
          }
        }
        await watcher.reload();
        deps.log.appendLine(`deleted ${kind} ${clu.name}/${name}`);
      } catch (e) {
        void vscode.window.showErrorMessage(`OpenGr8on: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("opengr8on.runSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const sel = editor.selection;
      const code = (sel.isEmpty ? editor.document.lineAt(sel.active.line).text : editor.document.getText(sel)).trim();
      if (!code) return;
      const watcher = await deps.project();
      const rel = watcher ? vscode.workspace.asRelativePath(editor.document.uri, false) : "";
      const byFolder = cluOfScript(rel);
      const clu = byFolder ? watcher?.resolved.find((c) => c.name === byFolder) : undefined;
      const serial = clu ? serialOf(clu) : deps.selectedSerial();
      if (serial === undefined || Number.isNaN(serial)) {
        void vscode.window.showErrorMessage(l10n.t("OpenGr8on: no target CLU (open a script under scripts/<CLU>/ or select a CLU in the status bar)."));
        return;
      }
      try {
        const answer = await deps.execute(serial, code.replace(/\r?\n/g, " "));
        deps.log.appendLine(`CLU${serial} > ${code}\n${answer}`);
        vscode.window.setStatusBarMessage(`CLU${serial}: ${answer}`, 8000);
      } catch (e) {
        void vscode.window.showErrorMessage(`OpenGr8on: CLU${serial}: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("opengr8on.importOmp", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        void vscode.window.showErrorMessage(l10n.t("OpenGr8on: open the (empty) project folder first."));
        return;
      }
      const picked = await vscode.window.showOpenDialog({ title: l10n.t("OpenGr8on: import Object Manager project"), canSelectMany: false, filters: { [l10n.t("Object Manager project")]: ["omp"] } });
      if (!picked?.[0]) return;
      try {
        const bytes = Buffer.from(await vscode.workspace.fs.readFile(picked[0]));
        const omp = readOmpProject(bytes);
        const imported = importOmp(omp, deps.registry());
        const existing: string[] = [];
        for (const p of imported.files.keys()) if (await exists(vscode.Uri.joinPath(folder.uri, ...p.split("/")))) existing.push(p);
        if (existing.length) {
          const overwrite = l10n.t("Overwrite");
          const ok = await vscode.window.showWarningMessage(
            l10n.t("Overwrite {0} existing file(s)?", existing.length),
            { modal: true, detail: existing.slice(0, 15).join("\n") + (existing.length > 15 ? "\n…" : "") },
            overwrite,
          );
          if (ok !== overwrite) return;
        }
        for (const [p, content] of imported.files) await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder.uri, ...p.split("/")), enc(content));
        const gi = vscode.Uri.joinPath(folder.uri, ".gitignore");
        if (!(await exists(gi))) await vscode.workspace.fs.writeFile(gi, enc(GITIGNORE));

        // Project cipher key → SecretStorage only (never into project files).
        let keyStored = false;
        if (picked[0].scheme === "file") {
          try {
            await deps.keys.setProjectKey(folder.uri.toString(), readProjectCipherKey(picked[0].fsPath));
            keyStored = true;
          } catch {
            /* not stored */
          }
        }
        const clus = [...imported.files.keys()].filter((p) => p.startsWith("clus/")).length;
        deps.log.appendLine(`import ${picked[0].fsPath}: ${clus} CLU file(s); project key ${keyStored ? "stored" : "not found"}`);
        for (const n of imported.notes) deps.log.appendLine(`import note: ${n}`);
        await deps.project();
        const keyNote = keyStored ? l10n.t("project key stored in VS Code secret storage") : l10n.t("project key not found in the .omp");
        const notes = imported.notes.length ? ` ${l10n.t("{0} note(s) in the output.", imported.notes.length)}` : "";
        void vscode.window.showInformationMessage(l10n.t("OpenGr8on: imported {0} CLU(s) from {1}; {2}.", clus, picked[0].path.split("/").pop() ?? "", keyNote) + notes);
      } catch (e) {
        void vscode.window.showErrorMessage(l10n.t("OpenGr8on: .omp import failed: {0}", (e as Error).message));
      }
    }),

    vscode.commands.registerCommand("opengr8on.importFromClu", async (node?: { clu?: { serial: number; address: string | null } }) => {
      const serial = node?.clu?.serial;
      if (serial === undefined) return;
      const watcher = await deps.project();
      if (!watcher) {
        const newProject = l10n.t("New Project");
        const go = await vscode.window.showErrorMessage(l10n.t("OpenGr8on: no project in this workspace."), newProject);
        if (go) await vscode.commands.executeCommand("opengr8on.newProject");
        return;
      }
      const device = deps.discovered(serial);
      if (!device) {
        void vscode.window.showErrorMessage(l10n.t("OpenGr8on: CLU{0} not found in the last discovery; run Discover CLUs.", serial));
        return;
      }
      try {
        const local = deps.localAddress();
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: l10n.t("OpenGr8on: reading CLU{0}…", serial) }, async () => {
          const om = await deps.runner.download(local, device, CLUFiles.OM_LUA);
          const user = om ? await deps.runner.download(local, device, CLUFiles.USER_LUA) : null;
          return { om, user };
        });
        const registry = deps.registry();
        const taken = new Set((watcher.current?.clus ?? []).flatMap((c) => c.modules.flatMap((m) => m.ios.map((io) => io.id))));
        let clu: Clu;
        const notes: string[] = [];
        let rawUser: Buffer | undefined;
        if (result.om && result.om.length > 0) {
          clu = parseOmLua(result.om.toString("utf8")).clu;
          if (result.user) {
            try {
              clu.scripts = parseUserLua(result.user.toString("utf8")).scripts;
            } catch (e) {
              rawUser = result.user;
              notes.push(`USER.LUA kept raw (${(e as Error).message})`);
            }
          }
        } else {
          const cfg = await deps.loadConfig(serial);
          const sk = skeletonFromConfig(cfg, { name: `CLU_${serial}`, ip: device.address ?? "0.0.0.0", taken });
          clu = sk.clu;
          notes.push("no OM.LUA on the CLU: skeleton from CONFIG.JSON with new object ids");
          if (sk.skipped.length) notes.push(`skipped (no interface XML): ${sk.skipped.join(", ")}`);
        }

        let name = NAME.test(clu.name) ? clu.name : clu.name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1");
        name = (await vscode.window.showInputBox({ title: l10n.t("CLU{0}: name in the project", serial), value: name, validateInput: (v) => (NAME.test(v) ? undefined : l10n.t("letters, digits and _")) })) ?? "";
        if (!name) return;
        clu.name = name;
        const clash = (watcher.current?.clus ?? []).flatMap((c) => c.modules.flatMap((m) => m.ios.map((io) => io.id))).filter((id) => clu.modules.some((m) => m.ios.some((io) => io.id === id)));
        const projectClus = new Map((watcher.current?.clus ?? []).filter((c) => c.name !== name).map((c) => [c.id, c.name]));

        const file = vscode.Uri.joinPath(watcher.root, "clus", `${name}.yaml`);
        if (await exists(file)) {
          const overwrite = l10n.t("Overwrite");
          const ok = await vscode.window.showWarningMessage(l10n.t("clus/{0}.yaml exists. Overwrite it?", name), { modal: true }, overwrite);
          if (ok !== "Overwrite") return;
        }
        // actions as friendly OM actions (CLU->NAME->Method(args)) where they compile back identically
        const index = buildIndex([...(watcher.resolved ?? []).filter((c) => c.name !== name), clu], registry);
        let raw = 0;
        const yaml = cluToYaml(clu, registry, {
          projectClus,
          friendly: (line) => friendlyAction(index, name, line) ?? (raw++, undefined),
        });
        if (raw) notes.push(`${raw} action(s) kept as { lua: ... } (target CLU not in the project, or no interface for the object)`);
        await vscode.workspace.fs.writeFile(file, enc(yaml));
        for (const s of clu.scripts) await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(watcher.root, "scripts", name, `${s.name}.lua`), enc(s.source));
        if (rawUser) await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(watcher.root, "scripts", name, "USER.LUA.imported"), rawUser);
        if (clash.length) notes.push(`object ids also used on other CLUs: ${clash.join(", ")} (allowed, ids are per CLU)`);
        for (const n of notes) deps.log.appendLine(`import CLU${serial}: ${n}`);
        await watcher.reload();
        await vscode.window.showTextDocument(file);
        void vscode.window.showInformationMessage(l10n.t("OpenGr8on: imported CLU{0} as clus/{1}.yaml.", serial, name) + (notes.length ? ` ${l10n.t("{0} note(s) in the output.", notes.length)}` : ""));
      } catch (e) {
        void vscode.window.showErrorMessage(l10n.t("OpenGr8on: import of CLU{0} failed: {1}", serial, (e as Error).message));
      }
    }),

    vscode.commands.registerCommand("opengr8on.generate", async () => {
      const r = await deps.resolvedProject();
      if (!r) return;
      try {
        for (const clu of r.clus) {
          const { om, user, main } = buildFiles(clu, deps.eol());
          const dir = vscode.Uri.joinPath(r.watcher.root, "build", clu.name);
          await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, "OM.LUA"), om);
          await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, "USER.LUA"), user);
          await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, "MAIN.LUA"), main);
        }
        deps.log.appendLine(`generate: ${r.clus.map((c) => c.name).join(", ")} -> build/`);
        void vscode.window.showInformationMessage(l10n.t("OpenGr8on: generated {0} CLU(s) into build/.", r.clus.length));
      } catch (e) {
        void vscode.window.showErrorMessage(`OpenGr8on: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("opengr8on.diffWithClu", async () => {
      const r = await deps.resolvedProject();
      if (!r || r.clus.length === 0) return;
      const selected = deps.selectedSerial();
      const pick =
        r.clus.length === 1
          ? r.clus[0]
          : (await vscode.window.showQuickPick(r.clus.map((c) => ({ label: c.name, description: `${c.ip}${serialOf(c) === selected ? ` · ${l10n.t("selected")}` : ""}`, c })), { title: l10n.t("OpenGr8on: compare with CLU") }))?.c;
      if (!pick) return;
      try {
        const built = buildFiles(pick, deps.eol());
        const serial = serialOf(pick);
        const device = deps.discovered(serial) ?? new CLUDevice({ serialNumber: serial, address: pick.ip });
        const local = deps.localAddress();
        const [om, user] = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: l10n.t("OpenGr8on: reading {0}…", pick.name) }, async () => [
          await deps.runner.download(local, device, CLUFiles.OM_LUA),
          await deps.runner.download(local, device, CLUFiles.USER_LUA),
        ]);
        for (const [file, onClu, gen] of [["OM.LUA", om, built.om], ["USER.LUA", user, built.user]] as const) {
          const same = onClu?.equals(gen);
          deps.log.appendLine(`diff ${pick.name} ${file}: ${onClu ? (same ? "identical" : "differs") : "missing on CLU"}`);
          if (same) continue;
          await vscode.commands.executeCommand(
            "vscode.diff",
            diffDoc(`/${pick.name}/on-clu/${file}`, onClu ?? Buffer.alloc(0)),
            diffDoc(`/${pick.name}/generated/${file}`, gen),
            `${pick.name} ${file}: CLU ↔ generated`,
          );
        }
        if (om?.equals(built.om) && user?.equals(built.user)) void vscode.window.showInformationMessage(l10n.t("OpenGr8on: {0} already runs exactly the generated OM.LUA and USER.LUA.", pick.name));
      } catch (e) {
        void vscode.window.showErrorMessage(`OpenGr8on: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("opengr8on.upload", async () => {
      const r = await deps.resolvedProject();
      if (!r) return;
      if (r.clus.length === 0) {
        void vscode.window.showErrorMessage(l10n.t("OpenGr8on: the project has no CLUs."));
        return;
      }
      const selected = deps.selectedSerial();
      const items = [
        ...(r.clus.length > 1 ? [{ label: `$(cloud-upload) ${l10n.t("All CLUs")}`, description: r.clus.map((c) => c.name).join(", "), clus: r.clus }] : []),
        ...r.clus
          .map((c) => ({ label: c.name, description: `${c.ip} · ${c.id}${serialOf(c) === selected ? ` · ${l10n.t("selected")}` : ""}`, clus: [c] }))
          .sort((a, b) => Number(b.description.endsWith("selected")) - Number(a.description.endsWith("selected"))),
      ];
      const pick = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { title: l10n.t("OpenGr8on: upload to") });
      if (!pick) return;

      let files: Array<{ clu: Clu; om: Buffer; user: Buffer; main: Buffer }>;
      try {
        files = pick.clus.map((clu) => ({ clu, ...buildFiles(clu, deps.eol()) }));
      } catch (e) {
        void vscode.window.showErrorMessage(`OpenGr8on: ${(e as Error).message}`);
        return;
      }
      const upload = l10n.t("Upload and Reset");
      const ok = await vscode.window.showWarningMessage(
        pick.clus.length === 1 ? l10n.t("Upload MAIN.LUA, OM.LUA and USER.LUA to {0} and reset it?", pick.clus[0].name) : l10n.t("Upload MAIN.LUA, OM.LUA and USER.LUA to {0} CLUs and reset them?", pick.clus.length),
        {
          modal: true,
          detail: `${pick.clus.map((c) => `${c.name}  ${c.ip}  ${c.id}`).join("\n")}\n\n${l10n.t("The CLU program is replaced and the CLU restarts; outputs may switch while it boots.")}`,
        },
        upload,
      );
      if (ok !== upload) return;

      const local = deps.localAddress();
      const results: Array<{ text: string; ok: boolean }> = [];
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: l10n.t("OpenGr8on: upload"), cancellable: false }, async (progress) => {
        for (const { clu, om, user, main } of files) {
          const serial = serialOf(clu);
          const device = deps.discovered(serial) ?? new CLUDevice({ serialNumber: serial, address: clu.ip });
          try {
            progress.report({ message: l10n.t("{0}: uploading ({1} + {2} bytes)…", clu.name, om.length, user.length) });
            await deps.runner.upload(local, device, [
              { file: CLUFiles.OM_LUA, content: om },
              { file: CLUFiles.USER_LUA, content: user },
              { file: CLUFiles.MAIN_LUA, content: main }, // as OM: without it the CLU never runs OM.LUA
            ]);
            progress.report({ message: l10n.t("{0}: restarting…", clu.name) });
            const back = await deps.runner.reset(local, device);
            results.push({ ok: back, text: back ? l10n.t("{0}: uploaded and verified, running again", clu.name) : l10n.t("{0}: uploaded and verified, but not answering 30 s after the restart", clu.name) });
          } catch (e) {
            results.push({ ok: false, text: l10n.t("{0}: FAILED: {1}", clu.name, (e as Error).message) });
          } finally {
            deps.uploaded(serial); // the Devices view re-reads OM.LUA: IOs get their new object ids
          }
        }
      });
      for (const l of results) deps.log.appendLine(`upload ${l.text}`);
      const failed = results.filter((l) => !l.ok);
      if (failed.length) {
        deps.log.show(true);
        void vscode.window.showErrorMessage(`OpenGr8on: ${failed.map((l) => l.text).join("; ")}`);
      } else void vscode.window.showInformationMessage(`OpenGr8on: ${results.map((l) => l.text).join("; ")}.`);
    }),
  );
}
