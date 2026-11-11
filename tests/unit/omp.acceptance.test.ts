import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { readOmpDiagnostics, readOmpProject } from "opengr8on-node/client";
import { copyInterfaces } from "../../scripts/copy-interfaces.mjs";
import { emitOmLua, emitUserLua } from "../../src/generator/omLua";
import { loadInterfaceRegistry } from "../../src/interfaces/registry";
import { loadProject } from "../../src/project/load";
import { importOmp } from "../../src/project/fromOmp";
import { resolveProject } from "../../src/project/resolve";

// Acceptance on a real (private, never committed) .omp: generate(import(omp)) must equal the
// OM.LUA Object Manager itself generated for each CLU (cached in the .omp under diagnostics/).
// Skipped when the file is not present (CI).
const OMP = process.env.OPENGR8ON_OMP ?? path.join(__dirname, "../../../opengr8on/runtime/project.omp");

describe.skipIf(!existsSync(OMP))(".omp acceptance (local)", () => {
  it("generate(import(omp)) === OM's own OM.LUA for every CLU with a cached om.lua", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "og-omp-"));
    try {
      copyInterfaces(path.join(__dirname, "../../lib/opengr8on-node/docs/device-interfaces"), dir);
      const registry = loadInterfaceRegistry(dir);
      const omp = readOmpProject(OMP);
      const imported = importOmp(omp, registry, { omExact: true }); // removed objects + trash remotes, as OM writes them
      const { project, diagnostics } = await loadProject({
        read: async (p) => imported.files.get(p),
        list: async (d) => [...imported.files.keys()].filter((p) => p.startsWith(`${d}/`)).map((p) => p.slice(d.length + 1)),
      });
      expect(diagnostics.map((d) => `${d.file}:${d.range.start.line + 1} ${d.message}`)).toEqual([]);
      const r = resolveProject(project!, registry);
      const diag = readOmpDiagnostics(OMP);
      const mask = (s?: string) => (s ?? "<none>").replace(/[0-9]/g, "9").replace(/[a-z]/g, "a").replace(/[A-Z]/g, "A");
      // messages quote private names / serials: report only their shape
      const report: string[] = [...r.diagnostics.map((d) => `resolve ${d.file}:${d.range.start.line + 1} ${mask(d.message)}`)];
      for (const clu of r.clus) {
        const serial = String(Number(clu.id.replace(/^CLU/, "")));
        const om = diag.get(serial)?.get("om.lua");
        if (!om) {
          report.push(`${clu.name}: no cached om.lua`);
          continue;
        }
        // The .omp cache is LF without the final line break (the CLU itself holds CRLF + final CRLF,
        // see the real-*.OM.LUA fixtures), so compare in that normalised form.
        const want = om.toString("utf8").replace(/\r\n/g, "\n");
        const got = emitOmLua(clu, { eol: "\n" }).replace(/\n$/, "");
        const projectIds = new Set(project!.clus.map((c) => c.id).concat(omp.clus.map((c) => c.nameOnCLU)));
        const cachedRemotes = [...want.matchAll(/^(CLU\d+) = OBJECT:new\(1, /gm)].map((m) => m[1]);
        // stale = generated for another set of CLUs (a CLU added or removed since)
        const staleRemote = cachedRemotes.find((id) => !projectIds.has(id)) ?? clu.remotes.map((x) => x.id).find((id) => !cachedRemotes.includes(id));
        if (staleRemote) {
          report.push(`${clu.name}: cached om.lua is stale (remote ${mask(staleRemote)} added or removed since) — skipped`);
          continue;
        }
        if (got !== want) {
          const a = want.split("\n");
          const b = got.split("\n");
          const k = a.findIndex((l, i) => l !== b[i]);
          // shapes only: the file is private
          report.push(`${clu.name}: differs at line ${k + 1}/${a.length}: want ${mask(a[k])} got ${mask(b[k])}`);
        } else report.push(`${clu.name}: identical`);
        const user = diag.get(serial)?.get("user.lua");
        if (user) {
          const wantU = user.toString("utf8").replace(/\r\n/g, "\n");
          const gotU = emitUserLua(clu, { eol: "\n" }).replace(/\n$/, "");
          if (wantU === gotU) report.push(`${clu.name} USER.LUA: identical`);
          else {
            const a = wantU.split("\n");
            const b = gotU.split("\n");
            const k = a.findIndex((l, i) => l !== b[i]);
            // OM does not refresh its USER.LUA cache on every send: OPENGR8ON_ALLOW_STALE_USER=1 reports
            // a mismatch without failing (verify against the CLU instead, e.g. Compare with CLU)
            report.push(`${clu.name} USER.LUA: differs at line ${k + 1}/${a.length}: want ${mask(a[k])} got ${mask(b[k])}${process.env.OPENGR8ON_ALLOW_STALE_USER ? " (stale cache allowed)" : ""}`);
          }
        }
      }
      console.log(["OMP ACCEPTANCE", ...imported.notes.map((n) => `note ${mask(n)}`), ...report].join("\n"));
      expect(report.filter((l) => !l.endsWith("identical") && !l.endsWith("no cached om.lua") && !l.endsWith("skipped") && !l.endsWith("(stale cache allowed)"))).toEqual([]);
      expect(report.filter((l) => l.endsWith("identical")).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000); // whole real project + all interface XMLs: slow under a parallel full run
});
