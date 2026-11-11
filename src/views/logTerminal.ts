import * as vscode from "vscode";
import { l10n } from "vscode";
import { TelnetLog, colorize, lineFilter, type LogState } from "../device/telnetLog";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

/** Read-only CLU log (telnet, TCP 23) in a terminal. Keys: f = filter, r = reconnect, c = clear. */
export class CluLogTerminal implements vscode.Pseudoterminal {
  private readonly writer = new vscode.EventEmitter<string>();
  private readonly closer = new vscode.EventEmitter<void>();
  readonly onDidWrite = this.writer.event;
  readonly onDidClose = this.closer.event;
  private log: TelnetLog | undefined;
  private filterSpec = "";
  private filter = lineFilter("");

  constructor(
    readonly serial: number,
    private host: string,
  ) {}

  private println(s: string): void {
    this.writer.fire(`${s}\r\n`);
  }

  private stateLine(s: LogState): string {
    if (s.state === "disconnected") return dim(`-- disconnected${s.error ? `: ${s.error}` : ""}; retry in ${Math.round(s.retryInMs / 1000)} s (r = now)`);
    return dim(s.state === "connecting" ? `-- connecting to ${this.host}:23 …` : `-- connected to CLU${this.serial} (${this.host})`);
  }

  open(): void {
    this.println(dim(`CLU${this.serial} log · f = filter · r = reconnect · c = clear · set the level with "Set Log Level"`));
    this.log = new TelnetLog({
      host: this.host,
      onLine: (l) => {
        if (this.filter(l)) this.println(colorize(l));
      },
      onState: (s) => this.println(this.stateLine(s)),
    });
    this.log.start();
  }

  close(): void {
    this.log?.close();
  }

  /** CLU moved to a new address (Set IP / rediscovery). */
  setHost(host: string): void {
    if (host === this.host) return;
    this.host = host;
    this.log?.close();
    this.open();
  }

  async handleInput(data: string): Promise<void> {
    switch (data) {
      case "r":
        this.log?.reconnect();
        break;
      case "c":
        this.writer.fire("\x1b[2J\x1b[3J\x1b[H");
        break;
      case "f": {
        const spec = await vscode.window.showInputBox({
          title: l10n.t("CLU{0} log filter", this.serial),
          prompt: l10n.t("Substring (case-insensitive) or /regex/flags; empty shows everything. Applies to new lines."),
          value: this.filterSpec,
        });
        if (spec === undefined) return;
        try {
          this.filter = lineFilter(spec);
          this.filterSpec = spec;
          this.println(dim(spec.trim() ? `-- filter: ${spec}` : "-- filter off"));
        } catch (e) {
          this.println(dim(`-- bad filter: ${(e as Error).message}`));
        }
        break;
      }
    }
  }
}

/** One log terminal per CLU; reused when opened again. */
export class LogTerminals implements vscode.Disposable {
  private readonly open = new Map<number, { pty: CluLogTerminal; terminal: vscode.Terminal }>();
  private readonly sub = vscode.window.onDidCloseTerminal((t) => {
    for (const [serial, e] of this.open) if (e.terminal === t) this.open.delete(serial);
  });

  show(serial: number, host: string): void {
    let e = this.open.get(serial);
    if (!e) {
      const pty = new CluLogTerminal(serial, host);
      const terminal = vscode.window.createTerminal({ name: `CLU${serial} log`, pty, iconPath: new vscode.ThemeIcon("output") });
      this.open.set(serial, (e = { pty, terminal }));
    } else e.pty.setHost(host);
    e.terminal.show(true);
  }

  addressChanged(serial: number, host: string): void {
    this.open.get(serial)?.pty.setHost(host);
  }

  dispose(): void {
    this.sub.dispose();
    for (const e of this.open.values()) e.terminal.dispose();
    this.open.clear();
  }
}
