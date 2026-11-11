import * as vscode from "vscode";
import type { InterfaceRegistry } from "opengr8on-node/client";
import { arrowMemberItems, arrowObjectItems, luaContext, luaHints, luaIndexItems, luaObjectItems, yamlCompletion, type CluIndex, type Item, type ProjectIndex } from "../project/assist";
import { cluOfScript } from "./projectCommands";

const KIND: Record<Item["kind"], vscode.CompletionItemKind> = {
  object: vscode.CompletionItemKind.Variable,
  clu: vscode.CompletionItemKind.Module,
  feature: vscode.CompletionItemKind.Property,
  method: vscode.CompletionItemKind.Method,
  event: vscode.CompletionItemKind.Event,
  script: vscode.CompletionItemKind.Function,
};

function toCompletion(i: Item, range: vscode.Range): vscode.CompletionItem {
  const c = new vscode.CompletionItem({ label: i.label, description: i.detail }, KIND[i.kind]);
  c.insertText = i.snippet ? new vscode.SnippetString(i.insert) : i.insert;
  c.sortText = i.sort;
  c.filterText = i.filter ?? i.label;
  c.detail = i.detail;
  if (i.documentation) c.documentation = i.documentation;
  c.range = range;
  return c;
}

export interface AssistDeps {
  index(): ProjectIndex | undefined;
  registry(): InterfaceRegistry;
  root(): vscode.Uri | undefined;
  selectedSerial(): number | undefined;
}

/** CLU of a document: scripts/<CLU>/… or clus/<CLU>.yaml, else the selected / only CLU. */
function cluFor(doc: vscode.TextDocument, deps: AssistDeps): CluIndex | undefined {
  const index = deps.index();
  const root = deps.root();
  if (!index || !root) return undefined;
  const rel = doc.uri.path.startsWith(root.path + "/") ? doc.uri.path.slice(root.path.length + 1) : "";
  const name = cluOfScript(rel) ?? /^clus\/([^/]+)\.ya?ml$/.exec(rel)?.[1];
  if (name && index.has(name)) return index.get(name);
  const sel = deps.selectedSerial();
  const bySel = [...index.values()].find((c) => c.clu.id === `CLU${sel}`);
  return bySel ?? (index.size === 1 ? [...index.values()][0] : undefined);
}

export function registerEditorAssist(context: vscode.ExtensionContext, deps: AssistDeps): { refresh(): void } {
  const hintsChanged = new vscode.EventEmitter<void>();
  const luaSelector: vscode.DocumentSelector = { language: "lua", pattern: "**/scripts/**/*.lua" };
  const yamlSelector: vscode.DocumentSelector = { language: "yaml", pattern: "**/clus/*.{yaml,yml}" };

  context.subscriptions.push(
    hintsChanged,
    vscode.languages.registerCompletionItemProvider(
      luaSelector,
      {
        provideCompletionItems(doc, pos) {
          const clu = cluFor(doc, deps);
          if (!clu) return undefined;
          const prefix = doc.lineAt(pos.line).text.slice(0, pos.character);
          const ctx = luaContext(prefix);
          if (ctx.kind === "index") {
            const o = clu.byId.get(ctx.objectId);
            return o ? luaIndexItems(o, ctx.op).map((i) => toCompletion(i, new vscode.Range(pos, pos))) : undefined;
          }
          if (ctx.kind === "arrowObject" || ctx.kind === "arrowMember") {
            const index = deps.index();
            const range = new vscode.Range(pos.translate(0, -ctx.word.length), pos);
            if (!index) return undefined;
            if (ctx.kind === "arrowObject") return arrowObjectItems(index, ctx.clu).map((i) => toCompletion(i, range));
            const target = index.get(ctx.clu) ?? [...index.values()].find((c) => c.clu.id === ctx.clu);
            const o = target?.byName.get(ctx.object) ?? target?.byId.get(ctx.object);
            return o ? arrowMemberItems(o).map((i) => toCompletion(i, range)) : undefined;
          }
          if (/[.:]\w*$/.test(prefix)) return undefined; // member access: LuaLS
          const range = new vscode.Range(pos.translate(0, -ctx.word.length), pos);
          return luaObjectItems(clu).map((i) => toCompletion(i, range));
        },
      },
      "(",
      ">",
    ),
    vscode.languages.registerInlayHintsProvider(luaSelector, {
      onDidChangeInlayHints: hintsChanged.event,
      provideInlayHints(doc, range) {
        const clu = cluFor(doc, deps);
        if (!clu) return [];
        const start = doc.offsetAt(range.start);
        const text = doc.getText();
        return luaHints(text, clu)
          .filter((h) => h.offset >= start && h.offset <= doc.offsetAt(range.end))
          .map((h) => {
            const hint = new vscode.InlayHint(doc.positionAt(h.offset), ` ${h.label}`, vscode.InlayHintKind.Type);
            hint.tooltip = h.tooltip;
            hint.paddingLeft = false;
            return hint;
          });
      },
    }),
    vscode.languages.registerCompletionItemProvider(
      yamlSelector,
      {
        provideCompletionItems(doc, pos) {
          const index = deps.index();
          if (!index) return undefined;
          const line = doc.lineAt(pos.line).text.slice(0, pos.character);
          const { items, replaceLength } = yamlCompletion(index, cluFor(doc, deps), doc.getText(), doc.offsetAt(pos), line, deps.registry());
          if (!items.length) return undefined;
          const range = new vscode.Range(pos.translate(0, -replaceLength), pos);
          return items.map((i) => toCompletion(i, range));
        },
      },
      ">",
      "-",
      ":",
    ),
  );
  return { refresh: () => hintsChanged.fire() };
}
