import * as vscode from "vscode";
import { l10n } from "vscode";
import type { CLUDevice } from "opengr8on-node/client";
import type { CluInfo } from "../device/cluInfo";
import type { ParsedFeature } from "opengr8on-node/client";
import type { IoView } from "../device/cluConfig";
import { DOWNLOADABLE, type CluRunner } from "../device/cluRunner";
import { luaArg, methodCall } from "../device/liveValues";

export const CLU_FILE_SCHEME = "opengr8on-clu";

/** Read-only documents for files downloaded from a CLU: opengr8on-clu:/CLU<serial>/<file>. */
export class CluFileProvider implements vscode.TextDocumentContentProvider {
  private readonly files = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  set(serial: number, name: string, content: Buffer): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: CLU_FILE_SCHEME, path: `/CLU${serial}/${name}` });
    this.files.set(uri.toString(), content.toString("utf8")); // OM writes UTF-8
    this.changed.fire(uri);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.files.get(uri.toString()) ?? "";
  }
}

export interface CluCommandDeps {
  runner: CluRunner;
  log: vscode.OutputChannel;
  /** Device + local address from the last discovery, or an error message. */
  target(serial: number): { device: CLUDevice; local: string } | string;
  onAddressChanged(serial: number, address: string): void;
  /** CONFIG.JSON may have changed (refresh modules): drop cached module lists. */
  onModulesChanged(serial: number): void;
  /** Runs a Lua expression on a CLU (`req:`). */
  execute(serial: number, script: string): Promise<string>;
  /** Called after a set/execute so live values refresh right away. */
  afterChange(): void;
}

type Node = { kind: string; clu?: CluInfo } | undefined;

const languageFor = (name: string) => (/\.lua$/i.test(name) ? "lua" : /\.json$/i.test(name) ? "json" : "plaintext");

/** "number, range 0-100, unit %" for value prompts. */
function typeHint(x: { type: string; range?: string; unit?: string }): string {
  return [x.type, x.range ? l10n.t("range {0}", x.range) : "", x.unit && x.unit !== "-" ? l10n.t("unit {0}", x.unit) : ""].filter(Boolean).join(", ");
}

