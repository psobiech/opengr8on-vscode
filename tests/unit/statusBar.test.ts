import type { CluInfo } from "../../src/device/cluInfo";
import { statusView } from "../../src/views/statusBar";

const clu = (extra: Partial<CluInfo> = {}): CluInfo => ({ serial: 7, address: "10.0.0.7", mac: null, cipher: "NONE", online: true, lastSeen: new Date(0), keySource: "project", ...extra });

describe("statusView", () => {
  it("covers none / unknown / offline / live error / ok", () => {
    expect(statusView(undefined, undefined, undefined)).toMatchObject({ text: "$(circuit-board) no CLU", warning: false });
    expect(statusView(7, undefined, undefined)).toMatchObject({ text: "$(circuit-board) CLU7", warning: true });
    expect(statusView(7, clu({ online: false }), undefined)).toMatchObject({ text: "$(debug-disconnect) CLU7", warning: true });
    expect(statusView(7, clu(), "no answer")).toMatchObject({ text: "$(warning) CLU7 10.0.0.7", tooltip: "CLU7: no answer", warning: true });
    expect(statusView(7, clu(), undefined)).toMatchObject({ text: "$(circuit-board) CLU7 10.0.0.7", warning: false });
    expect(statusView(7, clu(), undefined).tooltip).toContain("key: project");
  });
});
