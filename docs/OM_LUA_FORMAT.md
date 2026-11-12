# OM.LUA / USER.LUA format (as written by Object Manager)

Reverse-engineered from real OM output. Status per item: **confirmed** (seen in real files and
reproduced byte for byte by `src/generator/omLua.ts`), **observed** (seen in real files, not yet
covered by a golden test) or **unknown** (not observed; needs a capture from Object Manager).

## Evidence (local paths)

| File | What it is |
|---|---|
| `../opengr8on/runtime/root/a/OM.LUA`, `USER.LUA` | OM output for a vCLU (LF endings). Copied to `tests/fixtures/vclu.*`; **golden test passes** |
| `../opengr8on/clu2/OM.LUA`, `USER.LUA` | real CLU_ZWAVE_2 project, CRLF, 2093 lines: modules, IOs, events, Z-Wave, `--INACTIVE` |
| `../opengr8on/x/OM.LUA`, `../opengr8on/modbus/OM.LUA` | other real CLUs of the same project (local + remote actions) |
| `../opengr8on-clu-esp32/test/host/fixtures/om.lua` | **synthetic**, hand-written; copied as `tests/fixtures/om.synthetic.lua` |
| `../opengr8on-clu-esp32/components/clu_lua/prelude.lua` | how a CLU interprets `OBJECT:new` (argument meaning) |

The real files contain private home data (names, IPs). Do **not** commit them as-is. Sanitized copies
live in `tests/fixtures/real-{clu2,x,modbus}.OM.LUA` and `real-{clu2,x}.USER.LUA`, produced by
`scripts/sanitize-om.mjs` (serials, IPs, user IO names, panel labels and CLU string features mapped;
structure, CRLF and object ids byte for byte; fails on any surviving original token or key material).
`x` = `clu2` + one more remote CLU (`CLU1`) + a CLU event calling a local script.

## Line endings and encoding

OM writes its platform's line endings: **CRLF** on Windows (clu2/x/modbus), **LF** on Linux (OM
1.13.1, files downloaded from the .117 CLU). Setting `opengr8on.generate.lineEndings` (default
`crlf`). File ends with a single EOL after the last line.

Text is **UTF-8** (confirmed: a Polish comment in a script, `zażółć gęślą jaźń` = `c5 bc c3 b3 …`
in USER.LUA from the CLU, fixture `real-117b.USER.LUA`).

## OM.LUA layout (confirmed)

```lua
-- FwType 00000003                 -- 8 hex digits, lower case
-- FwVersion 00000203
-- HwType 00000013
-- HwVersion 00000001
                                   -- blank
--STORAGE
STO99999 = OBJECT:new(44, "STO99999")   -- always present, fixed name
                                   -- 2 blanks
-- setVar type support
_type = {}
CLU900000001 = OBJECT:new(0, 0xC0A80165, "CLU900000001")   -- class 0 = this CLU; IP as upper-case hex
-- NAME_CLU CLU_2=CLU900000001                              -- OM display name = object id
                                   -- blank
CLU900000002 = OBJECT:new(1, 0xC0A80166, "CLU900000002")   -- class 1 = every other CLU in project
...
                                   -- 2 blanks
-- MODULES
mm_520093697 = OBJECT:new(2, 0x1f000001, 0x1a, "1f000001") -- 520093697 02 02
                                   -- blank
-- IO_MODULES
 DIM1186 = OBJECT:new(5, mm_520093697, 0, "DIM1186")       -- NOTE leading space
-- NAME_IO IO_DIM1186=DIM1186                               -- only when user named it? (see below)
--INACTIVE  ZWA1794 = OBJECT:new(61, mm_3489660942, 0, "ZWA1794")   -- 2 spaces after --INACTIVE
                                   -- 2 blanks
function toboolean(value) ... end  -- fixed helper block (verbatim in omLua.ts HELPERS)
function setVar(name, value) ... end
function getVar(name) \treturn _G[name] end   -- note TAB indent here, 4 spaces elsewhere
                                   -- blank
function EventsFor_DIM1186_0()     -- EventsFor_<objId>_<eventIndex>
\t<action line>                    -- one TAB per action line
end
DIM1186:add_event(0, EventsFor_DIM1186_0)
                                   -- blank (after each event block)
                                   -- +2 blanks before OnInit
function OnInit()
                                   -- blank
-- INIT_CLU_OBJECTS
CLU900000001:set(18, 0)            -- CLU features first
DIM1186:set(0, 0)                  -- then IOs in declaration order; features in interface order
                                   -- blank
end
                                   -- blank
CLU900000001:add_event(0, OnInit)
```

