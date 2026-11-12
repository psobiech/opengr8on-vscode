/**
 * Strict USER.LUA parser, inverse of emitUserLua (observed OM 1.13 layout: any number of scripts,
 * parameters with `--ARG` defaults and the nil checks in --BEGIN_INIT). Anything else (e.g. the
 * `function ELO() return 1 end` stub in real-clu2) throws: import then keeps the raw file instead of
 * guessing.
 */
import type { Script, ScriptParam } from "./model";
import { parseOmLiteral } from "./omLuaParse";

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
  while (lines[i] === "" && lines[i + 1] === "" && /^function /.test(lines[i + 2] ?? "")) {
    i += 2;
    const head = /^function ([A-Za-z_]\w*)\(((?:[A-Za-z_]\w*)(?:,[A-Za-z_]\w*)*)?\)$/.exec(lines[i]) ?? fail("expected a script function");
    i++;
    expect("");
    const names = head[2] ? head[2].split(",") : [];
    const literals: string[] = [];
    const params: ScriptParam[] = names.map((name) => {
      const arg = new RegExp(`^--ARG ${name}=(.+?)(?: \\{(-?[\\d.]+)-(-?[\\d.]+)\\})?$`).exec(lines[i] ?? "") ?? fail(`expected --ARG ${name}=<default>`);
      i++;
      literals.push(arg[1]);
      const v = parseOmLiteral(arg[1]);
      if (v === undefined || typeof v === "object") fail(`--ARG ${name}: unsupported default`);
      const type = typeof v === "string" ? "string" : typeof v === "boolean" ? "boolean" : "number";
      if (arg[2] !== undefined && type !== "number") fail(`--ARG ${name}: a range on a ${type} parameter`);
      return { name, type, default: v as string | number | boolean, ...(arg[2] !== undefined ? { range: [Number(arg[2]), Number(arg[3])] as [number, number] } : {}) };
    });
    expect("--BEGIN_INIT");
    // the nil checks repeat the --ARG defaults (note the space after "then", as OM writes it)
    params.forEach((p, k) => {
      expect(`\tif ${p.name} == nil then `);
      expect(`\t\t${p.name} = ${literals[k]}`);
      expect("\tend");
    });
    expect("--END_INIT");
    expect("");
    const body: string[] = [];
    while (!(lines[i] === "" && lines[i + 1] === "end")) {
      if (i >= lines.length) fail("missing end of script");
      const l = lines[i];
      if (!l.startsWith("\t")) fail("script body lines must be tab-indented");
      body.push(l.slice(1));
      i++;
    }
    for (const l of ["", "end", "", "", "", ""]) expect(l);
    scripts.push({ name: head[1], params, source: body.join("\n") + "\n" });
  }
  expect("");
  if (i !== lines.length) fail("unexpected content");
  return { scripts, eol };
}

