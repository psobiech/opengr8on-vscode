import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { emitOmLua, emitUserLua } from "../../src/generator/omLua";
import { loadInterfaceRegistry } from "../../src/interfaces/registry";
import { loadProject } from "../../src/project/load";
import { resolveProject } from "../../src/project/resolve";

// docs/demo is the example project of the user guide (docs/INSTRUKCJA.md): it must stay valid.
it("docs/demo loads, resolves and generates without errors", async () => {
  const root = path.join(__dirname, "../../docs/demo");
  const { project, diagnostics } = await loadProject({
    read: async (p) => { try { return readFileSync(path.join(root, p), "utf8"); } catch { return undefined; } },
    list: async (d) => { try { return readdirSync(path.join(root, d)); } catch { return []; } },
  });
  expect(diagnostics).toEqual([]);
  const r = resolveProject(project!, loadInterfaceRegistry(path.join(__dirname, "../../dist/interfaces")));
  expect(r.diagnostics.map((d) => `${d.file}:${d.range.start.line + 1} ${d.message}`)).toEqual([]);
  const parter = r.clus.find((c) => c.name === "PARTER")!;
  const om = emitOmLua(parter, { eol: "\n" });
  expect(om).toContain("TIM1001 = OBJECT:new(6, \"TIM1001\")\n-- NAME_PERIPHERY TIMER_ROLETY=TIM1001");
  expect(om).toContain("\tTIM1001:execute(0) -- CluOnInit\nend");
  expect(emitUserLua(parter, { eol: "\n" })).toContain('\tprint(CLU100000102:execute(0, "DIM2001:get(0)"))');
});
