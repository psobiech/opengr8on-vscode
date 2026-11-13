/**
 * Small, format-preserving edits of project YAML (comments, flow style and order kept: yaml
 * Document API). Pure: text in, text out.
 */
import { isMap, isScalar, isSeq, parseDocument, YAMLSeq } from "yaml";

export const LUA_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Adds `- name: <name>` to the top-level `scripts:` list of a clus/<CLU>.yaml (creating it). */
export function addScriptToCluYaml(text: string, name: string): string {
  if (!LUA_IDENTIFIER.test(name)) throw new Error(`"${name}" is not a valid script name (letters, digits, _; not starting with a digit)`);
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`the CLU file has YAML errors: ${doc.errors[0].message.split("\n")[0]}`);
  if (!isMap(doc.contents)) throw new Error("the CLU file is not a mapping");
  let scripts = doc.get("scripts", true);
  if (scripts === undefined || scripts === null || (!isSeq(scripts) && (scripts as { value?: unknown }).value === null)) {
    scripts = new YAMLSeq();
    doc.set("scripts", scripts);
  }
  if (!isSeq(scripts)) throw new Error("scripts: is not a list");
  if (scripts.items.some((s) => isMap(s) && s.get("name") === name)) throw new Error(`script ${name} already exists`);
  const entry = doc.createNode({ name });
  if (scripts.flow) entry.flow = true;
  scripts.add(entry);
  return doc.toString({ lineWidth: 0 });
}

/**
 * Appends a virtual object to the top-level `objects:` list of a clus/<CLU>.yaml (creating it):
 * `- { id, class, version?, name }`. The id must not be taken (caller allocates it, see allocateId).
 */
export function addObjectToCluYaml(text: string, o: { id: string; className: string; version?: number; name: string }): string {
  if (!LUA_IDENTIFIER.test(o.name)) throw new Error(`"${o.name}" is not a valid object name (letters, digits, _; not starting with a digit)`);
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`the CLU file has YAML errors: ${doc.errors[0].message.split("\n")[0]}`);
  if (!isMap(doc.contents)) throw new Error("the CLU file is not a mapping");
  let objects = doc.get("objects", true);
  if (objects === undefined || objects === null || (!isSeq(objects) && (objects as { value?: unknown }).value === null)) {
    objects = new YAMLSeq();
    doc.set("objects", objects);
  }
  if (!isSeq(objects)) throw new Error("objects: is not a list");
  if (objects.items.some((x) => isMap(x) && (x.get("id") === o.id || x.get("name") === o.name))) throw new Error(`object ${o.name} (${o.id}) already exists`);
  const entry = doc.createNode({ id: o.id, class: o.className, ...(o.version !== undefined ? { version: o.version } : {}), name: o.name });
  if (objects.flow) entry.flow = true;
  objects.add(entry);
  return doc.toString({ lineWidth: 0 });
}

/** Initial content of a new script. */
export const scriptTemplate = (clu: string, name: string) =>
  `-- ${name}: skrypt CLU ${clu}\n-- Obiekty: ${clu}->NAZWA->Cecha / ${clu}->NAZWA->Metoda(...)\n\n`;

/**
 * Removes an entry from a top-level list of a clus/<CLU>.yaml: `objects:` (matched by name or id)
 * or `scripts:` (by name). An emptied list is dropped. Comments elsewhere are kept.
 */
export function removeFromCluYaml(text: string, list: "objects" | "scripts", nameOrId: string): string {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`the CLU file has YAML errors: ${doc.errors[0].message.split("\n")[0]}`);
  const seq = doc.get(list, true);
  if (!isSeq(seq)) throw new Error(`${list}: is not a list`);
  const i = seq.items.findIndex((s) => isMap(s) && (s.get("name") === nameOrId || (list === "objects" && s.get("id") === nameOrId)));
  if (i < 0) throw new Error(`${nameOrId} not found in ${list}:`);
  seq.items.splice(i, 1);
  if (seq.items.length === 0) doc.delete(list);
  return doc.toString({ lineWidth: 0 });
}

/**
 * Drops CLU `name` from the `clu.remotes:` list of a clus/<CLU>.yaml. Unchanged text when it is not
 * listed (or there is no explicit list: the default "all other CLUs" follows the project). An
 * emptied list stays as `remotes: []` (no remotes), not removed (that would mean all of them).
 */
export function removeRemoteFromCluYaml(text: string, name: string): string {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`the CLU file has YAML errors: ${doc.errors[0].message.split("\n")[0]}`);
  const seq = doc.getIn(["clu", "remotes"], true);
  if (!isSeq(seq)) return text;
  const before = seq.items.length;
  seq.items = seq.items.filter((s) => !(isScalar(s) && s.value === name));
  if (seq.items.length === before) return text;
  if (seq.items.length === 0) seq.flow = true;
  return doc.toString({ lineWidth: 0 });
}
