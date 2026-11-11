/** An IO object declared in OM.LUA ` DIM1186 = OBJECT:new(5, mm_<sn>, <channel>, "DIM1186")`. */
export interface OmIoObject {
  id: string;
  objectClass: number;
  moduleSerial: number;
  channel: number;
  inactive: boolean;
  /** `-- NAME_IO <name>=<id>` right after the object line */
  name?: string;
}

export interface OmObjects {
  /** this CLU (class 0) */
  cluId?: string;
  ios: OmIoObject[];
}

const IO_LINE = /^(--INACTIVE {2})? ?([A-Za-z_]\w*) = OBJECT:new\((\d+), mm_(\d+), (\d+), "\2"\)\r?$/;
const NAME_IO = /^-- NAME_IO (.+)=([A-Za-z_]\w*)\r?$/;
const CLU_LINE = /^([A-Za-z_]\w*) = OBJECT:new\(0, 0x[0-9A-F]+, "\1"\)\r?$/;

/**
 * Reads the object declarations of an OM.LUA (as OM writes it, docs/OM_LUA_FORMAT.md): this CLU's
 * id and every module IO with its module serial, channel and NAME_IO. Only the declaration lines
 * are read; events and OnInit are ignored.
 */
export function parseOmObjects(text: string): OmObjects {
  const result: OmObjects = { ios: [] };
  let last: OmIoObject | undefined;
  for (const line of text.split("\n")) {
    const io = IO_LINE.exec(line);
    if (io) {
      last = { id: io[2], objectClass: Number(io[3]), moduleSerial: Number(io[4]), channel: Number(io[5]), inactive: !!io[1] };
      result.ios.push(last);
      continue;
    }
    const name = NAME_IO.exec(line);
    if (name && last && name[2] === last.id) {
      last.name = name[1];
      continue;
    }
    last = undefined;
    const clu = CLU_LINE.exec(line);
    if (clu) result.cluId = clu[1];
  }
  return result;
}

/** Key for matching CONFIG.JSON IOs (module serial + class + channel) to OM.LUA objects. */
export const ioKey = (moduleSerial: number, objectClass: number, channel: number) => `${moduleSerial}/${objectClass}/${channel}`;

export function indexIos(objects: OmObjects): Map<string, OmIoObject> {
  return new Map(objects.ios.map((o) => [ioKey(o.moduleSerial, o.objectClass, o.channel), o]));
}
