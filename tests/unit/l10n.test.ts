import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { english } from "../../src/i18n";

const root = join(__dirname, "../..");
const json = (p: string): Record<string, string> => JSON.parse(readFileSync(join(root, p), "utf8"));
const placeholders = (s: string): string[] => [...new Set(s.match(/\{\d+\}/g) ?? [])].sort();

/** Messages passed as literals to vscode.l10n.t / l10n.t / tr (src/i18n.ts) anywhere in src/. */
function sourceMessages(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ts")) {
        for (const m of readFileSync(p, "utf8").matchAll(/\b(?:l10n\.t|tr)\(\s*"((?:[^"\\]|\\.)*)"/g)) out.add(JSON.parse(`"${m[1]}"`) as string);
        // single-quoted messages (they contain "...")
        for (const m of readFileSync(p, "utf8").matchAll(/\b(?:l10n\.t|tr)\(\s*'((?:[^'\\]|\\.)*)'/g)) out.add(m[1].replace(/\\'/g, "'"));
      }
    }
  };
  walk(join(root, "src"));
  return out;
}

describe("translations", () => {
  it("manifest: every %key% in package.json exists in English and Polish, and nothing else", () => {
    const used = new Set([...readFileSync(join(root, "package.json"), "utf8").matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]));
    const en = json("package.nls.json");
    const pl = json("package.nls.pl.json");
    expect(Object.keys(en).sort()).toEqual([...used].sort());
    expect(Object.keys(pl).sort()).toEqual([...used].sort());
    for (const k of used) expect(pl[k], k).not.toBe("");
  });

  it("runtime: every message in src/ has a Polish translation with the same placeholders, no stale ones", () => {
    const messages = sourceMessages();
    const pl = json("l10n/bundle.l10n.pl.json");
    expect(messages.size).toBeGreaterThan(100);
    expect([...messages].filter((m) => !(m in pl))).toEqual([]);
    expect(Object.keys(pl).filter((k) => !messages.has(k))).toEqual([]);
    for (const [k, v] of Object.entries(pl)) expect(placeholders(v), k).toEqual(placeholders(k));
  });

  it("english fills {n} placeholders like vscode.l10n.t", () => {
    expect(english("CLU{0}: {1} ({0})", 7, "ok")).toBe("CLU7: ok (7)");
    expect(english("no args {0}")).toBe("no args {0}");
  });
});
