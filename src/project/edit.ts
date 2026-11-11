/**
 * Small, format-preserving edits of project YAML (comments, flow style and order kept: yaml
 * Document API). Pure: text in, text out.
 */
import { isMap, isSeq, parseDocument, YAMLSeq } from "yaml";

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
