import { readFileSync } from "node:fs";
import * as path from "node:path";
import { loadProject, type ProjectFiles } from "../../src/project/load";

function memFiles(files: Record<string, string>): ProjectFiles {
  return {
    read: async (p) => files[p],
    list: async (dir) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/")).map((p) => p.slice(dir.length + 1)),
  };
}

// The CLU example of docs/PROJECT_FORMAT.md, so the frozen doc and the loader cannot drift apart.
const doc = readFileSync(path.join(__dirname, "../../docs/PROJECT_FORMAT.md"), "utf8");
const docClu = /## clus\/<name>\.yaml\n\n```yaml\n([\s\S]*?)```/.exec(doc)![1];
const docRoot = /## opengr8on\.yaml\n\n```yaml\n([\s\S]*?)```/.exec(doc)![1];

const base = (extra: Record<string, string> = {}) =>
  memFiles({
    "opengr8on.yaml": docRoot,
    "clus/CLU_2.yaml": docClu,
    "clus/CLU_1.yaml": "clu:\n  name: CLU_1\n  serial: 900000002\n  ip: 192.168.1.102\n  hw: { type: 0x13, version: 1 }\n  fw: { type: 3, version: 0x203 }\n",
    "scripts/CLU_2/ELO.lua": "print(1)\n",
    ...extra,
  });

const messages = (r: Awaited<ReturnType<typeof loadProject>>) => r.diagnostics.map((d) => `${d.file}:${d.range.start.line + 1}: ${d.message}`);

