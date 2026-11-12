import { readFileSync } from "node:fs";
import * as path from "node:path";
import { addObjectToCluYaml, addScriptToCluYaml } from "../../src/project/edit";

const demo = (f: string) => readFileSync(path.join(__dirname, "../../docs/demo/clus", f), "utf8");

describe("addScriptToCluYaml", () => {
  it("appends to an existing scripts list and changes nothing else", () => {
    const before = demo("PARTER.yaml");
    const after = addScriptToCluYaml(before, "nowy_skrypt");
    expect(after).toBe(before.replace(/(scripts:\n  - name: zamknij_rolety\n)/, "$1  - name: nowy_skrypt\n"));
  });

  it("creates the scripts list when missing, keeping the rest", () => {
    const before = demo("PIETRO.yaml");
    const after = addScriptToCluYaml(before, "test");
    expect(after.startsWith(before.trimEnd())).toBe(true);
    expect(after.slice(before.trimEnd().length)).toBe("\nscripts:\n  - name: test\n");
  });

  it("keeps comments and flow lists; rejects bad / duplicate names", () => {
    expect(addScriptToCluYaml("# top\nclu: { name: A }  # c\nscripts: [ { name: a } ]\n", "b")).toBe("# top\nclu: { name: A } # c\nscripts: [ { name: a }, { name: b } ]\n");
    expect(() => addScriptToCluYaml("clu: {}\n", "1x")).toThrow(/not a valid script name/);
    expect(() => addScriptToCluYaml("clu: {}\nscripts: [ { name: a } ]\n", "a")).toThrow(/already exists/);
  });
});

describe("addObjectToCluYaml", () => {
  it("appends a virtual object (creating objects:), keeps comments, refuses duplicates", () => {
    const yaml = "# CLU file\nclu:\n  name: CLU_1\n";
    const out = addObjectToCluYaml(yaml, { id: "TIM1234", className: "Timer", version: 1, name: "t2" });
    expect(out).toBe("# CLU file\nclu:\n  name: CLU_1\nobjects:\n  - id: TIM1234\n    class: Timer\n    version: 1\n    name: t2\n");
    const two = addObjectToCluYaml(out, { id: "CAL0001", className: "Calendar", name: "cal" });
    expect(two).toContain("  - id: CAL0001\n    class: Calendar\n    name: cal\n");
    expect(() => addObjectToCluYaml(two, { id: "TIM9999", className: "Timer", name: "t2" })).toThrow(/already exists/);
    expect(() => addObjectToCluYaml(two, { id: "X1", className: "Timer", name: "1bad" })).toThrow(/not a valid object name/);
  });
});
