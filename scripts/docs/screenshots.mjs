#!/usr/bin/env node
// Screenshots for docs/INSTRUKCJA.md: runs code-oss (isolated profile, Xvfb) on a copy of docs/demo
// with this extension loaded, drives it over the Chrome DevTools Protocol and saves PNGs.
//
//   npm run build && node scripts/docs/screenshots.mjs [outDir=docs/img]
//
// Needs: code-oss (or code), xvfb-run, the sumneko.lua extension in ~/.vscode-oss/extensions.
// UI language: SHOTS_LOCALE (default pl). For pl the Polish language pack is taken from
// ~/.vscode-oss/extensions or downloaded from open-vsx.org into the temporary profile.
// Only the demo project (invented names) is ever shown.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, sleep } from "./cdp.mjs";

const repo = resolve(new URL("../..", import.meta.url).pathname);
const out = resolve(process.argv[2] ?? join(repo, "docs/img"));
const port = 9334;
const display = 96;
mkdirSync(out, { recursive: true });

const work = mkdtempSync(join(tmpdir(), "opengr8on-shots-"));
const ws = join(work, "ws");
cpSync(join(repo, "docs/demo"), ws, { recursive: true });
mkdirSync(join(work, "user/User"), { recursive: true });
mkdirSync(join(work, "ext"), { recursive: true });
const extRoot = join(homedir(), ".vscode-oss/extensions");
for (const e of existsSync(extRoot) ? readdirSync(extRoot) : []) if (/^sumneko\.lua-/.test(e)) symlinkSync(join(extRoot, e), join(work, "ext", e));

// UI language: the extension's own translations (to find texts on screen) + VS Code's language pack
const locale = process.env.SHOTS_LOCALE ?? "pl";
const english = locale === "en";
const runtimeText = english ? {} : JSON.parse(readFileSync(join(repo, `l10n/bundle.l10n.${locale}.json`), "utf8"));
const manifestText = JSON.parse(readFileSync(join(repo, english ? "package.nls.json" : `package.nls.${locale}.json`), "utf8"));
/** Runtime message (vscode.l10n.t) as shown in the chosen language. */
const T = (message) => runtimeText[message] ?? message;
/** Manifest string (package.nls key) as shown in the chosen language. */
const M = (key) => manifestText[key];
const commandTitle = (id) => `OpenGr8on: ${M(`command.${id}.title`).replace(/…$/, "")}`;
if (!english) {
  const packs = (dir) => (existsSync(dir) ? readdirSync(dir) : []).find((e) => e.startsWith(`ms-ceintl.vscode-language-pack-${locale}-`));
  const pack = packs(extRoot);
  if (pack) symlinkSync(join(extRoot, pack), join(work, "ext", pack));
  else {
    const meta = await (await fetch(`https://open-vsx.org/api/MS-CEINTL/vscode-language-pack-${locale}/latest`)).json();
    const vsix = join(work, "langpack.vsix");
    writeFileSync(vsix, Buffer.from(await (await fetch(meta.files.download)).arrayBuffer()));
    execFileSync("code-oss", [`--user-data-dir=${join(work, "user")}`, `--extensions-dir=${join(work, "ext")}`, "--install-extension", vsix], { stdio: "ignore" });
  }
  // VS Code indexes language packs (user-data-dir/languagepacks.json) only on a previous start: write it
  const dir = join(work, "ext", packs(join(work, "ext")));
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const loc = manifest.contributes.localizations[0];
  const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
  writeFileSync(
    join(work, "user/languagepacks.json"),
    JSON.stringify({
      [locale]: {
        hash: createHash("md5").update(`${id}@${manifest.version}`).digest("hex"),
        extensions: [{ extensionIdentifier: { id }, version: manifest.version }],
        translations: Object.fromEntries(loc.translations.map((t) => [t.id, join(dir, t.path)])),
        label: loc.localizedLanguageName,
      },
    }),
  );
}
writeFileSync(
  join(work, "user/User/settings.json"),
  JSON.stringify({
    "workbench.colorTheme": "Default Light Modern",
    "workbench.startupEditor": "none",
    "workbench.tips.enabled": false,
    "security.workspace.trust.enabled": false,
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "extensions.autoCheckUpdates": false,
    "extensions.ignoreRecommendations": true,
    "editor.inlayHints.enabled": "on",
    "editor.minimap.enabled": false,
    "editor.fontSize": 14,
    "editor.colorDecorators": false,
    "window.restoreWindows": "none",
    "chat.disableAIFeatures": true,
    "workbench.secondarySideBar.defaultVisibility": "hidden",
    "git.enabled": false,
    "files.autoSave": "off",
  }),
);