export function registerCluCommands(context: vscode.ExtensionContext, deps: CluCommandDeps): void {
  const files = new CluFileProvider();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(CLU_FILE_SCHEME, files));

  /** Wraps a CLU command: resolves the node's device, shows progress, reports errors. */
  const cluCommand = (id: string, title: string, fn: (serial: number, device: CLUDevice, local: string) => Promise<void>) =>
    vscode.commands.registerCommand(id, async (node: Node) => {
      const serial = node?.clu?.serial;
      if (serial === undefined) return;
      const t = deps.target(serial);
      if (typeof t === "string") {
        void vscode.window.showErrorMessage(`OpenGr8on: ${t}`);
        return;
      }
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: l10n.t("CLU{0}: {1}", serial, title) }, () => fn(serial, t.device, t.local));
      } catch (e) {
        deps.log.appendLine(`CLU${serial} ${title}: ${(e as Error).message}`);
        void vscode.window.showErrorMessage(l10n.t("OpenGr8on: CLU{0} {1}: {2}", serial, title, (e as Error).message));
      }
    });

  const open = async (serial: number, device: CLUDevice, local: string, name: string) => {
    const content = await deps.runner.download(local, device, DOWNLOADABLE[name]);
    if (!content) {
      void vscode.window.showWarningMessage(l10n.t("OpenGr8on: CLU{0} has no {1}.", serial, name));
      return;
    }
    deps.log.appendLine(`CLU${serial}: downloaded ${name} (${content.length} bytes)`);
    const doc = await vscode.workspace.openTextDocument(files.set(serial, name, content));
    await vscode.window.showTextDocument(await vscode.languages.setTextDocumentLanguage(doc, languageFor(name)), { preview: false });
  };

  const runScript = async (serial: number, script: string) => {
    try {
      const answer = await deps.execute(serial, script);
      deps.log.appendLine(`CLU${serial}: ${script} -> ${answer}`);
      vscode.window.setStatusBarMessage(`CLU${serial}: ${script} → ${answer}`, 5000);
      deps.afterChange();
    } catch (e) {
      deps.log.appendLine(`CLU${serial}: ${script} failed: ${(e as Error).message}`);
      void vscode.window.showErrorMessage(`OpenGr8on: CLU${serial}: ${(e as Error).message}`);
    }
  };

  context.subscriptions.push(
    cluCommand("opengr8on.checkAlive", l10n.t("check alive"), async (serial, device, local) => {
      const alive = await deps.runner.checkAlive(local, device);
      deps.log.appendLine(`CLU${serial} check alive: ${alive ? "alive" : alive === false ? "answered, but not running normally" : "no answer"}`);
      const msg = alive
        ? l10n.t("OpenGr8on: CLU{0} is alive.", serial)
        : alive === false
          ? l10n.t("OpenGr8on: CLU{0} answered, but is not running normally (emergency mode or serial mismatch).", serial)
          : l10n.t("OpenGr8on: CLU{0} did not answer.", serial);
      void (alive ? vscode.window.showInformationMessage : vscode.window.showWarningMessage)(msg);
    }),
    cluCommand("opengr8on.resetClu", l10n.t("reset"), async (serial, device, local) => {
      const reset = l10n.t("Reset");
      const ok = await vscode.window.showWarningMessage(l10n.t("Reset CLU{0} ({1})?", serial, device.address ?? ""), { modal: true, detail: l10n.t("The CLU restarts; outputs may switch while it boots.") }, reset);
      if (ok !== reset) return;
      const back = await deps.runner.reset(local, device);
      deps.log.appendLine(`CLU${serial} reset: ${back ? "back online" : "not answering after 30 s"}`);
      void (back ? vscode.window.showInformationMessage : vscode.window.showWarningMessage)(back ? l10n.t("OpenGr8on: CLU{0} restarted and is back online.", serial) : l10n.t("OpenGr8on: CLU{0} restarted, but is not answering after 30 s.", serial));
    }),
    cluCommand("opengr8on.setCluIp", l10n.t("set IP"), async (serial, device, local) => {
      const address = await vscode.window.showInputBox({ title: l10n.t("CLU{0}: new IP address", serial), value: device.address ?? "", ignoreFocusOut: true });
      if (!address) return;
      const gateway = await vscode.window.showInputBox({
        title: l10n.t("CLU{0}: gateway", serial),
        value: address.replace(/\.\d+$/, ".1"),
        ignoreFocusOut: true,
      });
      if (!gateway) return;
      const now = await deps.runner.setAddress(local, device, address.trim(), gateway.trim());
      deps.log.appendLine(`CLU${serial} set IP: ${now} (gateway ${gateway.trim()})`);
      deps.onAddressChanged(serial, now);
      void vscode.window.showInformationMessage(l10n.t("OpenGr8on: CLU{0} is now at {1}.", serial, now));
    }),
    cluCommand("opengr8on.refreshModules", l10n.t("refresh modules"), async (serial, device, local) => {
      await deps.runner.refreshModules(local, device);
      deps.onModulesChanged(serial);
      deps.log.appendLine(`CLU${serial}: modules refreshed (CONFIG.JSON rewritten)`);
      void vscode.window.showInformationMessage(l10n.t("OpenGr8on: CLU{0} rescanned its modules.", serial));
    }),
    cluCommand("opengr8on.downloadFile", l10n.t("download"), async (serial, device, local) => {
      const name = await vscode.window.showQuickPick(Object.keys(DOWNLOADABLE), { title: l10n.t("Download from CLU{0}", serial) });
      if (name) await open(serial, device, local, name);
    }),
    vscode.commands.registerCommand("opengr8on.setFeature", async (node?: { serial: number; io: IoView; feature: ParsedFeature }) => {
      if (!node?.io.objectId) return;
      const { feature: f, io } = node;
      const id = io.objectId!;
      const input = await vscode.window.showInputBox({
        title: `${io.name ?? io.label} (${id}) · ${f.name}`,
        prompt: typeHint(f),
        validateInput: (v) => {
          try {
            luaArg(f.type, v);
            return undefined;
          } catch (e) {
            return (e as Error).message;
          }
        },
      });
      if (input === undefined) return;
      const script = `${id}:set(${f.index}, ${luaArg(f.type, input)})`;
      await runScript(node.serial, script);
    }),
    vscode.commands.registerCommand("opengr8on.executeMethod", async (node?: { serial: number; io: IoView }) => {
      if (!node?.io.objectId) return;
      const { io } = node;
      const methods = io.methods.filter((m) => m.call === "set" || m.call === "execute");
      const picked = await vscode.window.showQuickPick(
        methods.map((m) => ({ label: m.name, description: `${m.call}(${[m.index, ...m.params.map((p) => p.name)].join(", ")})`, method: m })),
        { title: l10n.t("{0} ({1}): method", io.name ?? io.label, io.objectId ?? "") },
      );
      if (!picked) return;
      const inputs: string[] = [];
      for (const p of picked.method.params) {
        const v = await vscode.window.showInputBox({
          title: `${picked.label}: ${p.name}`,
          prompt: typeHint(p),
          value: p.default ?? "",
          validateInput: (x) => {
            try {
              luaArg(p.type, x);
              return undefined;
            } catch (e) {
              return (e as Error).message;
            }
          },
        });
        if (v === undefined) return;
        inputs.push(v);
      }
      await runScript(node.serial, methodCall(io.objectId!, picked.method, inputs));
    }),
    cluCommand("opengr8on.diagnosticPack", l10n.t("diagnostic pack"), (serial, device, local) => open(serial, device, local, "DIAGNOSTIC_PACK.JSON")),
  );
}
