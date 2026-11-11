# Design

## Goal

A VS Code alternative to Grenton Object Manager (OM) for CLUs (real CLU_ZWAVE_2, the ESP32 CLU
from `opengr8on-clu-esp32`, vCLU): keep the project as text in git, edit Lua with IntelliSense,
generate the same `OM.LUA` / `USER.LUA` OM would, upload them, and inspect devices live.

## Decisions

1. **Code-first.** Source of truth = `opengr8on.yaml` + `clus/*.yaml` + `scripts/**/*.lua`
   (docs/PROJECT_FORMAT.md). OM.LUA / USER.LUA are build outputs.
2. **.omp is import only.** We read OM projects (ZIP + XStream XML) to bootstrap; we never write
   them. Round trip back to OM is out of scope.
3. **Byte-compatible output.** The generator reproduces OM's layout exactly (golden tests), so a
   CLU cannot tell the difference and diffs against OM-generated files are meaningful.
4. **Reuse opengr8on-node** for protocol, TFTP, interface XML and .omp parsing. Generic code goes
   there; this repo holds VS Code glue, the project model, the YAML layer and the generator.
5. **Secrets out of the project.** Cipher keys live in VS Code SecretStorage, optionally
   `.opengr8on/keys.json` (git-ignored, same format as opengr8on-node's keys.json next to .omp).
6. **License AGPL-3.0-or-later**, because opengr8on-node is AGPL and is bundled.

## Architecture

```
src/
  extension.ts          activation, wiring of views / commands / services
  interfaces/           device interface XMLs (InterfaceRegistry, shipped in dist/interfaces)
  project/
    model.ts            resolved model (ids, indexes, Lua lines) — contract for everything below
    load.ts             YAML → project source (order-preserving), diagnostics with ranges
    resolve.ts          names → indexes; OM action grammar / script notation → Lua; value checks
    omLuaParse.ts, userLuaParse.ts, toYaml.ts, fromOmp.ts, friendly.ts   import (OM.LUA, .omp)
    assist.ts, edit.ts  editor completion / hints, format-preserving YAML edits
  generator/
    omLua.ts            model → OM.LUA / USER.LUA (pure, golden-tested)
  lua/                  OM script notation scanner, LuaLS stubs + plugin
  device/               discovery, keys, adopt, per-CLU request queue (TFTP, req:), live values,
                        telnet logs, CONFIG.JSON
  views/                devices / project trees, commands, editor assist, log terminal, status bar
```

Rule: only `extension.ts` and `views/` import `vscode`; everything else is unit-testable in
Node (vitest, `tests/__mocks__/vscode.ts` when unavoidable).

## Data flow

```
.omp ──import──▶ YAML+Lua (git) ──load/resolve──▶ Project model ──emit──▶ OM.LUA / USER.LUA
                                                                         │
                       CLU ◀──TFTP a:\OM.LUA, a:\USER.LUA, then reset────┘
                       CLU ──UDP 1234 (discovery, req:, keys)──▶ Devices tree / live values
                       CLU ──TCP 23 logs──▶ log console
```

## Risks

- Unknown OM encodings (virtual objects, variables, script params, remote script calls): close
  them with captures before claiming support; generator refuses unsupported constructs with a
  clear error instead of guessing silently.
- Generated OM.LUA must also run on a genuine CLU, not just the ESP32 one: test on real hardware
  before upload is enabled by default.
- UDP broadcast from VS Code: multi-homed hosts need explicit interface; Remote/WSL/containers
  will not see the LAN — document, detect and warn.
- Uploading overwrites the project made in OM; confirm before upload, show diff.
