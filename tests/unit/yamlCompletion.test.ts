import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { loadInterfaceRegistry } from "../../src/interfaces/registry";
import { buildIndex, yamlCompletion, yamlContext } from "../../src/project/assist";
import { loadProject } from "../../src/project/load";
import { resolveProject } from "../../src/project/resolve";

const root = path.join(__dirname, "../../docs/demo");
let index: ReturnType<typeof buildIndex>;
beforeAll(async () => {
  const { project } = await loadProject({
    read: async (p) => { try { return readFileSync(path.join(root, p), "utf8"); } catch { return undefined; } },
    list: async (d) => { try { return readdirSync(path.join(root, d)); } catch { return []; } },
  });
  registry = loadInterfaceRegistry(path.join(__dirname, "../../dist/interfaces"));
  index = buildIndex(resolveProject(project!, registry).clus, registry);
});

// the user's case: a button with a features block, cursor on a new line inside it
const base = readFileSync(path.join(root, "clus/PARTER.yaml"), "utf8").replace(
  "      - { id: BUT1004, class: 7, channel: 3, name: PRZYCISK_WSZYSTKO_OFF }",
  "      - id: BUT1004\n        class: 7\n        channel: 3\n        name: PRZYCISK_WSZYSTKO_OFF\n        features:\n          Mode: 0\n          HoldDelay: 1000\n          HoldInterval: 100\n          DistributedLogicGroup: 0\n          |\n        events:\n          OnClick:\n            - |\n",
);
/** text with a cursor at the n-th "|" (others removed) */
const at = (text: string, n: number) => {
  let k = -1;
  let offset = 0;
  const clean = text.replace(/\|/g, (_m, pos: number) => {
    if (++k === n) offset = pos - k;
    return "";
  });
  const linePrefix = clean.slice(clean.lastIndexOf("\n", offset - 1) + 1, offset);
  return { clean, offset, linePrefix };
};
let registry: ReturnType<typeof loadInterfaceRegistry>;
const complete = (text: string, n = 0) => {
  const { clean, offset, linePrefix } = at(text, n);
  return yamlCompletion(index, index.get("PARTER"), clean, offset, linePrefix, registry);
};

describe("YAML completion context (line based, works while typing)", () => {
  it("offers only this button's settable features in its features block (set ones last), never CLU methods", () => {
    const { items } = complete(base, 0);
    expect(items.map((i) => i.label)).toEqual(["Mode", "HoldDelay", "HoldInterval", "DistributedLogicGroup"]);
    expect(items.every((i) => i.detail.startsWith("already set"))).toBe(true);
    expect(items.map((i) => i.label)).not.toContain("AddToLog");
    expect(items.map((i) => i.label)).not.toContain("Value"); // read-only
    const ctx = yamlContext(at(base, 0).clean, at(base, 0).offset);
    expect(ctx).toMatchObject({ kind: "featureKey", owner: "io", id: "BUT1004" });
  });

  it("offers the allowed values after `Mode: `", () => {
    const { items } = complete(base.replace("          Mode: 0", "          Mode: |").replace("          |\n", ""), 0);
    expect(items.map((i) => [i.label, i.insert, i.detail])).toEqual([
      ["Monostable", "Monostable", "= 0 (default)"],
      ["Bistable", "Bistable", "= 1"],
      ["Locked", "Locked", "= 2"],
    ]);
  });

  it("offers only the keys allowed in an IO item", () => {
    const { items } = complete(base.replace("        name: PRZYCISK_WSZYSTKO_OFF\n", "        name: PRZYCISK_WSZYSTKO_OFF\n        |\n").replace("          |\n", "").replace("            - |\n", "            - x\n"), 0);
    expect(items.map((i) => i.label)).toEqual(["inactive"]); // id, class, channel, name, features, events present
  });

  it("uses class + module type for an object that is not in the project index yet", () => {
    const text = base.replace("      - id: BUT1004", "      - id: BUT9999\n        class: 7\n        channel: 0\n        features:\n          |\n      - id: BUT1004").replace("          |\n          HoldDelay", "          HoldDelay").replace("          DistributedLogicGroup: 0\n          |\n", "          DistributedLogicGroup: 0\n");
    const { items } = complete(text, 0);
    expect(items.map((i) => i.label)).toEqual(["Mode", "HoldDelay", "HoldInterval", "DistributedLogicGroup"]);
  });

  it("works with a partly typed key and with fewer keys present", () => {
    const text = base.replace("          HoldDelay: 1000\n          HoldInterval: 100\n", "");
    const { items, replaceLength } = complete(text.replace("          |", "          Hol|"), 0);
    expect(items.filter((i) => !i.detail.startsWith("already set")).map((i) => i.label)).toEqual(["HoldDelay", "HoldInterval"]);
    expect(replaceLength).toBe(3);
  });

  it("offers actions on an event's list item", () => {
    const { items } = complete(base.replace("            - |", "            - PARTER->LAMPA_S|"), 1);
    expect(items.map((i) => i.label)).toContain("LAMPA_SALON");
  });

  it("offers CLU features under clu: features, and virtual-object features", () => {
    const clu = complete(base.replace("    UseCloud: 0\n", "    UseCloud: 0\n    |\n"), 0);
    expect(clu.items.length).toBeGreaterThan(3);
    expect(clu.items.find((i) => i.label === "UseCloud")?.detail).toMatch(/^already set/);
    expect(clu.items.map((i) => i.label)).not.toContain("AddToLog"); // a CLU method
    const timer = complete(base.replace("    features: { Time: 600, Mode: CountDown }", "    features:\n      |"), 2); // 3rd cursor mark
    expect(timer.items.map((i) => i.label)).toEqual(expect.arrayContaining(["Time", "Mode"]));
  });

  it("offers event names under events:", () => {
    const { items } = complete(base.replace("          OnClick:", "          |\n          OnClick:"), 0);
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(["OnSwitchOn", "OnLongPress"]));
    expect(items.find((i) => i.label === "OnClick")?.detail).toMatch(/^already used/);
  });
});
