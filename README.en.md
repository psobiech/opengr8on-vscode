# opengr8on-vscode

*[Wersja polska](README.md)*

> **Note:** Documentation and format descriptions in this repository may contain errors,
> inaccuracies, or guesswork. No guarantee of accuracy or completeness is provided.
>
> The extension changes the program running on real CLUs (uploading OM.LUA / USER.LUA, setting the
> key, reset). Keep a copy of your Object Manager project and start with a single CLU.

VS Code extension for Grenton-compatible CLUs (CLU_ZWAVE_2, the ESP32 CLU from
[opengr8on-clu-esp32](https://github.com/psobiech/opengr8on-clu-esp32), vCLU) — a code-first alternative to Object Manager.

**Status: feature-complete first version, not yet tried on hardware.** The generator reproduces
Object Manager's OM.LUA / USER.LUA byte for byte for every real file tested (see
[OM.LUA format](docs/OM_LUA_FORMAT.md)), which also lists the constructs still unknown.

- **Device Explorer** (no project needed): discover CLUs, adopt (set key), check alive, reset, set
  IP, refresh modules, modules → IOs from CONFIG.JSON, live values with set / execute, download
  files, diagnostic pack, telnet log console, status bar.
- **Project as text**: `opengr8on.yaml`, `clus/*.yaml`, `scripts/<CLU>/*.lua` in git
  ([project format](docs/PROJECT_FORMAT.md)); errors in the Problems panel.
- **Generate** OM.LUA / USER.LUA identical to Object Manager's, **upload** over TFTP with read-back
  verification, **compare** with what runs on the CLU.
- **Import** an Object Manager project (`.omp`) or a CLU's current OM.LUA.
- **Lua IntelliSense** from the Grenton interface XMLs (LuaLS / sumneko.lua), OM notation
  `CLU->OBJECT->Feature` with friendly names, run selection on a CLU.
- **UI in English and Polish** (follows the VS Code display language).

**Instrukcja obsługi (PL, ze zrzutami ekranu): [docs/INSTRUKCJA.md](docs/INSTRUKCJA.md)** ·
example project: [docs/demo](docs/demo)

Docs: [design](docs/DESIGN.md) · [OM.LUA format](docs/OM_LUA_FORMAT.md) ·
[.omp format](docs/OMP_FORMAT.md) · [project format](docs/PROJECT_FORMAT.md) ·
[references](docs/REFERENCES.md)

## Install

1. Download `opengr8on-vscode-X.Y.Z.vsix` from the latest release:
   **[Releases](https://github.com/psobiech/opengr8on-vscode/releases/latest)**.
2. In VS Code (≥ 1.85): **Extensions** view (`Ctrl+Shift+X`) → `⋯` menu → **Install from
   VSIX…** → pick the file. Or from a terminal:

   ```bash
   code --install-extension opengr8on-vscode-X.Y.Z.vsix
   ```

3. VS Code then installs the bundled extension pack from the Marketplace: **Lua** (`sumneko.lua`)
   and **YAML** (`redhat.vscode-yaml`). VSCodium gets them from Open VSX, same result
   (`codium --install-extension …`).
4. Open a folder with `opengr8on.yaml`, or run **OpenGr8on: New Project** / **OpenGr8on: Import from Object
   Manager (.omp)** — then see the [manual (PL)](docs/INSTRUKCJA.md).

Updating: install the newer `.vsix` the same way (it replaces the old version). The computer must be
on the same network as the CLUs (UDP/TFTP).

## Build & bundle

### Prerequisites

- Node.js ≥ 20 and npm
- git (the protocol library is a submodule)
- VS Code ≥ 1.85 to run it

### Get the sources

```bash
git clone --recurse-submodules https://github.com/psobiech/opengr8on-vscode.git
cd opengr8on-vscode
# already cloned without submodules:
git submodule update --init
npm install
```

`lib/opengr8on-node` is a git submodule ([opengr8on-node](https://github.com/psobiech/opengr8on-node),
branch `develop`). It is consumed as TypeScript source through its client-only entry
`opengr8on-node/client` (mapped in `tsconfig.json` `paths`, the esbuild `alias` and the vitest
`alias`), so it is bundled together with the extension and never built separately. Update it with
`git submodule update --remote lib/opengr8on-node`.

### Build

```bash
npm run typecheck   # tsc --noEmit
npm run build       # esbuild → dist/
npm test            # vitest
npm run watch       # rebuild on change (used by F5)
```

`npm run build` (`esbuild.config.mjs`) produces:

| Output | What |
|---|---|
| `dist/extension.js` (+ `.map`) | one CommonJS bundle (node20) of `src/extension.ts` and the opengr8on-node client code; `vscode` stays external, no native dependencies |
| `dist/interfaces/*.xml` | device interface XMLs (CLU / module / object classes) copied from `lib/opengr8on-node/docs/device-interfaces` by `scripts/copy-interfaces.mjs`; loaded at runtime |

### Run

Open the folder in VS Code and press **F5** ("Run Extension"): an Extension Development Host starts
with the extension loaded. The extension activates in a workspace with `opengr8on.yaml` or when an
OpenGr8on command / view is used.

### Package (.vsix)

```bash
npm run build
npm run package -- -o opengr8on-vscode.vsix   # vsce package --no-dependencies
code --install-extension opengr8on-vscode.vsix
```

Everything runtime is already in the bundle, hence `--no-dependencies` (no `node_modules` in the
package). `.vscodeignore` keeps sources, tests, docs, the submodule and dev files out; the package
holds `dist/extension.js`, `dist/interfaces/`, `schemas/`, `resources/`, `package.json`, README and
license (about 1.2 MB).

CI (`.github/workflows/ci.yml`) runs typecheck, build, tests and the package step on every push /
pull request to `develop` and uploads the `.vsix` as the `opengr8on-vscode-vsix` artifact.

### Release

`.github/workflows/release.yml` publishes a release when a tag is pushed:
`git tag vX.Y.Z && git push origin vX.Y.Z`. The tag sets the version (written into `package.json` in
CI). The workflow builds, tests and creates a GitHub Release with `opengr8on-vscode-X.Y.Z.vsix` (+ `.sha256`). A suffixed
version (`0.2.0-rc.1`) becomes a pre-release.

### Tests

`npm test` runs the unit and golden tests (generator round trips on sanitized real OM output in
`tests/fixtures/`). `tests/unit/omp.acceptance.test.ts` additionally compares the generator with a
real Object Manager project when one is available locally (`OPENGR8ON_OMP=/path/to/project.omp`,
default `../opengr8on/runtime/project.omp`); it is skipped otherwise (CI). When OM did not refresh
the USER.LUA copy saved in the project, `OPENGR8ON_ALLOW_STALE_USER=1` reports that mismatch instead
of failing.

Screenshots of the user guide are generated from `docs/demo`: `npm run build && node
scripts/docs/screenshots.mjs` (code-oss under Xvfb, driven over the DevTools protocol; Polish UI,
`SHOTS_LOCALE=en` for English).

Translations: manifest strings in `package.nls.json` / `package.nls.pl.json`, runtime messages
through `vscode.l10n.t` (or `tr` from `src/i18n.ts` in modules without `vscode`) with Polish in
`l10n/bundle.l10n.pl.json`; `tests/unit/l10n.test.ts` fails on a missing or stale translation.

Real OM files hold private data: add them as fixtures only through `scripts/sanitize-om.mjs`, which
rewrites serials / IPs / names and refuses to write anything key-like (usage in its header).

## License

AGPL-3.0-or-later (bundles [opengr8on-node](https://github.com/psobiech/opengr8on-node), AGPL).

## Disclaimer

This project is not endorsed by, directly affiliated with, maintained, authorized, or sponsored by
Grenton Sp. z o.o.

The use of any trade name or trademark is for identification and reference purposes only and does
not imply any association with the trademark holder of their product brand.

Any product names, logos, brands, and other trademarks or images featured or referred to within this
page are the property of their respective trademark holders.

Use of this software may void the warranty of your Grenton devices. It is solely your responsibility
to evaluate whether using this software with warranted hardware complies with the manufacturer's
warranty terms.

This software is provided "as-is", without warranty of any kind, express or implied, including but
not limited to the warranties of merchantability, fitness for a particular purpose, and
non-infringement. Unless expressly stated otherwise, the person who associated a work with this deed
makes no warranties about the work, and disclaims liability for all uses of the work, to the fullest
extent permitted by applicable law.
