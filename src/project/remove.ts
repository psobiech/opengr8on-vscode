/**
 * Where a virtual object or a script is still used, before it is deleted. Pure.
 *
 * Resolver view: resolve the project once as it is and once without the item; every new error is a
 * reference the resolver understands (YAML actions and table features, `CLU->OBJ` in scripts).
 * Plain Lua is not resolved, so script sources and raw-Lua actions are also searched for the
 * object id (`TIM1001:get(0)`, also inside remote `execute` strings) or a call of the script.
 */
import type { InterfaceRegistry } from "opengr8on-node/client";
import type { CluSource, ProjectSource } from "./load";
import { resolveProject } from "./resolve";

export type RemoveTarget = { clu: string; kind: "object"; name: string } | { clu: string; kind: "script"; name: string };

export interface Usage {
  /** project-relative file */
  file: string;
  /** 0-based */
  line: number;
  col: number;
  /** what refers to the item (resolver message or the matching source line) */
  text: string;
}

function without(project: ProjectSource, t: RemoveTarget): ProjectSource {
  const strip = (c: CluSource): CluSource =>
    c.name !== t.clu ? c : t.kind === "object" ? { ...c, objects: c.objects.filter((o) => o.name !== t.name) } : { ...c, scripts: c.scripts.filter((s) => s.name !== t.name) };
  return { ...project, clus: project.clus.map(strip) };
}

/** Lines of `text` matching `re` outside `--` comments. */
function grep(file: string, text: string, re: RegExp, skip: (line: number) => boolean = () => false): Usage[] {
  const out: Usage[] = [];
  text.split("\n").forEach((l, line) => {
    const code = l.replace(/--.*$/, "");
    const m = re.exec(code);
    if (m && !skip(line)) out.push({ file, line, col: m.index, text: l.trim() });
  });
  return out;
}

export function findUsages(project: ProjectSource, registry: InterfaceRegistry, t: RemoveTarget): Usage[] {
  const clu = project.clus.find((c) => c.name === t.clu);
  if (!clu) throw new Error(`no CLU named ${t.clu}`);
  const own =
    t.kind === "object"
      ? clu.objects.find((o) => o.name === t.name)
      : clu.scripts.find((s) => s.name === t.name);
  if (!own) throw new Error(`${t.name} not found on ${t.clu}`);

  const key = (d: { file: string; range: { start: { line: number; col: number } }; message: string }) => `${d.file}:${d.range.start.line}:${d.range.start.col}:${d.message}`;
  const before = new Set(resolveProject(project, registry).diagnostics.map(key));
  const usages: Usage[] = resolveProject(without(project, t), registry)
    .diagnostics.filter((d) => d.severity === "error" && !before.has(key(d)))
    .map((d) => ({ file: d.file, line: d.range.start.line, col: d.range.start.col, text: d.message }));

  // plain Lua: the object id / a call of the script
  const word = t.kind === "object" ? (own as { id: string }).id : t.name;
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = t.kind === "object" ? new RegExp(`\\b${esc}\\b`) : new RegExp(`\\b${esc}\\s*\\(`);
  const seen = new Set(usages.map((u) => `${u.file}:${u.line}`));
  const add = (u: Usage) => {
    if (seen.has(`${u.file}:${u.line}`)) return;
    seen.add(`${u.file}:${u.line}`);
    usages.push(u);
  };
  for (const c of project.clus) {
    for (const s of c.scripts) {
      if (t.kind === "script" && c.name === t.clu && s.name === t.name) continue;
      for (const u of grep(s.file, s.source, re)) add(u);
    }
    const actions = [...c.events, ...c.modules.flatMap((m) => m.ios.flatMap((io) => io.events)), ...c.objects.flatMap((o) => (t.kind === "object" && c.name === t.clu && o.name === t.name ? [] : o.events))];
    for (const e of actions)
      for (const a of e.value)
        if (a.kind === "lua" && re.test(a.text)) add({ file: a.at.file, line: a.at.range.start.line, col: a.at.range.start.col, text: a.text.trim() });
  }
  return usages.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
