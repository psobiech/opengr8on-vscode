import { findArrows, replaceArrows } from "../../src/lua/arrows";

const brief = (src: string) => findArrows(src).map((r) => [r.kind, r.clu, r.object, r.member, r.args ?? r.expr, src.slice(r.start, r.end)]);

describe("findArrows", () => {
  it("finds reads, assignments, calls and CLU-level members (shapes from real OM scripts)", () => {
    const src = [
      "print(CLU_1->ROLETA1_KUCHNIA->State)",
      "  CLU_2->PANEL_01->ClearScreen()",
      'if a then CLU_2->PANEL_01->PrintText(x, y, text:sub(k, k), 1) end',
      "CLU_2->LAMP->Value = x + 1 -- comment",
      "print(DEVCLU->Uptime)",
      "CLU_2->ELO()",
    ].join("\n");
    expect(brief(src)).toEqual([
      ["read", "CLU_1", "ROLETA1_KUCHNIA", "State", undefined, "CLU_1->ROLETA1_KUCHNIA->State"],
      ["call", "CLU_2", "PANEL_01", "ClearScreen", "", "CLU_2->PANEL_01->ClearScreen()"],
      ["call", "CLU_2", "PANEL_01", "PrintText", "x, y, text:sub(k, k), 1", "CLU_2->PANEL_01->PrintText(x, y, text:sub(k, k), 1)"],
      ["assign", "CLU_2", "LAMP", "Value", "x + 1", "CLU_2->LAMP->Value = x + 1"],
      ["read", "DEVCLU", undefined, "Uptime", undefined, "DEVCLU->Uptime"],
      ["call", "CLU_2", undefined, "ELO", "", "CLU_2->ELO()"],
    ]);
    expect(findArrows(src)[1]).toMatchObject({ line: 1, col: 2 });
  });

  it("ignores strings, comments, long brackets and member access; == is not an assignment", () => {
    const src = ['print("CLU_1->LAMP->Value")', "-- CLU_1->LAMP->Value", "--[[ CLU_1->A->B ]] x = [[CLU_1->A->B]]", "t.CLU_1->X", "if CLU_1->A->B == 1 then end"].join("\n");
    // `t.CLU_1` is found as a dotted ref (left alone by the resolver: t is not a CLU)
    expect(findArrows(src).filter((r) => r.sep === "->").map((r) => [r.kind, src.slice(r.start, r.end)])).toEqual([["read", "CLU_1->A->B"]]);
  });

  it("also finds dotted references (the resolver decides whether they are CLU references)", () => {
    const src = "print(CLU_1.ROLETA1_KUCHNIA.State) x = string.format('%d', 1) CLU_2.LAMP.SwitchOn(0, 1)";
    expect(findArrows(src).map((r) => [r.sep, r.clu, r.object, r.member, r.kind])).toEqual([
      [".", "CLU_1", "ROLETA1_KUCHNIA", "State", "read"],
      [".", "string", undefined, "format", "call"],
      [".", "CLU_2", "LAMP", "SwitchOn", "call"],
    ]);
  });

  it("replaces refs by compiled text", () => {
    const src = "x = CLU_1->A->B + CLU_1->A->C";
    expect(replaceArrows(src, findArrows(src), ["A1", "A2"])).toBe("x = A1 + A2");
  });
});
