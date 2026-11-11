import { english } from "../../src/i18n";

/**
 * Minimal runtime mock of the "vscode" module (aliased in vitest.config.ts). Grow it only with
 * what unit tests actually need; UI behaviour is checked in the Extension Development Host.
 */
export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  event = (l: (e: T) => void) => {
    this.listeners.push(l);
    return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
  };
  fire(e: T): void {
    for (const l of this.listeners) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  constructor(public label: string, public collapsibleState = TreeItemCollapsibleState.None) {}
}

export const window = {
  createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  showInformationMessage: async () => undefined,
  showErrorMessage: async () => undefined,
};

export const commands = {
  registerCommand: () => ({ dispose: () => {} }),
  executeCommand: async () => undefined,
};

export class Range {
  constructor(public startLine: number, public startCol: number, public endLine: number, public endCol: number) {}
}

export const Uri = {
  joinPath: (base: { path: string }, ...parts: string[]) => ({ path: [base.path, ...parts].join("/") }),
};

export class ThemeIcon {
  constructor(public id: string) {}
}

/** Untranslated: messages come back in English with {0} placeholders filled in. */
export const l10n = { t: english };