// own Xvfb (-ac: the X display can be grabbed by `import` as a screenshot fallback)
const xvfb = spawn("Xvfb", [`:${display}`, "-screen", "0", "1400x880x24", "-ac", "-nolisten", "tcp"], { stdio: "ignore", detached: true });
await sleep(1000);
const launch = () =>
  spawn(
    "code-oss",
    ["--ozone-platform=x11", `--locale=${locale}`, `--user-data-dir=${join(work, "user")}`, `--extensions-dir=${join(work, "ext")}`, `--extensionDevelopmentPath=${repo}`, `--remote-debugging-port=${port}`, "--disable-gpu", "--no-sandbox", "--password-store=basic", "--new-window", ws],
    { env: { ...process.env, DISPLAY: `:${display}`, XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "" }, stdio: "ignore", detached: true },
  );
/** Electron relaunches itself outside the launcher's process group: end it by its unique profile dir. */
const quitCode = () => {
  try {
    execFileSync("pkill", ["-f", "--", `--user-data-dir=${join(work, "user")}`]);
  } catch {
    /* none running */
  }
};
launch();

const c = await connect(port, { timeoutMs: 60000 });
const shot = async (name, { crop = true } = {}) => {
  await sleep(600);
  const file = join(out, `${name}.png`);
  await c.shot(file, { display: `:${display}` });
  // drop the empty secondary side bar on the right (it cannot be closed reliably in Xvfb)
  const { execFileSync } = await import("node:child_process");
  if (crop) execFileSync("magick", [file, "-crop", "1100x880+0+0", "+repage", file]);
  console.log("saved", name);
};
const palette = async (text) => {
  await c.key("Control+Shift+P");
  await sleep(400);
  await c.type(text);
  await sleep(700);
};
const run = async (command) => {
  await palette(command);
  await c.key("Enter");
  await sleep(1200);
};
const openFile = async (name) => {
  await c.key("Control+P");
  await sleep(400);
  await c.type(name);
  await sleep(800);
  await c.key("Enter");
  await sleep(1500);
};
const gotoLine = async (n) => {
  await c.key("Control+G");
  await sleep(300);
  await c.type(String(n));
  await c.key("Enter");
  await sleep(300);
};
const click = (selector, text) => c.click(selector, text);
const lineOf = (file, needle) => readFileSync(join(ws, file), "utf8").split("\n").findIndex((l) => l.includes(needle)) + 1;
const revert = () => run("File: Revert File");
const closeNotifications = () => c.eval(`document.querySelectorAll(".notification-toast .codicon-notifications-clear, .notification-toast .codicon-close").forEach((b) => b.click())`);