### Object ids

- CLU: `CLU` + decimal serial (`CLU900000001`). vCLU uses `CLU1`.
- Module: `mm_<decimal serial>`; 4th arg = serial as 8 lower-case hex digits.
- IO / virtual objects: 3-letter class prefix + 4 random digits (`DIM1186`, `BUT0354`, `PAN7426`,
  `ANA9991`, `POW8617`, `LED3942`, `ZWA9268`, `DOU…`, `DIN…`, `ROL…`). Unique per CLU. Generator must
  keep ids stable (stored in the project) because other CLUs reference them by id.
- Prefix: the first 3 letters of the interface object name (426/426 real IOs; `src/project/skeleton.ts`).

### Module line (observed, 26/26 TF-Bus + 3 Z-Wave modules of real clu2 vs its CONFIG.JSON)

`mm_<sn> = OBJECT:new(2, 0x<sn hex8>, <typeLiteral>, "<sn hex8>") -- <sn dec> <fwType> <fwApiVer>`

- `typeLiteral` = module `hwType` from CONFIG.JSON: `0x1a` (2 hex digits) for TF-Bus,
  `0x008500030011` (12 digits) for Z-Wave. CLU prelude stores it as `_hwType`.
- comment tail = `fwType fwApiVer` as 2-digit hex for TF-Bus (`02 02`, `02 01`); Z-Wave writes
  `0 01` (fwType 0 unpadded, api 01). Together they are the module interface XML key
  (`InterfaceRegistry.getModule(hwType, fwType, fwApiVer)`).

### IO declaration order (observed)

Usually module by module, but **not always**: in real-clu2 the class-61 Z-Wave objects of two
modules come first, then the other Z-Wave objects module by module. The rule is unknown, so the
model / YAML carry an explicit `ioOrder` when OM's order differs from module order. Event blocks and
OnInit feature lines follow the declaration order (round trip of all real files).

### CLU events (observed)

The CLU's own events (e.g. event 13 in real-x) are emitted first, right after the helper block,
in the same `EventsFor_<CLUid>_<n>` / `add_event` form as IO events.

### Round trip (confirmed)

`emitOmLua(parseOmLua(x)) === x` for real-clu2, real-x, real-modbus and vclu
(`tests/unit/roundtrip.test.ts`, parser `src/project/omLuaParse.ts`).

### IO line channel (observed)

` <ID> = OBJECT:new(<class>, mm_<sn>, <channel>, "<ID>")`: `channel` is the 0-based index among the
module's objects **of the same type** (real-clu2: one ANALOG_DIN has AnalogOUT 0..3 and AnalogIN
0..6). Object types and counts per module come from the module interface XML (`<object count>`).

### NAME_IO

Emitted right after the object line, `-- NAME_IO <name>=<id>`. In clu2 every IO has one, default
names look like `x<moduleSerial>_<IOTYPE>_<nn>` (e.g. `x520093698_AnalogOUT_01`). So OM probably
always emits it (name = default when user did not rename). **Observed**.

### Event actions (observed)

OM project stores actions as strings in OM grammar (see OMP_FORMAT.md); OM.LUA has them compiled:

| OM action string | OM.LUA line | When |
|---|---|---|
| `CLU_2->LAMPA->Switch(0)` (object on this CLU) | `DOU3096:execute(0, 0)` | local object: `<id>:execute(<methodIndex>, <args...>)` |
| `CLU_1->LAMPA->Switch(0)` (object on other CLU) | `CLU900000004:execute(0, "DOU5913:execute(0, 0)")` | remote: method 0 of the remote CLU proxy = run Lua string there |
| `CLU_2->x520093703_LEDRGB_01->SetGreenValue(255,1000)` | `LED0173:execute(4, 255, 1000)` | args passed through |
| `VCLU->mqttOnValueChange("CLU900000001->DIM1186")` (script on other CLU) | `CLU900000005:execute(0, "CLU900000005:execute(30, \"CLU900000001->DIM1186\")")` | vCLU-specific; script call on a real remote CLU **unknown** |

- Method index comes from the interface XML of the object class (`<method index=...>`).
- **Only the given arguments are passed**: `CLU_2->x…_LEDRGB_01->Switch(0)` → `LED0173:execute(11, 0)`
  although Switch has 2 parameters (confirmed). More arguments than parameters = error.
