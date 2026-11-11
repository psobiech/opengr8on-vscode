// Minimal Chrome DevTools Protocol client for driving a VS Code (code-oss) window in tests / docs.
export async function connect(port, { timeoutMs = 60000 } = {}) {
  const pending = new Map();
  const deadline = Date.now() + timeoutMs;
  let target;
  while (!target) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === "page" && /workbench/.test(t.url));
    } catch {
      /* not up yet */
    }
    if (!target) {
      if (Date.now() > deadline) throw new Error("VS Code window did not appear");
      await sleep(500);
    }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  ws.onclose = () => {
    for (const { rej } of pending.values()) rej(new Error("CDP connection closed"));
    pending.clear();
  };
  let id = 0;
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (process.env.CDP_DEBUG && msg.id) console.error("cdp <", msg.id, msg.error ? msg.error.message : "ok");
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    }
  };
  const send = (method, params = {}, timeoutMs = 10000) =>
    new Promise((res, rej) => {
      const i = ++id;
      const timer = setTimeout(() => {
        pending.delete(i);
        rej(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      pending.set(i, { res: (v) => (clearTimeout(timer), res(v)), rej: (e) => (clearTimeout(timer), rej(e)) });
      if (process.env.CDP_DEBUG) console.error("cdp >", method);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const MODS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
  const CODES = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowDown: 40, ArrowUp: 38, ArrowRight: 39, ArrowLeft: 37, Space: 32, End: 35, Home: 36 };
  return {
    send,
    close: () => ws.close(),
    /** key("Control+Shift+P"), key("Enter") */
    async key(combo) {
      const parts = combo.split("+");
      const k = parts.pop();
      const modifiers = parts.reduce((m, p) => m | MODS[p], 0);
      const code = CODES[k] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
      const plain = !(modifiers & (MODS.Control | MODS.Alt | MODS.Meta));
      const text = plain && k.length === 1 ? k : plain && k === "Enter" ? "\r" : undefined;
      const base = { modifiers, windowsVirtualKeyCode: code, key: k === "Space" ? " " : k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k };
      await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, text });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      await sleep(150);
    },
    /** Types text as individual key events (Input.insertText stalls in VS Code's inputs). */
    async type(text) {
      for (const ch of text) {
        await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch, unmodifiedText: ch });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
      }
      await sleep(200);
    },
    /** Real mouse click at the centre of the first element matching selector + text. */
    async click(selector, text = "") {
      const rect = await this.eval(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => (e.getAttribute("aria-label") || e.textContent || "").includes(${JSON.stringify(text)})); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!rect) return false;
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      }
      await sleep(300);
      return true;
    },
    async eval(expression) {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      return r.result?.value;
    },
    /** Screenshot via CDP; falls back to grabbing the X display (ImageMagick import) if CDP hangs. */
    async shot(file, { display } = {}) {
      const { writeFileSync } = await import("node:fs");
      const r = await send("Page.captureScreenshot", { format: "png" }, 8000).catch(() => undefined);
      if (r?.data) {
        writeFileSync(file, Buffer.from(r.data, "base64"));
        return "cdp";
      }
      if (!display) throw new Error("CDP screenshot timed out and no X display given");
      const { execFileSync } = await import("node:child_process");
      execFileSync("import", ["-display", display, "-window", "root", file]);
      return "x11";
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
