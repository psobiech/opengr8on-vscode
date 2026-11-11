/**
 * Translation hook for modules that must not import `vscode`: views pass `vscode.l10n.t`, tests and
 * logs use `english`. Messages are English with `{0}`-style placeholders (same as l10n.t), and every
 * call site passes a string literal so tests/unit/l10n.test.ts can check the translations.
 */
export type Tr = (message: string, ...args: Array<string | number | boolean>) => string;

export const english: Tr = (message, ...args) => message.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m));