- `CLU->member(args)` without an object: a script of that CLU, else a **method of the CLU object**
  (vCLU `mqttOnValueChange` = CLU method 30 → `CLUx:execute(30, args)`, wrapped for remote CLUs).
- Local script call: **observed** in `tests/fixtures/real-x.OM.LUA` (CLU event 13 handler):
  `\tELO(nil)` for script `ELO` (no parameters). So a parameterless local call passes `nil`
  explicitly; rendering with parameters still **unknown**. Event handlers on the CLU itself use the
  same `EventsFor_<CLUid>_<event>` / `add_event` form as IOs.
- Feature set action (`CLU->OBJ->Value=5`?) / get-in-expression / conditions **unknown**.

### OnInit

- Feature values from the project's `initValue` of each EmbeddedFeature, in the order the features
  appear (not sorted). Numbers printed as-is (`0.32`, `500`), strings quoted; vCLU writes booleans
  `false`, real CLU features use `0/1` — print exactly the stored literal type.
- Features with no init value are skipped; **read-only features (`accessType READ`) are skipped even
  with an init value** (CloudConnection). STRING features with an empty init value are emitted as
  `""`; empty NUMBER values are skipped. (Confirmed: .omp acceptance, see below.)
- User commands bound to CLU `OnInit` event: placement **unknown** (expect after the `set` block,
  before blank+`end`).
- User variables (`_type["x"] = "number"`, initial value): **unknown** (`_type = {}` sits right
  after `-- setVar type support`, so declarations probably go there).

### Not seen yet (**unknown**)

Virtual objects (Timer 6, Calendar 15, Scheduler 16, Thermostat 18, PresenceSensor 40, …): expected
form `TIM1234 = OBJECT:new(6, "TIM1234")` (prelude handles `OBJECT:new(class, name)`), section
marker and position unknown. GATE objects (HttpRequest, Modbus…), user features of CLU, Push / cloud objects.

### GATE (hw type 0x12) — **observed** (OM 1.13.1, GATE_MODBUS fw type 1 and GATE_ALARM fw type 2, fw 0x578; fixture `real-gate.OM.LUA`)

Same file as a CLU's except:

```
-- HwVersion 00000002
                                    <- no --STORAGE block: two blank lines straight away
-- setVar type support
_type = {}
CLU900000006 = GATE:new(5000, 0xC0A8016B, 0xFFFFFF00, 0xC0A8016C, "", "")
-- NAME_CLU MODBUS=CLU900000006
```

`GATE:new(5000, ip, netmask, gateway, "", "")`: netmask / gateway are the OM **project** network
settings (`.omp` properties.xml), the same on every GATE; seen two different gateways in two
projects. `5000` and the two empty strings were constant in all 4 samples (meaning unknown). Remotes,
`-- MODULES` (empty), the prelude, OnInit with the GATE's own features and `add_event` as on a CLU.
GATEs are declared on the CLUs like any remote CLU (`OBJECT:new(1, ip, id)`). Modules / virtual
objects on a GATE: **unknown** (resolver error). Byte-identical for both GATEs in three .omp files.

## USER.LUA layout (confirmed: one script, and three scripts with parameters — `real-117c.USER.LUA`)

Every script is this block; the blocks are simply concatenated (so 6 blank lines between two scripts):

```
<blank>
<blank>
function nowy_skrypt(parametr,dd,bbb)   -- parameter names joined with "," (no space)
<blank>
--ARG parametr="domyslna"     -- one per parameter: default as a Lua literal
--ARG dd=1 {1-10}             -- NUMBER with RANGE restriction: " {min-max}"
--ARG bbb=true
--BEGIN_INIT
\tif parametr == nil then     -- note the trailing space after "then"
\t\tparametr = "domyslna"
\tend                         -- ... same three lines per parameter
--END_INIT
<blank>
\t<body line>                 -- every body line TAB-prefixed, blank ones too ("\t"; real-x)
<blank>
end
<blank> x4
```

Script calls (observed in scripts and event actions):

| source | OM.LUA / USER.LUA |
|---|---|
| `CLU->s("x",3,false)` (same CLU) | `s("x", 3, false)` — arguments re-joined with `", "` |
| `CLU->s()` (same CLU, 3 parameters) | `s(nil, nil, nil)` — one `nil` per parameter |
| `CLU->s()` (no parameters) | `s(nil)` |
| `CLU->s("x")` (fewer arguments than parameters) | `s("x", nil, nil)` — padded with `nil` |
| `CLU_1->s()` (other CLU) | `CLUx:execute(0, "s(nil)")` |
| `CLU_1->s("x", 2)` (other CLU) | `CLUx:execute(0, "s(\"x\", 2, nil)")` — same text, quotes escaped |
| more arguments than parameters | resolver error |

