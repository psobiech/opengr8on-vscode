import { LivePoller, batchExpression, chunks, luaArg, methodCall, parseBatch } from "../../src/device/liveValues";

describe("batch read", () => {
  it("builds one expression joined by the unit separator", () => {
    expect(batchExpression([{ id: "DIM1186", index: 0 }, { id: "ANA0001", index: 3 }])).toBe(
      'tostring(DIM1186:get(0)).."\\31"..tostring(ANA0001:get(3))',
    );
    expect(() => batchExpression([{ id: "x); os.exit(", index: 0 }])).toThrow(/invalid object id/);
    expect(() => batchExpression([])).toThrow();
  });

  it("splits answers and rejects mismatches", () => {
    expect(parseBatch("0.5\x1fnil\x1fabc", 3)).toEqual(["0.5", "nil", "abc"]);
    expect(() => parseBatch("attempt to index a nil value", 2)).toThrow(/1 values for 2 reads/);
  });

  it("chunks", () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("method calls", () => {
  it("compiles set/execute like OM actions", () => {
    expect(methodCall("DIM1186", { call: "set", index: 0, params: [{ type: "num" }] }, ["0.5"])).toBe("DIM1186:set(0, 0.5)");
    expect(methodCall("LED0173", { call: "execute", index: 4, params: [{ type: "num" }, { type: "num" }] }, ["255", " 1000 "])).toBe("LED0173:execute(4, 255, 1000)");
    expect(methodCall("PAN0001", { call: "execute", index: 2, params: [{ type: "str" }] }, ['a"b'])).toBe('PAN0001:execute(2, "a\\"b")');
    expect(methodCall("DOU0001", { call: "execute", index: 1, params: [] }, [])).toBe("DOU0001:execute(1)");
  });

  it("validates arguments", () => {
    expect(() => luaArg("num", "abc")).toThrow(/not a number/);
    expect(() => luaArg("num", "")).toThrow(/not a number/);
    expect(() => luaArg("int", "1.5")).toThrow(/not an integer/);
    expect(luaArg("num", "true")).toBe("true");
    expect(() => methodCall("A", { call: "get", index: 0, params: [] }, [])).toThrow(/unsupported/);
    expect(() => methodCall("A", { call: "set", index: 0, params: [{ type: "num" }] }, [])).toThrow(/expected 1/);
  });
});

describe("LivePoller", () => {
  it("reads watched features per CLU in batches and reports changes and errors", async () => {
    const scripts: Array<[number, string]> = [];
    let answer = (n: number) => Array.from({ length: n }, (_, i) => String(i)).join("\x1f");
    const exec = async (serial: number, s: string) => {
      scripts.push([serial, s]);
      if (serial === 2) throw new Error("no answer");
      return answer(s.split("tostring(").length - 1);
    };
    let changes = 0;
    const p = new LivePoller(exec, () => changes++, 60_000);
    p.watch(1, "io:A", [{ id: "A", index: 0 }, { id: "A", index: 1 }]);
    p.watch(1, "io:A2", [{ id: "A", index: 1 }]); // duplicate read from another owner
    await p.tick();
    expect(scripts.at(-1)).toEqual([1, 'tostring(A:get(0)).."\\31"..tostring(A:get(1))']);
    expect(p.value(1, { id: "A", index: 1 })).toBe("1");
    expect(changes).toBeGreaterThan(0);

    const before = changes;
    await p.tick(); // same values: no change event
    expect(changes).toBe(before);

    answer = () => "7\x1f8";
    await p.tick();
    expect(p.value(1, { id: "A", index: 0 })).toBe("7");
    expect(changes).toBe(before + 1);

    p.watch(2, "io:B", [{ id: "B", index: 0 }]);
    await p.tick();
    expect(p.error(2)).toBeUndefined(); // one lost answer is not reported (UDP)
    await p.tick();
    expect(p.error(2)).toBe("no answer");

    p.unwatch(2, "io:B");
    p.unwatch(1, "io:A");
    scripts.length = 0;
    await p.tick();
    expect(scripts).toEqual([[1, "tostring(A:get(1))"]]); // io:A2 still watches A/1
    p.dispose();
  });
});
