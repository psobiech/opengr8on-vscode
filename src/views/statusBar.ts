import * as vscode from "vscode";
import { l10n } from "vscode";
import { cluObjectId, type CluInfo } from "../device/cluInfo";

/** Translated stored-key kind (also used by the Devices view). */
export function keySourceLabel(k: CluInfo["keySource"]): string {
  return k === "clu" ? l10n.t("own key") : k === "project" ? l10n.t("project key") : l10n.t("none");
}

export interface StatusView {
  text: string;
  tooltip: string;
  warning: boolean;
}

/** Status bar text for the selected CLU (pure; see CluStatusBar). */
export function statusView(serial: number | undefined, clu: CluInfo | undefined, liveError: string | undefined): StatusView {
  if (serial === undefined) return { text: `$(circuit-board) ${l10n.t("no CLU")}`, tooltip: l10n.t("OpenGr8on: select a CLU"), warning: false };
  const id = cluObjectId({ serial });
  if (!clu) return { text: `$(circuit-board) ${id}`, tooltip: l10n.t("{0}: not discovered in this session (run Discover CLUs)", id), warning: true };
  if (!clu.online && !clu.inProject) return { text: `$(debug-disconnect) ${id}`, tooltip: l10n.t("{0} ({1}): not seen in the last discovery", id, clu.address ?? "?"), warning: true };
  if (liveError) return { text: `$(warning) ${id} ${clu.address ?? ""}`.trim(), tooltip: `${id}: ${liveError}`, warning: true };
  return { text: `$(circuit-board) ${id} ${clu.address ?? ""}`.trim(), tooltip: l10n.t("{0} ({1}) · key: {2} · click to change", id, clu.address ?? "?", keySourceLabel(clu.keySource)), warning: false };
}

const STATE_KEY = "opengr8on.selectedClu";

/** Selected CLU (persisted per workspace) shown in the status bar. */
export class CluStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly changed = new vscode.EventEmitter<number | undefined>();
  readonly onDidChangeSelected = this.changed.event;
  private serial: number | undefined;

  constructor(
    private readonly state: vscode.Memento,
    private readonly lookup: (serial: number) => CluInfo | undefined,
    private readonly liveError: (serial: number) => string | undefined,
  ) {
    this.serial = state.get<number>(STATE_KEY);
    this.item.command = "opengr8on.selectClu";
    this.render();
    this.item.show();
  }

  get selected(): number | undefined {
    return this.serial;
  }

  select(serial: number | undefined): void {
    if (serial === this.serial) return;
    this.serial = serial;
    void this.state.update(STATE_KEY, serial);
    this.render();
    this.changed.fire(serial);
  }

  render(): void {
    const v = statusView(this.serial, this.serial === undefined ? undefined : this.lookup(this.serial), this.serial === undefined ? undefined : this.liveError(this.serial));
    this.item.text = v.text;
    this.item.tooltip = v.tooltip;
    this.item.backgroundColor = v.warning ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
  }

  dispose(): void {
    this.item.dispose();
    this.changed.dispose();
  }
}