Method calls: OM passes only the given arguments (`Switch(0)` → `execute(11, 0)` for two parameters)
and does **not** fill in defaults: `Switch()` on a one-parameter method becomes
`DOU8889:execute(0, )` (observed) — broken Lua, so the resolver asks for at least the first argument.

Arguments are copied as written (OM does not parse them: `s("x'x\"x""x3")` → `s("x'x\"x""x3", nil, nil)`).
OM compiles scripts **line by line**: a call whose `)` is on a later line comes out broken
(`s("xxx` ⏎ `x2", 2)` → `s("xxx, nil, nil)("xxx` ⏎ `x2", 2)`, observed), so the resolver refuses
multi-line calls.

## User variables (CLU "features" defined in OM) — observed (`real-117c.OM.LUA`, `real-vclu2.OM.LUA`)

Plain global Lua variables. Persistent ones are stored by the storage object
(`STO99999:execute(4, name)`), volatile ones get `execute(2, name)`.

Between the IO block and `function toboolean`, in definition order, then registered at the very end
of the file (after `add_event(0, OnInit)`):

```
-- NAME_IO ...            (last IO)
<blank>
cecha = "aas" -- string
_type["cecha"] = "string"
cecha_other = "s" -- other
_type["cecha_other"] = "other"
<blank>
function toboolean(value)
...
CLU900000001:add_event(0, OnInit)
STO99999:execute(2, "cecha")              -- 2 = volatile
STO99999:execute(4, "cecha_persistent")   -- 4 = persistent
```

Types: string / other written verbatim in quotes; number and boolean unquoted
(`aas = 4 -- number`, `aaab = false -- boolean`).

## Object constructor = interface `className` — observed (`real-gate-modbus`, `real-vclu2`)

A virtual object is declared with the `className` of its interface XML (`<object class="120"
className="GATE" ...>`), default `OBJECT`: `MOD8301 = GATE:new(206, "MOD8301")` (ModbusServer on a
GATE) and `HTT9478 = GATE:new(120, "HTT9478")` (HttpListener on a vCLU), while Timer v1 / Thermostat /
Scheduler are `OBJECT:new`. Timer v2 is `GATE`, so a Timer needs its version when imported without
one (the importer derives it from the constructor). A GATE never has TF-Bus modules.

## Text values — observed

