/**
 * Resolved project model: the contract between the YAML loader, the .omp importer, the OM.LUA
 * generator and the views. Everything here is already resolved to what goes on the wire
 * (feature/event indexes, object ids, Lua action lines). Name-based YAML (feature names, the OM
 * `CLU->OBJ->Method(args)` action grammar) is resolved into this by src/project/resolve.ts
 * using the interface XMLs.
 *
 * See docs/OM_LUA_FORMAT.md for how each field is emitted.
 */

/** A Lua literal value as OM writes it in OnInit (`obj:set(idx, value)`). */
export type FeatureValue = number | string | boolean;

/**
 * A value written verbatim (a Lua table `{PAN9387,0}`, a REMOTE_COMMAND string), with an optional
 * trailing comment (` -- REMOTE_COMMAND ...`). Produced for virtual-object `table` features.
 */
export interface RawLua {
  lua: string;
  comment?: string;
}

/** Ordered list: OM keeps the interface's feature order, not numeric order (e.g. 0,1,2,3,6,8,4,5). */
export type FeatureInit = Array<[index: number, value: FeatureValue | RawLua]>;

/** Virtual object ("periphery": Timer, Thermostat, Scheduler, ...): `OBJECT:new(class, "id")`. */
export interface VirtualObject {
  id: string;
  objectClass: number;
  /** `-- NAME_PERIPHERY <name>=<id>` */
  name: string;
  /** kept in OM.LUA commented out (`-- REMOVED ...`), incl. its init values; no events */
  removed?: boolean;
  /** interface object version (not in OM.LUA; from the .omp / YAML), to pick e.g. Thermostat v2 */
  version?: number;
  features: FeatureInit;
  events: EventBinding[];
}

export interface EventBinding {
  /** Event index from the interface XML (e.g. Button OnClick = 4). */
  index: number;
  /** Lua lines, already resolved (e.g. `DOU3096:execute(0, 0)`); emitted one per line, tab-indented. */
  actions: string[];
}

export interface IoObject {
  /** Object id on the CLU, OM style: 3-letter prefix + 4 digits (e.g. DIM1186). Stable once created. */
  id: string;
  /** CLU object class (e.g. 5 = DIMMER, 7 = BUTTON); see interface XML `<object class=...>`. */
  objectClass: number;
  /** Channel index on the module. */
  channel: number;
  /** User name from OM (`-- NAME_IO name=id`); omitted when undefined. */
  name?: string;
  /** Emitted commented out as `--INACTIVE  ...` (OM does this for e.g. unknown Z-Wave nodes). */
  inactive?: boolean;
  features: FeatureInit;
  events: EventBinding[];
}

export interface ModuleObject {
  /** Module serial number, decimal (OM's display form, e.g. 330000009). */
  serial: number;
  /**
   * Second OBJECT:new argument, verbatim hex literal: `0x1a` for TF-Bus, `0x008500030011` for
   * Z-Wave. = the module hardware type (CONFIG.JSON hwType; docs/OM_LUA_FORMAT.md "Module line").
   */
  typeLiteral: string;
  /** Trailing comment after the serial (e.g. `02 02`); meaning unconfirmed (fw type / api ver?). */
  commentTail: string;
  ios: IoObject[];
}

export interface Script {
  name: string;
  /** Parameter names (OM `Script.parameters`); unverified how OM renders them. */
  params: string[];
  /** Script body as stored in the .omp (`scripts/<CLU>/<name>.lua`). */
  source: string;
}

export interface Clu {
  /** OM display name (`-- NAME_CLU CLU_2=CLU100000013`). */
  name: string;
  /** Object id on the CLU: `CLU` + decimal serial. */
  id: string;
  ip: string;
  /** Header comments (hex, 8 digits): FwType / FwVersion / HwType / HwVersion. */
  fwType: number;
  fwVersion: number;
  hwType: number;
  hwVersion: number;
  /** Other CLUs of the project, declared as class 1 (remote CLU proxy). */
  remotes: Array<{ id: string; ip: string }>;
  features: FeatureInit;
  /**
   * Global IO declaration order (object ids) when OM's order differs from module order: OM
   * interleaves e.g. Z-Wave objects across modules (real-clu2). Undefined = module order.
   */
  ioOrder?: string[];
  /** GATE only: project network settings OM writes into `GATE:new(5000, ip, netmask, gateway, "", "")`. */
  netmask?: string;
  gateway?: string;
  /** The CLU's own events (not OnInit, which holds the feature init block). */
  events: EventBinding[];
  /** Virtual objects, in OM order (declared after the remote CLUs). */
  objects?: VirtualObject[];
  /** User actions on the CLU OnInit event: last in OnInit as `\t<action> -- CluOnInit`. */
  onInit?: string[];
  modules: ModuleObject[];
  scripts: Script[];
}

export interface Project {
  name: string;
  clus: Clu[];
}
