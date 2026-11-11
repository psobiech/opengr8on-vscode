# Object Manager project (.omp) — import notes

Import only (no writing). Existing reader: `../opengr8on-node/src/parsers/omp/OmpReader.ts`
(`readAllObjects`, `readTFBusModules`, `readProjectCipherKey`) and `src/clu/project.ts`
(`readProjectClus`: CLU name/serial/ip/key). Reuse; extend there, not here, when it is generic.

Sample: `../opengr8on-node/runtime/project.omp` and `../opengr8on/runtime/project.omp`
(private home project: do not commit; derive sanitized fixtures).

## Archive

ZIP:

| Entry | Content |
|---|---|
| `.project` | Eclipse descriptor, `<name>` = project name |
| `properties.xml` | project properties incl. project cipher key (see `readProjectCipherKey`) |
| `system.xml` | the whole project tree, XStream XML (~5.5 MB for a house), `id`/`reference` attributes for shared nodes |
| `system_backup*.xml` | OM backups, ignore |
| `scripts/<CLU name>/<script>.lua` | script source (plain Lua, CRLF) |
| `scripts/<CLU name>/<script>.lua.vd` | Java-serialized visual script diagram (`com.grenton.scriptbuilder…`) — ignore; scripts with `isManualEdit=true` use the .lua |
| `interfaces/` | interface XMLs bundled with the project (can supplement `device-interfaces`) |
| `nodes/<n>/data.json` | unknown (mobile interface?) — ignore for now |
| `diagnostics/<serial>/<file>/` | cached CLU files (om.lua, config.json, …) downloaded by OM |

## system.xml (relevant parts)

`TreeObject` nodes (`name`, `type` e.g. `SCRIPT_CONTAINER`, `APPLICATIONS_CONTAINER`, `children`,
`specificObject class=...`). Observed `specificObject` classes: `CLU`, `Input`, `Output`, `Script`,
`com.grenton.om.mobile.gui.MobileInterfaceTreeObject`.

CLU specificObject: `name`, `nameOnCLU`, `serialNumber` (hex), `macAddress`, `ipAddress`,
`hardwareType/Version`, `firmwareType/Version` (hex strings), `cipherKeyType` (`PROJECT_KEY` or
per-device `iv` + `privateKey`, base64), `embeddedFeaturesList`, `eventsList`, `methodsList`,
`modulesList`, `scripts`.

EmbeddedFeature: `name`, `index`, `type/paramType` (`NUMBER`, `BOOLEAN`, `STRING`, …),
`accessType` (`ALL`, `READ`, …), `initValue`, `defaultInitValue`, `unit`, `divisor`,
`constrainAsString`.

Event: `name`, `index`, `hint`, `argList`, **`commands`** (list of `<string>` actions),
`customSchemeCommands` (visual-scheme actions; unknown format, none seen non-empty).

Action strings (`commands/string`, XML-escaped) — grammar observed in a 329-command sample:

```
<CLU name>-><object name>-><Method>(<args>)     e.g. CLU_1->IO_DOU1529->Switch(0)
<CLU name>-><script name>(<args>)               e.g. VCLU->mqttOnValueChange("CLU900000001->DIM1186")
```

Names are OM display names (NAME_CLU / NAME_IO), not object ids. Resolve via the project tree and
interface XML (method name → index). Script object: `name`, `parameters`, `isManualEdit`.

## Import mapping → project files

| .omp | project |
|---|---|
| CLU (name, serial, ip, hw/fw) | `clus/<name>.yaml` `clu:` |
| per-CLU cipher key | `.opengr8on/keys.json` (git-ignored), never YAML |
| modules + IOs (ids, class, channel, names) | `clus/<name>.yaml` `modules:` |
| feature initValue (≠ default? or all — check what OM emits) | `features:` by **name** |
| event commands | `events:` keep OM action strings verbatim |
| scripts/*.lua | `scripts/<CLU>/<name>.lua` |

Acceptance test for the importer: for each CLU of a project, `generate(import(omp))` must equal the
`OM.LUA` OM generated for that project (`diagnostics/<serial>/om.lua/` inside the same .omp, or
downloaded from the CLU).

## Reader + import (implemented)

`readOmpProject` / `readOmpDiagnostics` in opengr8on-node (`src/parsers/omp/OmpProject.ts`), import
in `src/project/fromOmp.ts`. Mapping confirmed by the .omp acceptance (docs/OM_LUA_FORMAT.md):

| .omp | project / OM.LUA |
|---|---|
| CLU `serialNumber` (hex), `nameOnCLU` | `clu.serial` (decimal), object id |
| CLU `hardware*/firmware*` (hex strings) | header HwType/HwVersion/FwType/FwVersion |
| CLUs are often first defined inside an IO's `<clu>` (XStream) | reader collects any node with serialNumber + iosList |
| module `moduleID` / `moduleClass` / `moduleTypeFirmware` `moduleVersion` | `mm_<id>`, type `0x<class>`, comment `<fw> <ver>` |
| IO `nameOnCLU` / `classTypeId` / `number` / `name` | id / class / channel / NAME_IO |
| IO `active=false` | `--INACTIVE`; `isRemoved=true` → dropped |
| CLU `isRemoved=true` | in OM's trash: not imported (OM still declares it as a remote on every CLU and compiles references to its objects; `importOmp(…, { omExact: true })` keeps it for byte-exact comparisons) |
| virtual object `isRemoved=true` | not imported (OM writes it commented out, `-- REMOVED`; kept with `omExact`) |
| feature `initValue` (+ `accessType`, `paramType`) | OnInit (READ skipped, empty STRING = `""`) |
| event `commands/string` | actions (OM grammar, resolved by the normal resolver) |
| `scripts/<CLU>/<name>.lua` | `scripts/<CLU>/<name>.lua` |
| `properties.xml` project key | VS Code SecretStorage (never project files) |
| GATE CLUs (hw 0x12) | imported like a CLU (`clus/<name>.yaml`); `netmask` / `gateway` from properties.xml (project network settings) |