Strings are written verbatim between double quotes, nothing escaped: the HttpListener default `\z`
(two characters in the .omp) is `HTT9478:set(2, "\z")`. The value is the content of a Lua string and
escapes are typed by the user (Grenton GATE HTTP manual: headers `'Month: April\r\n'`; `\z` = empty).
The resolver therefore accepts escapes (`\"`, `\r\n`) and refuses a bare `"`, a real line break or a
trailing single `\` (they would break the string).

`get="false"` features of HttpRequest / HttpListener (QueryStringParams, RequestHeaders, RequestBody,
ResponseHeaders, ResponseBody) hold Lua tables at run time: per the manual they are read in a script
on the same GATE (`local resp = GATE->x->ResponseBody` → `HTT0001:get(10)`); reading them from another
CLU is refused (a remote get returns text, not the table).

- No scripts → **empty USER.LUA** (0 bytes; real modbus, confirmed).
- Body lines: leading **and trailing** whitespace is dropped, then one TAB; blank lines become a
  single TAB (confirmed: indented / space-padded .omp sources).

### Object references in scripts (OM notation)

OM scripts may use `CLU->OBJECT->Member`; OM compiles them into USER.LUA. Status per form:

| Script source | USER.LUA | Status |
|---|---|---|
| `CLU->OBJ->Method(args)` (same CLU) | `ID:execute(<index>, args)`, args verbatim (`x, y, text:sub(k, k), 1`) | confirmed (`ClearScreen()` → `PAN3590:execute(2)`) |
| `CLU->OBJ->Feature` (other CLU) | `CLUx:execute(0, "ID:get(<index>)")` | confirmed (`print(CLU_1->ROLETA1->State)`) |
| `CLU->Feature` (other CLU) | `CLUx:execute(0, "CLUx:get(<index>)")` | confirmed (`print(DEVCLU->Uptime)`) |
| `CLU->OBJ->Feature` (same CLU) | `ID:get(<index>)` | inferred |
| `CLU->OBJ->Method(literals)` (other CLU) | `CLUx:execute(0, "ID:execute(<index>, literals)")` | inferred; non-literal args rejected |
| `CLU->OBJ->SetMode(0)` (`set`-type method, other CLU) | `CLUx:execute(0, "BUT6012:set(1, 0)")` = `ID:set(<method index>, args)` | confirmed (method index = index of the feature it sets) |
| `set`-type method, same CLU / in YAML actions | `ID:set(<index>, args)` | inferred (same inner form) |
| `CLU->OBJ->Feature = 1` (other CLU) | `CLUx:execute(0, "BUT6012:set(1, 1)")` = `ID:set(<feature index>, value)` | confirmed (literal values only: evaluated on the other CLU) |
| `CLU->OBJ->Feature = expr` (same CLU) | `ID:set(<feature index>, expr)` | inferred |
| `CLU->script()` (other CLU) | `CLUx:execute(0, "elo2(nil)")` | confirmed (parameterless) |
| `CLU->script()` (same CLU) | `script(nil)` | inferred (as event actions) |
| `CLU->script(args)` | — | unknown: reported as an error |

Compiled by `src/project/resolve.ts` (scanner `src/lua/arrows.ts`, strings and comments untouched).
CLUs are referenced by project name (or id). .omp acceptance: USER.LUA identical for the real CLUs
using it.

## Virtual objects ("periphery") — confirmed

**Observed (OM 1.13.1):** a CLU in OM's trash (`.omp` `isRemoved=true`) is still declared as a remote
(`CLUx = OBJECT:new(1, …)`) in every other CLU's OM.LUA, and script references to its objects are
compiled as usual. The importer leaves such CLUs out (see OMP_FORMAT.md), so these lines disappear
on the next upload.

Seen in one real CLU (Timer active, Thermostat and Scheduler removed); parse / emit round trip of
the sanitized `tests/fixtures/real-117.OM.LUA` and .omp acceptance (OM.LUA identical). Between the remote CLU lines
and `-- MODULES` (the second blank line of an empty project is this empty block):

```
<blank>
TIM8908 = OBJECT:new(6, "TIM8908")              -- OBJECT:new(class, "<id>"), no module
-- NAME_PERIPHERY t=TIM8908
-- REMOVED THE2961 = OBJECT:new(18, "THE2961")  -- removed objects stay, commented out
-- NAME_PERIPHERY hh=THE2961
<blank>
-- MODULES
```

- Events: normal `EventsFor_<id>_<n>` blocks.
- Events: after all IO event blocks.
- OnInit: after the IO sets, in declaration order; removed ones as `-- REMOVED <id>:set(...)`. Every
  feature with an init value is set, read-only ones too (Thermostat OutputType) — unlike CLU / IO
  features.
- `table` features (Thermostat Source / Control) hold OM references `CLU->OBJ->Feature`:
  - same CLU (Source): `{<id>,<feature index>}` → `THE2961:set(0, {PAN9387,0})`
  - other CLU (Control): `"<CLU>:execute(0, \"<id>:set(<index>,%v)\")" -- REMOTE_COMMAND <reference> CONTROL`
    (comment = the reference as written + the feature name upper-cased)
  - other combinations: not observed (resolver error).
- **CLU OnInit user actions** go last in OnInit as `\t<action> -- CluOnInit`, after the blank line
  that follows the sets, directly before `end` (confirmed).
- .omp: CLU `peripheryList/HardwarePeripheryCLU` (name, nameOnCLU, typeId, typeName, typeVersion,
  features, events, isRemoved) → `OmpClu.periphery` (opengr8on-node).

clu2 `USER.LUA` (downloaded from the CLU) additionally has `function ELO() return 1 end` before the real `ELO()` — origin
unknown (forward stub? manual edit?). OM's own generated USER.LUA for that CLU (.omp cache) does **not**
contain it, so it was not written by generation. Multi-script separators unknown.

## .omp acceptance (confirmed, local only)

`tests/unit/omp.acceptance.test.ts` imports the private `../opengr8on/runtime/project.omp`
(`OPENGR8ON_OMP` to override; skipped in CI), runs load → resolve → emit, and compares with OM's
own generated files cached in the .omp (`diagnostics/<serial>/om.lua|user.lua`, stored **LF without
the final line break**, i.e. not the CLU bytes). Result: both real CLUs (182 and 247 IOs) identical
for OM.LUA and USER.LUA. vCLU cache stale (references a removed CLU). GATEs identical as well.
