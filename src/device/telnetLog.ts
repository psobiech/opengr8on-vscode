import * as net from "node:net";

const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;

/**
 * Stateful telnet stream decoder: strips IAC commands and subnegotiation, unescapes IAC IAC, and
 * collects refusals for option negotiation (DO x -> WONT x, WILL x -> DONT x): the log console never
 * enables any telnet option. Handles sequences split across chunks.
 */
export class TelnetDecoder {
  private state: "data" | "iac" | "opt" | "sb" | "sb-iac" = "data";
  private verb = 0;

  decode(chunk: Buffer): { data: Buffer; replies: Buffer } {
    const data: number[] = [];
    const replies: number[] = [];
    for (const b of chunk) {
      switch (this.state) {
        case "data":
          if (b === IAC) this.state = "iac";
          else data.push(b);
          break;
        case "iac":
          if (b === IAC) {
            data.push(IAC);
            this.state = "data";
          } else if (b === DO || b === DONT || b === WILL || b === WONT) {
            this.verb = b;
            this.state = "opt";
          } else if (b === SB) this.state = "sb";
          else this.state = "data"; // NOP, GA, ...
          break;
        case "opt":
          if (this.verb === DO) replies.push(IAC, WONT, b);
          else if (this.verb === WILL) replies.push(IAC, DONT, b);
          this.state = "data";
          break;
        case "sb":
          if (b === IAC) this.state = "sb-iac";
          break;
        case "sb-iac":
          this.state = b === SE ? "data" : "sb";
          break;
      }
    }
    return { data: Buffer.from(data), replies: Buffer.from(replies) };
  }
}

/** Splits decoded text into lines (CR, LF or CRLF); keeps the unfinished tail for the next chunk. */
export class LineSplitter {
  private tail = "";
  private lastWasCR = false;

  push(text: string): string[] {
    const lines: string[] = [];
    for (const ch of text) {
      if (ch === "\n" && this.lastWasCR) {
        this.lastWasCR = false;
        continue;
      }
      this.lastWasCR = ch === "\r";
      if (ch === "\r" || ch === "\n") {
        lines.push(this.tail);
        this.tail = "";
      } else this.tail += ch;
    }
    return lines;
  }

  /** The unfinished line (e.g. to flush on disconnect). */
  flush(): string {
    const t = this.tail;
    this.tail = "";
    return t;
  }
}

/** Line filter: plain substring (case-insensitive), or /regex/flags. Empty = everything. */
export function lineFilter(spec: string): (line: string) => boolean {
  const s = spec.trim();
  if (!s) return () => true;
  const re = /^\/(.+)\/([a-z]*)$/.exec(s);
  if (re) {
    const rx = new RegExp(re[1], re[2]);
    return (l) => {
      rx.lastIndex = 0;
      return rx.test(l);
    };
  }
  const needle = s.toLowerCase();
  return (l) => l.toLowerCase().includes(needle);
}

/** ANSI color by log level keyword (for the pseudoterminal). */
export function colorize(line: string): string {
  if (/\b(ERROR|ERR|FATAL)\b/i.test(line)) return `\x1b[31m${line}\x1b[0m`;
  if (/\b(WARN|WARNING)\b/i.test(line)) return `\x1b[33m${line}\x1b[0m`;
  if (/\bDEBUG\b/i.test(line)) return `\x1b[2m${line}\x1b[0m`;
  return line;
}

/** Reconnect delay: 1 s doubling to 30 s. */
export const backoffMs = (attempt: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));

export type LogState = { state: "connecting" | "connected" } | { state: "disconnected"; error?: string; retryInMs: number };

export interface TelnetLogOptions {
  host: string;
  port?: number;
  onLine(line: string): void;
  onState(s: LogState): void;
  /** OM files are single-byte: decode as latin1 by default. */
  encoding?: BufferEncoding;
  backoff?: (attempt: number) => number;
}

/** Read-only telnet log connection with automatic reconnect. */
export class TelnetLog {
  private socket: net.Socket | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private closed = false;

  constructor(private readonly opts: TelnetLogOptions) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  private connect(): void {
    const decoder = new TelnetDecoder();
    const lines = new LineSplitter();
    this.opts.onState({ state: "connecting" });
    const socket = net.connect({ host: this.opts.host, port: this.opts.port ?? 23 });
    this.socket = socket;
    let error: string | undefined;
    socket.setKeepAlive(true, 10_000);
    socket.on("connect", () => {
      this.attempt = 0;
      this.opts.onState({ state: "connected" });
    });
    socket.on("data", (chunk: Buffer) => {
      const { data, replies } = decoder.decode(chunk);
      if (replies.length) socket.write(replies);
      for (const l of lines.push(data.toString(this.opts.encoding ?? "latin1"))) this.opts.onLine(l);
    });
    socket.on("error", (e) => (error = e.message));
    socket.on("close", () => {
      const rest = lines.flush();
      if (rest) this.opts.onLine(rest);
      if (this.socket === socket) this.socket = undefined;
      if (this.closed) return;
      const retryInMs = (this.opts.backoff ?? backoffMs)(this.attempt++);
      this.opts.onState({ state: "disconnected", error, retryInMs });
      this.timer = setTimeout(() => this.connect(), retryInMs);
    });
  }

  /** Reconnects now (resets the backoff). */
  reconnect(): void {
    if (this.timer) clearTimeout(this.timer);
    this.attempt = 0;
    if (this.socket) this.socket.destroy();
    else this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.destroy();
    this.socket = undefined;
  }
}