const heartbeat = process.env.CDP_DEBUG ? setInterval(() => console.error("alive", new Date().toISOString().slice(11, 19)), 3000) : undefined;
try {
  await sleep(9000); // extension activation, LuaLS start, project load
  // no window manager in Xvfb: the window never gets OS focus, so emulate it for input events
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true }, 3000).catch((e) => console.error("focus emulation:", e.message));
  await c.send("Page.bringToFront", {}, 3000).catch((e) => console.error("bringToFront:", e.message));
  await c.eval("window.focus()").catch(() => undefined);
  if (process.env.SHOTS_DEBUG) {
    const { execFileSync } = await import("node:child_process");
    execFileSync("import", ["-display", `:${display}`, "-window", "root", join(out, "00-debug.png")]);
    throw new Error("debug stop");
  }
  // hide the (empty) secondary side bar
  const hidden = await c.eval(`(() => { const b = [...document.querySelectorAll(".part.auxiliarybar .action-label, .part.auxiliarybar a")].find((e) => /Hide|Close/i.test(e.getAttribute("aria-label") || "")); if (b) { b.click(); return b.getAttribute("aria-label"); } return null; })()`);
  if (!hidden) await c.key("Control+Alt+B");
  await sleep(500);

  // 1. Lua plugin prompt (first start of a project)
  await shot("01-lua-restart", { crop: false }); // notification on the right
  await click(".notification-toast .monaco-button", T("Restart Lua Server"));
  await sleep(4000);
  await closeNotifications();

  // 2. Project tree
  await click(".activitybar .action-label", "OpenGr8on");
  await sleep(1500);
  await click(".pane-header", M("view.devices.name")); // collapse the (empty) Devices view
  // expand: click focuses a row, ArrowRight opens it
  for (const row of ["PARTER", T("Objects"), T("Virtual objects"), T("Scripts")]) {
    await click(".monaco-list-row", row);
    await c.key("ArrowRight");
    await sleep(500);
  }
  await shot("02-projekt");

  // 2b. New Script (the + on "Scripts"): name prompt
  await run(commandTitle("newScript"));
  await sleep(600);
  await c.type("PARTER");
  await c.key("Enter");
  await sleep(800);
  await c.type("podlewanie");
  await sleep(500);
  await shot("02b-nowy-skrypt");
  await c.key("Escape");

  // 3. YAML: action completion with friendly names
  await openFile("PARTER.yaml");
  await gotoLine(lineOf("clus/PARTER.yaml", "PARTER->LAMPA_SALON->Switch(0)"));
  await c.key("End");
  await c.key("Enter");
  await c.type("- PARTER->");
  await c.key("Control+Space");
  await sleep(1500);
  await shot("03-yaml-akcje");
  await c.key("Escape");
  await revert();

  // 3b. YAML: in a features block only that object's features are offered
  await gotoLine(lineOf("clus/PARTER.yaml", "UseCloud: 0"));
  await c.key("End");
  await c.key("Enter");
  await c.key("Control+Space");
  await sleep(1500);
  await shot("03b-yaml-cechy");
  await c.key("Escape");
  await revert();

  // 4. Lua script: CLU-> objects by friendly name, then members
  await openFile("zamknij_rolety.lua");
  await c.key("Control+End");
  await c.key("Enter");
  await c.type("PARTER->");
  await c.key("Control+Space");
  await sleep(1500);
  await shot("04-skrypt-obiekty");
  await c.key("Escape");
  await c.type("ROLETA_SALON->");
  await c.key("Control+Space");
  await sleep(1500);
  await shot("05-skrypt-metody");
  await c.key("Escape");
  await c.type("Stop()");
  // 5. plain Lua with ids: inlay hints show the friendly names
  await c.key("Enter");
  await c.type("local v = DOU1001:get(0)");
  await c.key("Enter");
  await c.type("DOU1003:execute(0, 1)");
  await sleep(2500);
  await shot("06-skrypt-podpowiedzi");

  // 6. a typo becomes an error (Problems panel)
  await c.key("Enter");
  await c.type("print(PARTER->LAMPA_SALONN->Value)");
  await sleep(2500); // live validation: no save needed
  await c.key("Control+Shift+M");
  await sleep(1500);
  await shot("07-bledy");
  // restore the original script on disk, then reload it in the editor
  writeFileSync(join(ws, "scripts/PARTER/zamknij_rolety.lua"), readFileSync(join(repo, "docs/demo/scripts/PARTER/zamknij_rolety.lua")));
  await sleep(500);
  await revert();
  await sleep(2500);
  await run("View: Close Panel");

  // 7. Generate + generated OM.LUA
  await run(commandTitle("generate"));
  await sleep(1500);
  await shot("08-generuj", { crop: false });
  await closeNotifications();
  await openFile("build/PARTER/OM.LUA");
  await gotoLine(12);
  await sleep(800);
  await shot("09-om-lua");

  // 8. Devices view (no CLU on this network) + status bar
  await click(".pane-header", M("view.project.name")); // collapse Project, expand Devices
  await click(".pane-header", M("view.devices.name"));
  await sleep(1000);
  await shot("10-urzadzenia");

  // 9. Command palette
  await palette("OpenGr8on");
  await shot("11-polecenia");
  await c.key("Escape");
} finally {
  if (heartbeat) clearInterval(heartbeat);
  c.close();
  quitCode();
  try {
    process.kill(-xvfb.pid, "SIGTERM");
  } catch {
    /* gone */
  }
  await sleep(2500);
  rmSync(work, { recursive: true, force: true });
}