describe("loadProject", () => {
  it("loads the documented example without diagnostics, in document order", async () => {
    const r = await loadProject(base());
    expect(messages(r)).toEqual([]);
    const p = r.project!;
    expect(p.name).toBe("DOM");
    expect(p.clus.map((c) => c.name)).toEqual(["CLU_1", "CLU_2"]); // by file name
    const c = p.clus[1];
    expect(c).toMatchObject({ name: "CLU_2", serial: 900000001, id: "CLU900000001", ip: "192.168.1.101", hw: { type: 0x13, version: 1 }, fw: { type: 3, version: 0x203 } });
    expect(c.remotes?.map((x) => (x.kind === "clu" ? x.name : `${x.id}@${x.ip}`))).toEqual(["CLU_1", "CLU1@192.168.1.110"]);
    expect(c.features.map((f) => [f.key, f.value])).toEqual([["UseCloud", 0]]);
    expect(c.events.map((e) => [e.key, e.value.map((a) => `${a.kind}:${a.text}`)])).toEqual([
      ["OnInit", ["om:CLU_2->IO_DIM1186->SwitchOn(0)"]],
      ["13", ["lua:ELO(nil)"]],
    ]);
    const m = c.modules[0];
    expect(m).toMatchObject({ serial: 520093697, typeLiteral: "0x1a", commentTail: "02 02" });
    expect(m.ios[0]).toMatchObject({ id: "DIM1186", objectClass: 5, channel: 0, name: "IO_DIM1186", inactive: false });
    expect(m.ios[0].features.map((f) => [f.key, f.value])).toEqual([["RampTime", 500], ["MinValue", 0.32]]);
    expect(m.ios[0].events[0].value.map((a) => a.kind)).toEqual(["om", "lua"]);
    expect(c.scripts).toEqual([
      expect.objectContaining({
        name: "ELO",
        params: [
          { name: "txt", type: "string", default: "domyslna" },
          { name: "dd", type: "number", default: 1, range: [1, 10] },
          { name: "on", type: "boolean", default: true },
        ],
        file: "scripts/CLU_2/ELO.lua",
        source: "print(1)\n",
      }),
    ]);
    expect(c.variables.map(({ name, type, value, persist }) => ({ name, type, value, persist }))).toEqual([
      { name: "cecha", type: "string", value: "aas", persist: true },
      { name: "licznik", type: "number", value: 4, persist: false },
    ]);
    expect(c.ioOrder).toEqual(["DIM1186"]);
    expect(p.clus[0].remotes).toBeUndefined(); // default
    expect(p.clus[0].ioOrder).toBeUndefined();
  });

  it("keeps integer-like keys in document order", async () => {
    const r = await loadProject(base({ "clus/CLU_1.yaml": "clu:\n  name: CLU_1\n  serial: 2\n  ip: 10.0.0.2\n  hw: { type: 1, version: 1 }\n  fw: { type: 1, version: 1 }\n  features:\n    Zed: 1\n    \"18\": 2\n    3: 3\n" }));
    expect(r.project!.clus[0].features.map((f) => f.key)).toEqual(["Zed", "18", "3"]);
  });

  it("reports structural errors with positions", async () => {
    const r = await loadProject(
      base({
        "clus/CLU_1.yaml": [
          "clu:",
          "  name: CLU_X",
          "  serial: 900000001",
          "  ip: 300.1.1.1",
          "  hw: { type: 1 }",
          "  fw: { type: 1, version: 1 }",
          "  colour: red",
          "modules:",
          "  - serial: 5",
          "    type: 0x1a",
          "    comment: ''",
          "    ios:",
          "      - { id: dim1, class: 5, channel: 0 }",
          "      - { id: DIM0001, class: 5, channel: 0 }",
          "      - { id: DIM0001, class: 5, channel: 0 }",
          "objects: [ {} ]",
          "scripts:",
          "  - name: missing",
        ].join("\n"),
      }),
    );
    expect(messages(r)).toEqual([
      'clus/CLU_1.yaml:7: clu: unknown key "colour" (allowed: name, serial, id, ip, netmask, gateway, hw, fw, remotes, ioOrder, features, events)',
      'clus/CLU_1.yaml:2: clu.name "CLU_X" must match the file name "CLU_1"',
      'clus/CLU_1.yaml:4: clu.ip: "300.1.1.1" is not valid (IPv4)',
      'clus/CLU_1.yaml:5: clu.hw: missing "version"',
      'clus/CLU_1.yaml:10: module 5.type: quote it ("0x…"): the literal is emitted verbatim, a number loses its zero padding',
      "clus/CLU_1.yaml:13: module 5.ios[0].id: \"dim1\" is not valid (3 capital letters + 4 digits, e.g. DIM1186)",
      'clus/CLU_1.yaml:16: objects[0]: missing "id"',
      'clus/CLU_1.yaml:16: objects[0]: missing "class"',
      'clus/CLU_1.yaml:16: objects[0]: missing "name"',
      "clus/CLU_1.yaml:18: script missing: scripts/CLU_X/missing.lua not found",
    ]);
    expect(r.diagnostics[0].range).toEqual({ start: { line: 6, col: 2 }, end: { line: 6, col: 8 } });
  });

  it("checks project-wide consistency", async () => {
    const r = await loadProject(
      base({
        "clus/CLU_1.yaml": "clu:\n  name: CLU_1\n  serial: 900000001\n  ip: 10.0.0.1\n  hw: { type: 1, version: 1 }\n  fw: { type: 1, version: 1 }\n  remotes: [CLU_9, CLU_1]\nmodules:\n  - { serial: 1, type: \"0x1a\", comment: '', ios: [ { id: DIM0001, class: 5, channel: 0 }, { id: DIM0002, class: 5, channel: 0 } ] }\n",
      }),
    );
    expect(messages(r)).toEqual([
      "clus/CLU_2.yaml:2: CLU serial 900000001 is also used by CLU_1",
      "clus/CLU_2.yaml:2: CLU id CLU900000001 is also used by CLU_1",
      "clus/CLU_1.yaml:7: remote CLU_9: no clus/CLU_9.yaml in this project",
      "clus/CLU_1.yaml:7: remote CLU_1: a CLU cannot be its own remote",
      "clus/CLU_1.yaml:9: DIM0002: same module, class and channel as DIM0001",
    ]);
  });

  it("checks ioOrder against the IOs", async () => {
    const r = await loadProject(base({ "clus/CLU_1.yaml": "clu:\n  name: CLU_1\n  serial: 2\n  ip: 10.0.0.2\n  hw: { type: 1, version: 1 }\n  fw: { type: 1, version: 1 }\n  ioOrder: [DIM0002, DIM0009]\nmodules:\n  - { serial: 1, type: \"0x1a\", comment: '', ios: [ { id: DIM0001, class: 5, channel: 0 }, { id: DIM0002, class: 5, channel: 1 } ] }\n" }));
    expect(messages(r)).toEqual(["clus/CLU_1.yaml:7: clu.ioOrder must list every IO exactly once; missing DIM0001; unknown DIM0009"]);
  });

  it("handles a missing root, unsupported format and YAML syntax errors", async () => {
    expect(messages(await loadProject(memFiles({})))).toEqual(["opengr8on.yaml:1: opengr8on.yaml not found"]);
    expect(messages(await loadProject(memFiles({ "opengr8on.yaml": "format: 2\nname: X\n" })))).toEqual([
      "opengr8on.yaml:1: format 2 is not supported by this extension (expected 1)",
    ]);
    const r = await loadProject(base({ "clus/CLU_1.yaml": "clu: [\n" }));
    expect(r.diagnostics.some((d) => d.file === "clus/CLU_1.yaml" && d.severity === "error")).toBe(true);
    expect(r.project!.clus.map((c) => c.name)).toEqual(["CLU_2"]);
  });
});
