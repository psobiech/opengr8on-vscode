import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { loadInterfaceRegistry } from "../../src/interfaces/registry";
import { loadProject } from "../../src/project/load";
import { resolveProject } from "../../src/project/resolve";

// Feature values are checked against the interface XML. The rules hold for all real OM output (the
// round-trip / acceptance tests resolve real projects with zero diagnostics).
const root = path.join(__dirname, "../../docs/demo");
const registry = loadInterfaceRegistry(path.join(__dirname, "../../dist/interfaces"));

async function resolveWith(features: string) {
  const parter = readFileSync(path.join(root, "clus/PARTER.yaml"), "utf8").replace(
    "      - { id: BUT1004, class: 7, channel: 3, name: PRZYCISK_WSZYSTKO_OFF }",
    `      - id: BUT1004\n        class: 7\n        channel: 3\n        name: PRZYCISK_WSZYSTKO_OFF\n        features:\n${features}`,
  );
  const files = (p: string) => (p === "clus/PARTER.yaml" ? parter : (() => { try { return readFileSync(path.join(root, p), "utf8"); } catch { return undefined; } })());
  const { project, diagnostics } = await loadProject({ read: async (p) => files(p), list: async (d) => { try { return readdirSync(path.join(root, d)); } catch { return []; } } });
  expect(diagnostics).toEqual([]);
  return resolveProject(project!, registry).diagnostics.map((d) => `${d.range.start.line + 1}: ${d.message}`);
}

describe("feature validation", () => {
  it("accepts valid features (the user's example without the typo)", async () => {
    expect(await resolveWith("          Mode: 0\n          HoldDelay: 1000\n          HoldInterval: 100\n          DistributedLogicGroup: 0\n")).toEqual([]);
  });

  it("reports unknown features, wrong types, enums, ranges and read-only features", async () => {
    const msgs = await resolveWith(
      ["          Dupa: 1", "          Mode: 7", "          HoldDelay: \"x\"", "          HoldInterval: 99999999", "          Value: 1"].map((l) => l + "\n").join(""),
    );
    expect(msgs).toEqual([
      expect.stringMatching(/: PARTER\/BUT1004: unknown feature "Dupa" \(known: Mode, HoldDelay, HoldInterval, Value, DistributedLogicGroup\)$/),
      expect.stringMatching(/: PARTER\/BUT1004: Mode must be one of Monostable, Bistable, Locked, got 7$/),
      expect.stringMatching(/: PARTER\/BUT1004: HoldDelay expects a number, got "x"$/),
      expect.stringMatching(/: PARTER\/BUT1004: HoldInterval must be in \d+\.\.\d+.*, got 99999999$/),
      expect.stringMatching(/: PARTER\/BUT1004: Value is read-only and cannot be set$/),
    ]);
  });
});

describe("enum features by name", () => {
  it("accepts names (and numbers), rejects unknown names", async () => {
    expect(await resolveWith("          Mode: Bistable\n          HoldDelay: 1000\n")).toEqual([]);
    expect(await resolveWith("          Mode: 1\n")).toEqual([]);
    expect(await resolveWith("          Mode: Bistabilny\n")).toEqual([expect.stringMatching(/Mode must be one of Monostable, Bistable, Locked, got "Bistabilny"$/)]);
  });
});

describe("set-method actions with enum arguments", () => {
  it("accepts SetMode(Bistable) and SetMode(1), rejects unknown names", async () => {
    const withAction = async (action: string) => {
      const parter = readFileSync(path.join(root, "clus/PARTER.yaml"), "utf8").replace("            - PARTER->LAMPA_SALON->Switch(0)", `            - ${action}`);
      const files = (p: string) => (p === "clus/PARTER.yaml" ? parter : (() => { try { return readFileSync(path.join(root, p), "utf8"); } catch { return undefined; } })());
      const { project } = await loadProject({ read: async (p) => files(p), list: async (d) => { try { return readdirSync(path.join(root, d)); } catch { return []; } } });
      const r = resolveProject(project!, registry);
      const but = r.clus.find((c) => c.name === "PARTER")!.modules.flatMap((m) => m.ios).find((io) => io.id === "BUT1001")!;
      return { errors: r.diagnostics.map((d) => d.message), actions: but.events[0]?.actions };
    };
    expect(await withAction("PARTER->PRZYCISK_WSZYSTKO_OFF->SetMode(Bistable)")).toEqual({ errors: [], actions: ["BUT1004:set(1, 1)"] });
    expect(await withAction("PARTER->PRZYCISK_WSZYSTKO_OFF->SetMode(1)")).toEqual({ errors: [], actions: ["BUT1004:set(1, 1)"] });
    expect((await withAction("PARTER->PRZYCISK_WSZYSTKO_OFF->SetMode(Bistabilny)")).errors).toEqual([
      expect.stringMatching(/SetMode\(Bistabilny\)": Mode must be one of Monostable, Bistable, Locked, got Bistabilny$/),
    ]);
  });
});
