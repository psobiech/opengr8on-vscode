import * as net from "node:net";
import { LineSplitter, TelnetDecoder, TelnetLog, backoffMs, colorize, lineFilter, type LogState } from "../../src/device/telnetLog";

describe("TelnetDecoder", () => {
  it("strips negotiation, refuses options and unescapes IAC IAC, across chunks", () => {
    const d = new TelnetDecoder();
    const a = d.decode(Buffer.from([0x41, 255, 253])); // 'A', IAC DO (option in next chunk)
    const b = d.decode(Buffer.from([1, 0x42, 255, 251, 3, 255, 255, 0x43, 255, 250, 24, 1, 255, 240, 0x44, 255, 241]));
    expect(Buffer.concat([a.data, b.data])).toEqual(Buffer.from([0x41, 0x42, 255, 0x43, 0x44]));
    expect(b.replies).toEqual(Buffer.from([255, 252, 1, 255, 254, 3])); // WONT echo, DONT suppress-go-ahead
  });
});

describe("LineSplitter", () => {
  it("splits CR, LF and CRLF (also split across chunks) and keeps the tail", () => {
    const s = new LineSplitter();
    expect(s.push("a\r")).toEqual(["a"]);
    expect(s.push("\nb\nc\r\nd")).toEqual(["b", "c"]);
    expect(s.push("e")).toEqual([]);
    expect(s.flush()).toBe("de");
  });
});

describe("filter, colors, backoff", () => {
  it("filters by substring or /regex/", () => {
    expect(lineFilter("")("x")).toBe(true);
    expect(lineFilter("dim")("DIM1186 set")).toBe(true);
    expect(lineFilter("/^E.*1$/")("ERR 1")).toBe(true);
    expect(lineFilter("/^E.*1$/g")("ERR 2")).toBe(false);
  });

  it("colors by level", () => {
    expect(colorize("ERROR: x")).toBe("\x1b[31mERROR: x\x1b[0m");
    expect(colorize("plain")).toBe("plain");
  });

  it("backs off 1 s doubling to 30 s", () => {
    expect([0, 1, 2, 5, 10].map(backoffMs)).toEqual([1000, 2000, 4000, 30000, 30000]);
  });
});

describe("TelnetLog", () => {
  it("streams lines, answers negotiation, reconnects after the server drops", async () => {
    const received: Buffer[] = [];
    let connections = 0;
    const server = net.createServer((sock) => {
      connections++;
      sock.on("data", (d) => received.push(d));
      if (connections === 1) sock.end(Buffer.concat([Buffer.from([255, 253, 1]), Buffer.from("boot ok\r\npartial")]));
      else sock.write("second\n");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as net.AddressInfo).port;

    const lines: string[] = [];
    const states: LogState[] = [];
    let resolveSecond!: () => void;
    const second = new Promise<void>((r) => (resolveSecond = r));
    const log = new TelnetLog({
      host: "127.0.0.1",
      port,
      backoff: () => 10,
      onLine: (l) => {
        lines.push(l);
        if (l === "second") resolveSecond();
      },
      onState: (s) => states.push(s),
    });
    log.start();
    await second;
    log.close();
    await new Promise<void>((r) => server.close(() => r()));

    expect(lines).toEqual(["boot ok", "partial", "second"]);
    expect(Buffer.concat(received)).toEqual(Buffer.from([255, 252, 1]));
    expect(states.map((s) => s.state)).toEqual(["connecting", "connected", "disconnected", "connecting", "connected"]);
  });
});
