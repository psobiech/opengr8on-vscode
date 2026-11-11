# Project format — version 1 (frozen 2026-11-11; additions since: optional `clu.ioOrder`, `objects:` defined, GATE `clu.netmask` / `clu.gateway`)

A Grenton project as plain text in git: human-editable YAML + Lua, names instead of indexes.
Generated `OM.LUA` / `USER.LUA` are build outputs (not committed). Changes to this format bump
`format` in `opengr8on.yaml` and come with a migration.

```
my-house/
  opengr8on.yaml            # project root marker (activation event)
  clus/
    CLU_2.yaml              # one file per CLU; file name = CLU name
    CLU_1.yaml
  scripts/
    CLU_2/
      ELO.lua               # body only; generator wraps it in function ELO() ... end
  .opengr8on/               # git-ignored
    keys.json               # keys (see below); also in VS Code SecretStorage
  build/                    # git-ignored, generated OM.LUA / USER.LUA per CLU
```

Schemas: `schemas/opengr8on.schema.json`, `schemas/clu.schema.json` (completion + validation via
`redhat.vscode-yaml`). The loader (`src/project/load.ts`) enforces the same rules and reports
errors as diagnostics with ranges.

## opengr8on.yaml

```yaml
format: 1                   # required; this document
name: DOM                   # project name
interfaces: []              # optional: extra interface XML directories (relative to the root)
```

## clus/<name>.yaml

```yaml
clu:
  name: CLU_2               # required; OM display name (-- NAME_CLU); must match the file name
  serial: 900000001         # required; decimal
  id: CLU900000001          # optional; object id, default CLU<serial> (vCLU: CLU1)
  ip: 192.168.1.101         # required; IPv4
  netmask: 255.255.255.0    # GATE (hw type 0x12) only, required there: OM's project network
  gateway: 192.168.1.1      #   settings, written into GATE:new(...); import fills them
  hw: { type: 0x13, version: 1 }      # required; OM.LUA header HwType / HwVersion
  fw: { type: 3, version: 0x203 }     # required; OM.LUA header FwType / FwVersion
  remotes:                  # optional; default: every other CLU of the project, by file name
    - CLU_1                 #   another CLU file of this project
    - { id: CLU1, ip: 192.168.1.110 } # or a CLU outside the project (vCLU, other installer)
  ioOrder: [DIM1186]        # optional; IO declaration order by id when it is not module order
                            #   (OM interleaves e.g. Z-Wave objects); import writes it if needed
  features:                 # by interface feature name (or index as "18"); order preserved
    UseCloud: 0
  events:                   # by interface event name (or index as "13")
    OnInit:
      - CLU_2->IO_DIM1186->SwitchOn(0)
    "13":
      - lua: ELO(nil)

modules:
  - serial: 520093697       # decimal
    type: "0x1a"            # string, emitted verbatim (OBJECT:new 3rd argument; keeps zero padding)
    comment: "02 02"        # trailing comment fields after the serial, verbatim (meaning unknown)
    ios:
      - id: DIM1186         # object id <3 letters><4 digits>, stable, unique per CLU
        class: 5            # object class number, or interface object name (DIMM)
        channel: 0          # 0-based among the module's objects of the same type
        name: IO_DIM1186    # optional NAME_IO; default x<module serial>_<Obj>_<nn>
        inactive: false     # optional; emitted as --INACTIVE (no events / init)
        features:
          RampTime: 500
          MinValue: 0.32
        events:
          OnSwitchOn:
            - CLU_1->IO_DOU1529->Switch(0)   # OM action grammar, resolved by the generator
            - lua: DOU3096:execute(0, 0)      # escape hatch: raw Lua line

objects:                    # virtual objects ("periphery"), in OM order
  - id: TIM8908             # object id, stable
    class: Timer            # interface object name (or class number)
    name: t                 # NAME_PERIPHERY
    features: { Time: 240, Mode: Interval }
    events:
      OnTimer: [ CLU_2->test() ]
  - id: THE2961
    class: Thermostat
    version: 2              # needed when several interface versions exist
    name: hh
    removed: true           # kept commented out in OM.LUA (-- REMOVED)
    features:
      Source: CLU_2->x520093751_PANELSENSTEMP_01->Value   # table feature: object reference
      Control: CLU_1->x520093698_AnalogOUT_01->Value
      PointValue: 20

scripts:                    # order = order in USER.LUA
  - name: ELO               # body in scripts/<CLU name>/<name>.lua
    params: []              # parameter names
```

