# References (sibling repos, local paths relative to this repo)

## ../opengr8on-node — TypeScript CLU protocol library (AGPL-3.0, ESM, Node ≥ 18)

Reuse, do not re-implement. Included as git submodule `lib/opengr8on-node`; import only
`opengr8on-node/client` (`src/client-entry.ts`: client, TFTP, commands, utils, parsers,
`readProjectClus`). The root index also pulls `tfbus` (serialport), `vclu` (wasmoon, mqtt).

| Need | Module |
|---|---|
| UDP client, encryption | `src/Client.ts`, `src/CLUClient.ts`, `src/CipherKey.ts` |
| CLUClient API | `execute(lua)`, `checkAlive()`, `setAddress()`, `updateCipherKey()`, `reset()`, `refreshModules()`, `startTFTPdServer()`, `stopTFTPdServer()`, `uploadFile(local, 'a:\\OM.LUA')`, `downloadFile()`, `generateMeasurements()` |
| CLU files | `src/CLUFiles.ts` (`OM_LUA`, `USER_LUA`, `CONFIG_JSON`, `DIAGNOSTIC_PACK_JSON`, …, `getLocation()`) |
| Discovery | `src/commands/DiscoverCLUsCommand.ts`; usage in `src/clu/cli.ts` / `repl.ts` |
| Network interface pick | `src/util/networkInterfaces.ts` (`getLocalIPv4Interfaces`, `broadcastAddress`) |
| TFTP client | `src/tftp/TFTPClient.ts` |
| .omp | `src/parsers/omp/OmpReader.ts`, `src/clu/project.ts` (`readProjectClus`, keys.json next to .omp) |
| Interface XMLs | `src/parsers/interfaces/InterfaceRegistry.ts`; XMLs: `docs/device-interfaces/` (356 files) |
| Object class / data type enums | `src/parsers/interfaces/CLUClassNameEnum.ts`, `CLUDataTypeEnum.ts` |
| Protocol docs | `docs/UDP.md`, `docs/COMMUNICATION.md` (files on `a:\`, `m:\`, `p:\`) |
| Virtual CLU (test target without hardware) | `src/vclu/`, `bin/vclu.js` |
| Example CLI / REPL to copy flows from | `src/clu/cli.ts`, `src/clu/repl.ts` |

## ../opengr8on — Java original (vCLU, client, parsers)

Real OM output samples (`runtime/root/a`, `clu2`, `x`, `modbus`), OM docs `docs/om/README.md`,
`modules/parsers` (Java .omp parser, more complete than the TS one in places).

## ../opengr8on-clu-esp32 — ESP32 CLU firmware

`components/clu_lua/prelude.lua` (OBJECT:new semantics), `objects.lua` (virtual object classes and
their feature/method/event indexes), README (compatibility table). Telnet log console TCP 23.
Good hardware target for end-to-end tests.

## ../../ext/nodemcu-vscode — extension to copy structure from (MIT)

| Pattern | File |
|---|---|
| esbuild bundle → `dist/extension.js` | `esbuild.config.mjs` |
| vitest + vscode mock | `vitest.config.ts`, `tests/__mocks__/vscode.ts` |
| async tree provider | `AsyncTreeProvider` in `src/extension.ts` (test: `tests/unit/asyncTreeProvider.test.ts`) |
| webview console (we need it for telnet logs) | `src/serial/serialConsoleView.ts` |
| status bar | `src/status/statusBar.ts` |
| Lua API stubs for LuaLS (sumneko) | `src/luaApi/apiFiles.ts` |
| upload on save | `src/upload/srcMirror.ts`, `liveEditFs.ts` |
| command queue | `tests/unit/commandQueue.test.ts` |
| welcome view when no project | `package.json` `viewsWelcome` |
