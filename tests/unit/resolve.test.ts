import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { copyInterfaces } from "../../scripts/copy-interfaces.mjs";
import { emitOmLua, emitUserLua } from "../../src/generator/omLua";
import { loadInterfaceRegistry } from "../../src/interfaces/registry";
import { loadProject, type ProjectFiles } from "../../src/project/load";
import { parseOmLua } from "../../src/project/omLuaParse";
import { defaultIoName, parseAction, resolveProject, splitArgs } from "../../src/project/resolve";
import { cluToYaml } from "../../src/project/toYaml";
import { buildIndex } from "../../src/project/assist";
import { friendlyAction } from "../../src/project/friendly";

const fixture = (name: string) => readFileSync(path.join(__dirname, "..", "fixtures", name), "latin1");
const mem = (files: Record<string, string>): ProjectFiles => ({
  read: async (p) => files[p],
  list: async (dir) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
});

let dir: string;
let registry: ReturnType<typeof loadInterfaceRegistry>;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "og-res-"));
  copyInterfaces(path.join(__dirname, "../../lib/opengr8on-node/docs/device-interfaces"), dir);
  registry = loadInterfaceRegistry(dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("action grammar", () => {
  it("parses object and script calls", () => {
    expect(parseAction("CLU_1->LAMP->Switch(0)")).toEqual({ clu: "CLU_1", object: "LAMP", member: "Switch", args: ["0"] });
    expect(parseAction("CLU_2->x330000009_LEDRGB_01->SetGreenValue(255, 1000)")?.args).toEqual(["255", "1000"]);
    expect(parseAction("VCLU->mqtt(\"CLU1->DIM1186\", f(1, 2))")).toEqual({ clu: "VCLU", object: undefined, member: "mqtt", args: ['"CLU1->DIM1186"', "f(1, 2)"] });
    expect(parseAction("CLU_1->ELO()")?.args).toEqual([]);
    expect(parseAction("nonsense")).toBeUndefined();
    expect(splitArgs('"a,b", 2')).toEqual(['"a,b"', "2"]);
  });

  it("builds OM default IO names", () => {
    expect(defaultIoName(330000009, "AnalogOUT", 0)).toBe("x330000009_AnalogOUT_01");
  });
});

// OM.LUA → YAML → load → resolve → emit must give back the original bytes.
describe.each(["real-clu2.OM.LUA", "real-x.OM.LUA", "real-modbus.OM.LUA", "vclu.OM.LUA"])("YAML round trip %s", (name) => {
  it("emit(resolve(load(toYaml(parse(x))))) === x", async () => {
    const text = fixture(name);
    const { clu, eol } = parseOmLua(text);
    const yaml = cluToYaml(clu, registry);
    const { project, diagnostics } = await loadProject(mem({ "opengr8on.yaml": "format: 1\nname: T\n", [`clus/${clu.name}.yaml`]: yaml }));
    expect(diagnostics).toEqual([]);
    const r = resolveProject(project!, registry);
    expect(r.diagnostics).toEqual([]);
    expect(emitOmLua(r.clus[0], { eol })).toBe(text);
  });
});

describe("resolveProject", () => {
  const files = (clu2: string) =>
    mem({
      "opengr8on.yaml": "format: 1\nname: T\n",
      "clus/CLU_1.yaml": "clu: { name: CLU_1, serial: 100000011, ip: 10.0.0.11, hw: { type: 0x13, version: 1 }, fw: { type: 3, version: 0x203 } }\nmodules:\n  - serial: 330000020\n    type: \"0x1a\"\n    comment: \"02 02\"\n    ios:\n      - { id: DIM0020, class: 5, channel: 0, name: LAMP }\n",
      "clus/CLU_2.yaml": clu2,
      "scripts/CLU_2/ELO.lua": "print(1)\n",
    });
  const resolve = async (clu2: string) => {
    const { project, diagnostics } = await loadProject(files(clu2));
    expect(diagnostics).toEqual([]);
    return resolveProject(project!, registry);
  };
  const clu2 = (body: string) =>
    "clu: { name: CLU_2, serial: 100000012, ip: 10.0.0.12, hw: { type: 0x13, version: 1 }, fw: { type: 3, version: 0x203 } }\n" + body;

  it("compiles script calls as OM does: arguments re-joined, nil per parameter, variables passed through", async () => {
    const r = await resolve(
      clu2(
        [
          "modules:",
          "  - serial: 330000009",
          '    type: "0x1a"',
          '    comment: "02 02"',
          "    ios:",
          "      - id: DIM0001",
          "        class: DIMM",
          "        channel: 0",
          "        events:",
          "          OnSwitchOn:",
          '            - CLU_2->ELO("ddd",3,false)',
          "            - CLU_2->ELO()",
          '            - CLU_2->ELO("x")',
          '            - CLU_1->LAMP->SwitchOn(0, 1)',
          "variables:",
          "  - { name: cecha, type: string, value: aas, persist: true }",
          'scripts: [ { name: ELO, params: [ { name: p, type: string, default: d }, { name: dd, type: number, default: 1, range: [1, 10] }, { name: b, type: boolean, default: true } ] } ]',
        ].join("\n"),
      ),
    );
    expect(r.diagnostics.map((d) => d.message)).toEqual([]);
    const c = r.clus.find((x) => x.name === "CLU_2")!;
    // observed: CLU->nowy_skrypt("ddd",3,false) → nowy_skrypt("ddd", 3, false); s() → s(nil, nil, nil)
    expect(c.modules[0].ios[0].events[0].actions).toEqual(['ELO("ddd", 3, false)', "ELO(nil, nil, nil)", 'ELO("x", nil, nil)', expect.stringContaining("CLU100000011:execute(0, ")]);
    expect(c.variables).toEqual([{ name: "cecha", type: "string", value: "aas", persist: true }]);
    expect(c.scripts[0].params.map((p) => p.name)).toEqual(["p", "dd", "b"]);
  });

  it("text values are Lua string contents: escapes allowed, bare quotes / line breaks refused; table features readable locally only", async () => {
    const yaml = (v: string) =>
      clu2(['objects:', '  - { id: HTT0001, class: HttpListener, version: 2, name: L, features: { Path: "/x", ResponseBody: ' + v + " } }", "scripts: [ { name: T } ]"].join("\n"));
    const run = async (v: string, src = "") => {
      const { project, diagnostics } = await loadProject({ ...files(yaml(v)), read: async (p) => (p === "scripts/CLU_2/T.lua" ? src : (await files(yaml(v)).read(p))) });
      expect(diagnostics).toEqual([]);
      return resolveProject(project!, registry);
    };
    const ok = await run("'a\\\"b\\r\\n'", "local resp = CLU_2->L->ResponseBody\n");
    expect(ok.diagnostics).toEqual([]);
    const c = ok.clus.find((x) => x.name === "CLU_2")!;
    expect(c.objects![0].features.find(([i]) => i === 8)?.[1]).toBe('a\\"b\\r\\n'); // verbatim, as OM writes it
    expect(c.scripts[0].source).toBe("local resp = HTT0001:get(8)\n");
    expect((await run("'a\"b'")).diagnostics.map((d) => d.message)).toEqual([expect.stringContaining("write a quote as")]);
  });

  it("a method with parameters called without arguments is refused (OM writes execute(0, ) then)", async () => {
    const r = await resolve(clu2(["modules:", "  - serial: 330000009", '    type: "0x1a"', '    comment: "02 02"', "    ios:", "      - id: DIM0001", "        class: DIMM", "        channel: 0", "        events:", "          OnSwitchOn:", "            - CLU_1->LAMP->SwitchOn()"].join("\n")));
    expect(r.diagnostics.map((d) => d.message)).toEqual([expect.stringContaining("pass at least the first argument of SwitchOn")]);
  });

  it("script calls in scripts: arguments copied as written (quotes too), multi-line calls refused", async () => {
    const yaml = clu2('scripts: [ { name: ELO, params: [ { name: p, type: string, default: d }, { name: n, type: number, default: 1 } ] }, { name: T } ]');
    const run = async (src: string) => {
      const { project, diagnostics } = await loadProject({ ...files(yaml), read: async (p) => (p === "scripts/CLU_2/T.lua" ? src : (await files(yaml).read(p))) });
      expect(diagnostics).toEqual([]);
      return resolveProject(project!, registry);
    };
    // observed (OM 1.13): CLU->s("x'x\"x""x3") → s("x'x\"x""x3", nil)
    const ok = await run('CLU_2->ELO("x\'x\\"x""x3")\n');
    expect(ok.diagnostics).toEqual([]);
    expect(ok.clus.find((c) => c.name === "CLU_2")!.scripts[1].source).toBe('ELO("x\'x\\"x""x3", nil)\n');
    // observed: OM turns this into broken Lua ( ELO("xxx, nil)("xxx ... ) — refused instead
    const bad = await run('CLU_2->ELO("xxx\nx2", 2)\n');
    expect(bad.diagnostics.map((d) => [d.file, d.range.start.line, d.message])).toEqual([["scripts/CLU_2/T.lua", 0, expect.stringContaining("must end on the same line")]]);
  });

  it("resolves names, local and remote actions, script calls and default names", async () => {
    const r = await resolve(
      clu2(
        [
          "modules:",
          "  - serial: 330000009",
          '    type: "0x1a"',
          '    comment: "02 02"',
          "    ios:",
          "      - id: DIM0001",
          "        class: DIMM",
          "        channel: 0",
          "        features: { MinValue: 0.32, \"3\": 1 }",
          "        events:",
          "          OnSwitchOn:",
          "            - CLU_2->DIM0001->SwitchOff(0, 0)",
          "            - CLU_1->LAMP->SwitchOn(0, 500)",
          "            - CLU_2->ELO()",
          "            - lua: print(\"x\")",
          "scripts: [ { name: ELO } ]",
        ].join("\n"),
      ),
    );
    expect(r.diagnostics.map((d) => d.message)).toEqual([]);
    const c = r.clus.find((x) => x.name === "CLU_2")!;
    expect(c.remotes).toEqual([{ id: "CLU100000011", ip: "10.0.0.11" }]);
    const io = c.modules[0].ios[0];
    expect(io).toMatchObject({ objectClass: 5, name: "x330000009_DIMM_01" });
    expect(io.features[1]).toEqual([3, 1]);
    expect(io.events[0].actions).toEqual([
      expect.stringMatching(/^DIM0001:execute\(\d+, 0, 0\)$/),
      expect.stringMatching(/^CLU100000011:execute\(0, "DIM0020:execute\(\d+, 0, 500\)"\)$/),
      "ELO(nil)",
      'print("x")',
    ]);
  });

  it("reports unknown names and unobserved forms instead of guessing", async () => {
    const r = await resolve(
      clu2(
        [
          "  # (clu events)",
          "modules:",
          "  - serial: 330000009",
          '    type: "0x1a"',
          '    comment: "02 02"',
          "    ios:",
          "      - id: DIM0001",
          "        class: 5",
          "        channel: 0",
          "        features: { Nope: 1 }",
          "        events:",
          "          OnSwitchOn:",
          "            - CLU_9->X->Y(0)",
          "            - CLU_1->LAMP->Nope(0)",
          "            - CLU_1->ELO()",
          "            - CLU_2->ELO(1, 2)",
          "            - CLU_2->DIM0001->SwitchOn(1, 2, 3)",
          "scripts: [ { name: ELO, params: [ { name: a, type: number, default: 1 } ] } ]",
        ].join("\n"),
      ),
    );
    const msgs = r.diagnostics.map((d) => d.message);
    expect(msgs).toEqual([
      expect.stringMatching(/^CLU_2\/DIM0001: unknown feature "Nope" \(known: /),
      'action "CLU_9->X->Y(0)": no CLU named CLU_9 in this project',
      expect.stringMatching(/^action "CLU_1->LAMP->Nope\(0\)": DIM0020 has no method Nope/),
      'action "CLU_1->ELO()": no script or CLU method ELO on CLU_1',
      'action "CLU_2->ELO(1, 2)": ELO takes 1 argument(s), got 2',
      'action "CLU_2->DIM0001->SwitchOn(1, 2, 3)": SwitchOn takes at most 2 argument(s), got 3',
    ]);
  });
});

// Import of two real CLUs of one house that call each other: actions become friendly OM actions,
// and the project still generates both files byte for byte.
describe("friendly import (real-clu2 + real-modbus)", () => {
  it("writes friendly actions and round-trips byte-exact", async () => {
    const texts = ["real-clu2.OM.LUA", "real-modbus.OM.LUA"].map(fixture);
    const clus = texts.map((t) => parseOmLua(t).clu);
    expect(clus[0].remotes.map((r) => r.id)).toContain(clus[1].id); // they reference each other
    const index = buildIndex(clus, registry);
    const projectClus = new Map(clus.map((c) => [c.id, c.name]));
    const files: Record<string, string> = { "opengr8on.yaml": "format: 1\nname: T\n" };
    let friendly = 0;
    const raw: string[] = [];
    for (const c of clus) {
      files[`clus/${c.name}.yaml`] = cluToYaml(c, registry, {
        projectClus,
        friendly: (line) => {
          const f = friendlyAction(index, c.name, line);
          if (f) friendly++;
          else raw.push(line);
          return f;
        },
      });
    }
    expect(friendly).toBeGreaterThan(40);
    // what stays raw: calls to CLUs outside this two-CLU project (vCLU mqtt, GATEs)
    const ids = new Set(clus.map((c) => c.id));
    // or objects whose interface has no such execute method (Z-Wave without XML, unknown index)
    const unexplained = raw.filter((l) => {
      const m = /^(CLU\d+):execute\(0, "([A-Z]{3}\d{4}):execute\((\d+)/.exec(l);
      if (!/^(CLU\d+):execute\(0, /.test(l)) return true;
      if (!ids.has(/^(CLU\d+)/.exec(l)![1])) return false;
      const target = [...index.values()].find((c) => c.clu.id === m?.[1]);
      const o = m ? target?.byId.get(m[2]) : undefined;
      return !!o?.iface?.methods.some((x) => x.call === "execute" && x.index === Number(m![3]));
    });
    expect(unexplained).toEqual([]);
    expect(files["clus/CLU_2.yaml"]).toMatch(/- CLU_2->[A-Za-z_]\w*->\w+\(/);
    expect(files["clus/CLU_2.yaml"]).toMatch(/- CLU_1->[A-Za-z_]\w*->\w+\(/); // remote, friendly
    const { project, diagnostics } = await loadProject(mem(files));
    expect(diagnostics).toEqual([]);
    const r = resolveProject(project!, registry);
    expect(r.diagnostics).toEqual([]);
    clus.forEach((c, k) => {
      const out = r.clus.find((x) => x.name === c.name)!;
      expect(emitOmLua(out, { eol: "\r\n" })).toBe(texts[k]);
    });
  });
});

describe("OM notation in scripts", () => {
  const project = (script: string) =>
    mem({
      "opengr8on.yaml": "format: 1\nname: T\n",
      "clus/CLU_1.yaml": "clu: { name: CLU_1, serial: 100000011, ip: 10.0.0.11, hw: { type: 0x13, version: 1 }, fw: { type: 3, version: 0x203 } }\nmodules:\n  - serial: 330000020\n    type: \"0x1a\"\n    comment: \"02 02\"\n    ios:\n      - { id: DIM0020, class: 5, channel: 0, name: ROLETA1 }\n",
      "clus/CLU_2.yaml": "clu: { name: CLU_2, serial: 100000012, ip: 10.0.0.12, hw: { type: 0x13, version: 1 }, fw: { type: 3, version: 0x203 } }\nmodules:\n  - serial: 330000009\n    type: \"0x1a\"\n    comment: \"02 02\"\n    ios:\n      - { id: DIM0001, class: 5, channel: 0, name: LAMP }\nscripts: [ { name: test } ]\n",
      "scripts/CLU_2/test.lua": script,
    });
  const run = async (script: string) => {
    const { project: p, diagnostics } = await loadProject(project(script));
    expect(diagnostics).toEqual([]);
    const r = resolveProject(p!, registry);
    return { source: r.clus.find((c) => c.name === "CLU_2")!.scripts[0].source, errors: r.diagnostics.map((d) => `${d.range.start.line + 1}:${d.range.start.col + 1} ${d.message}`) };
  };

  it("compiles the forms observed in OM output (local call, remote read) and the inferred ones", async () => {
    const r = await run(
      [
        "CLU_2->LAMP->SwitchOn(x, 500)", // local call, args verbatim (confirmed)
        "print(CLU_1->ROLETA1->Value)", // remote read (confirmed)
        "local v = CLU_2->LAMP->Value", // local read (inferred)
        "CLU_1->ROLETA1->SwitchOff(0)", // remote call, literal args (inferred)
        'print("CLU_2->LAMP->Value") -- CLU_2->LAMP->Value', // strings / comments untouched
      ].join("\n"),
    );
    expect(r.errors).toEqual([]);
    expect(r.source.split("\n")).toEqual([
      expect.stringMatching(/^DIM0001:execute\(\d+, x, 500\)$/),
      'print(CLU100000011:execute(0, "DIM0020:get(0)"))',
      "local v = DIM0001:get(0)",
      expect.stringMatching(/^CLU100000011:execute\(0, "DIM0020:execute\(\d+, 0\)"\)$/),
      'print("CLU_2->LAMP->Value") -- CLU_2->LAMP->Value',
    ]);
  });

  it("compiles the dotted form when it starts with a project CLU, leaves other Lua alone", async () => {
    const r = await run(["print(CLU_1.ROLETA1.Value)", "CLU_2.LAMP.SwitchOn(x, 500)", "local s = string.format('%d', t.x)", "y = CLU_2.LAMPA.Value"].join("\n"));
    expect(r.errors).toEqual(["4:5 CLU_2.LAMPA.Value: no object LAMPA on CLU_2"]);
    const ok = await run(["print(CLU_1.ROLETA1.Value)", "CLU_2.LAMP.SwitchOn(x, 500)", "local s = string.format('%d', t.x)"].join("\n"));
    expect(ok.source.split("\n")).toEqual([
      'print(CLU100000011:execute(0, "DIM0020:get(0)"))',
      expect.stringMatching(/^DIM0001:execute\(\d+, x, 500\)$/),
      "local s = string.format('%d', t.x)",
    ]);
  });

  it("compiles set-type methods; enum arguments by name or number", async () => {
    const r = await run(["CLU_2->LAMP->SetRampTime(500)", "CLU_1->ROLETA1->SetMinValue(0.2)"].join("\n"));
    expect(r.errors).toEqual([]);
    expect(r.source.split("\n")).toEqual([
      expect.stringMatching(/^DIM0001:set\(\d+, 500\)$/),
      expect.stringMatching(/^CLU100000011:execute\(0, "DIM0020:set\(\d+, 0\.2\)"\)$/),
    ]);
  });

  it("compiles feature assignments (remote: observed in OM; local: inferred)", async () => {
    const r = await run(["CLU_1->ROLETA1->Value = 1", "CLU_2->LAMP->RampTime = x * 2", "CLU_2->LAMP->MinValue = 0.2 -- c"].join("\n"));
    expect(r.errors).toEqual([]);
    expect(r.source.split("\n")).toEqual([
      'CLU100000011:execute(0, "DIM0020:set(0, 1)")',
      expect.stringMatching(/^DIM0001:set\(\d+, x \* 2\)$/),
      expect.stringMatching(/^DIM0001:set\(\d+, 0\.2\) -- c$/),
    ]);
    const bad = await run("CLU_1->ROLETA1->Value = y");
    expect(bad.errors).toEqual(["1:1 CLU_1->ROLETA1->Value = y: the value of an assignment on another CLU must be a literal (it is evaluated there)"]);
  });

  it("reports unknown names and unobserved forms at their position", async () => {
    const r = await run(["CLU_2->LAMP->Valuee = 1", "x = CLU_2->LAMPA->Value", "x = CLU_2->LAMP->Nope", "CLU_1->ROLETA1->SwitchOn(v, 1)", "CLU_9->X->Y"].join("\n"));
    expect(r.errors).toEqual([
      expect.stringMatching(/^1:1 CLU_2->LAMP->Valuee: DIM0001 has no feature Valuee/),
      "2:5 CLU_2->LAMPA->Value: no object LAMPA on CLU_2",
      expect.stringMatching(/^3:5 CLU_2->LAMP->Nope: DIM0001 has no feature Nope/),
      "4:1 CLU_1->ROLETA1->SwitchOn: arguments of a call on another CLU must be literals (they are evaluated there)",
      "5:1 CLU_9->X->Y: no CLU named CLU_9 in this project",
    ]);
  });
});

// Virtual objects + OM notation from sanitized fixtures only: three CLUs of one house; the removed
// Thermostat's table features written as OM references, the test script with CLU->OBJ->Member.
describe("real-117: virtual objects, table references, CluOnInit, OM notation", () => {
  // two captured versions of the .117 test script: a (local panel calls, remote read) and b (set
  // methods, feature assignment, remote script call, Polish UTF-8 comment)
  it.each([
    ["real-117.test.lua", "real-117.USER.LUA"],
    ["real-117b.test.lua", "real-117b.USER.LUA"],
  ])("generates OM.LUA and USER.LUA identical to OM's (%s)", async (sourceFile, userFile) => {
    const names = ["real-clu2.OM.LUA", "real-modbus.OM.LUA", "real-117.OM.LUA"];
    const texts = names.map(fixture);
    const clus = texts.map((t) => parseOmLua(t).clu);
    const c117 = clus[2];
    const the = c117.objects!.find((o) => o.id === "THE2961")!;
    const panName = c117.modules.flatMap((m) => m.ios).find((io) => io.id === "PAN9387")!.name!;
    // what OM stores in the .omp for these two table features (sanitized)
    the.version = 2;
    the.features[0][1] = `${c117.id}->${panName}->Value`;
    the.features[1][1] = "CLU_2->x520093698_AnalogOUT_01->Value";
    c117.scripts = [{ name: "test", params: [], source: fixture(sourceFile) }];
    clus[1].scripts = [{ name: "elo2", params: [], source: "" }]; // CLU_1's script called remotely in b
    const projectClus = new Map(clus.map((c) => [c.id, c.name]));
    const files: Record<string, string> = {
      "opengr8on.yaml": "format: 1\nname: T\n",
      [`scripts/${c117.name}/test.lua`]: fixture(sourceFile),
      [`scripts/${clus[1].name}/elo2.lua`]: "",
    };
    for (const c of clus) files[`clus/${c.name}.yaml`] = cluToYaml(c, registry, { projectClus });
    expect(files[`clus/${c117.name}.yaml`]).toMatch(/objects:\n  - id: TIM8908\n    class: Timer\n    version: 1\n    name: t\n/);
    expect(files[`clus/${c117.name}.yaml`]).toMatch(/class: Thermostat\n    version: 2\n    name: hh\n    removed: true\n    features:\n      Source: CLU900000006->/);
    const { project, diagnostics } = await loadProject(mem(files));
    expect(diagnostics).toEqual([]);
    const r = resolveProject(project!, registry);
    expect(r.diagnostics).toEqual([]);
    const out = r.clus.find((c) => c.name === c117.name)!;
    expect(emitOmLua(out, { eol: "\n" })).toBe(texts[2]);
    expect(emitUserLua(out, { eol: "\n" })).toBe(fixture(userFile));
  });

  it("reports table references that were not observed", async () => {
    const clus = ["real-clu2.OM.LUA", "real-117.OM.LUA"].map((n) => parseOmLua(fixture(n)).clu);
    const the = clus[1].objects!.find((o) => o.id === "THE2961")!;
    the.version = 2;
    the.features[0][1] = "CLU_2->x520093698_AnalogOUT_01->Value"; // Source on another CLU: not observed
    const files: Record<string, string> = { "opengr8on.yaml": "format: 1\nname: T\n" };
    for (const c of clus) files[`clus/${c.name}.yaml`] = cluToYaml(c, registry, { projectClus: new Map(clus.map((x) => [x.id, x.name])) });
    const { project } = await loadProject(mem(files));
    const r = resolveProject(project!, registry);
    expect(r.diagnostics.map((d) => d.message)).toEqual([expect.stringMatching(/THE2961\.Source: a remote reference for Source is not observed in OM output yet/)]);
  });
});