## Rules

- Names resolve through the interface XMLs of the object's class (+ module firmware) via
  `InterfaceRegistry`. Unknown name, class, event or action target = diagnostic, never a guess.
- Index keys (`"18"`, `"13"`) are accepted for features and events; they must be quoted strings in
  YAML. The loader reads mappings in document order (`yaml` Document/Pair API), so integer-like keys
  keep their order (JS objects would reorder them).
- Enum features are written by name: `Mode: Bistable`, `TimeZone: Europe/Warsaw` (the number is
  accepted too). Features whose names are not text (baud rates `9600`, `50Hz`) or not unique keep
  numbers. Import writes names wherever that applies.
- Enum arguments of `set`-type methods (`->SetMode(Bistable)`, the parameter takes the values of the
  feature the method sets) are written by name or number, in actions and scripts.
- Feature values: number, string or boolean, emitted as Lua literals in document order; or
  `{ lua: <text>, comment: <text> }` written verbatim (import uses it for values it cannot name).
  Virtual-object `table` features take an object reference `CLU->OBJECT->Feature`.
- CLU `events: OnInit` actions are written last in OnInit (`-- CluOnInit`).
- Action strings use OM's grammar `<CLU name>-><object name or id>-><Method>(<args>)` or
  `<CLU name>-><script>(<args>)`; `{ lua: ... }` is emitted verbatim.
- `ioOrder`, when present, lists every IO id of the CLU exactly once; declarations, events and
  OnInit follow it (observed: all three follow the same order in OM output).
- `remotes` order is the order of the `OBJECT:new(1, …)` lines; import writes it explicitly to
  reproduce OM's order.
- Friendly names everywhere in YAML: actions use NAME_IO / CLU names (`CLU_1->ROLETA1->Stop()`);
  ids work too but completion offers friendly names first. Import writes friendly actions whenever
  they compile back to the identical line, otherwise `{ lua: ... }`.
- Scripts are Lua with OM's object notation: `CLU_1->ROLETA1->State`,
  `CLU_2->PANEL_01->Draw()` (friendly names or ids), compiled like OM does (docs/OM_LUA_FORMAT.md
  "Object references in scripts"); plain `ID:get(i)` works as well. The editor completes friendly
  names first, shows names next to ids, and LuaLS understands the notation through the generated
  plugin (`.opengr8on/luals/plugin.lua`, enabled in `.luarc.json`; the Lua server must be restarted
  once after the plugin is installed — the extension offers it).
- The same references with dots (`CLU_1.ROLETA1.State`, `CLU_2.LAMP.SwitchOn(0, 500)`) compile
  identically when the first part is a CLU of the project; other dotted Lua is left alone. This is an
  OpenGr8on extension (Object Manager only accepts `->`), handy because LuaLS needs no plugin for it.
- New objects get `<PREFIX><4 random digits>` ids unique per CLU, written back into the YAML.
- Secrets (cipher keys, PINs) never in YAML.

## .opengr8on/keys.json

opengr8on-node's keys.json (project `key` / `iv` base64; `defaultIV` / `pin` at top level are
ignored) plus an optional `clus` map by decimal serial:

```json
{ "key": "<b64 16 B>", "iv": "<b64 16 B>",
  "clus": { "900000001": { "pin": "<8 chars>" }, "900000002": { "privateKey": "<b64 8 B>", "key": "…", "iv": "…" } } }
```
