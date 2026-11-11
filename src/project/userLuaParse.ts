/**
 * Strict USER.LUA parser, inverse of emitUserLua (observed layout: one script, no parameters).
 * Anything else (e.g. the `function ELO() return 1 end` stub in real-clu2) throws: import then
 * keeps the raw file instead of guessing.
 */
import type { Script } from "./model";

export function parseUserLua(text: string): { scripts: Script[]; eol: "\r\n" | "\n" } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (text === "") return { scripts: [], eol: "\r\n" }; // no scripts: OM writes an empty file
  const lines = text.split(eol);
  let i = 0;
  const fail = (msg: string): never => {
    throw new Error(`USER.LUA line ${i + 1}: ${msg}: ${JSON.stringify(lines[i] ?? "<end of file>")}`);
  };
  const expect = (l: string) => (lines[i] === l ? i++ : fail(`expected ${JSON.stringify(l)}`));
  const scripts: Script[] = [];
  expect("");
  while (i < lines.length && lines[i] === "" && /^function /.test(lines[i + 1] ?? "")) {
    i++;
    const head = /^function ([A-Za-z_]\w*)\(\)$/.exec(lines[i]) ?? fail("expected a parameterless script function");
    i++;
    for (const l of ["", "--BEGIN_INIT", "--END_INIT", ""]) expect(l);
    const body: string[] = [];
    while (!(lines[i] === "" && lines[i + 1] === "end")) {
      if (i >= lines.length) fail("missing end of script");
      const l = lines[i];
      if (!l.startsWith("\t")) fail("script body lines must be tab-indented");
      body.push(l.slice(1));
      i++;
    }
    for (const l of ["", "end", "", ""]) expect(l);
    scripts.push({ name: head[1], params: [], source: body.join("\n") + "\n" });
  }
  for (const l of ["", "", ""]) expect(l);
  if (i !== lines.length) fail("unexpected content");
  return { scripts, eol };
}
