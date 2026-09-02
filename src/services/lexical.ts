/**
 * Lexical projection for the BM25 leg of hybrid search: what a chunk *is*
 * (path, identifiers, literals), not what its comments say about it. The dense
 * vector keeps the full text, comments included.
 */

export interface CommentSyntax {
  line: string[];
  block: Array<[string, string]>;
  strings: string[];
}

const C_LIKE: CommentSyntax = { line: ["//"], block: [["/*", "*/"]], strings: ['"', "'", "`"] };
const C_DQ: CommentSyntax = { line: ["//"], block: [["/*", "*/"]], strings: ['"'] };
const HASH: CommentSyntax = { line: ["#"], block: [], strings: ['"', "'"] };
const CSS_LIKE: CommentSyntax = { line: ["//"], block: [["/*", "*/"]], strings: ['"', "'"] };
const MARKUP: CommentSyntax = { line: [], block: [["<!--", "-->"]], strings: [] };

// Languages absent here are projected untouched (documents, unknown grammars).
// Rust and Java skip `'`: lifetimes and char literals would swallow code.
const SYNTAX: Record<string, CommentSyntax> = {
  javascript: C_LIKE,
  typescript: C_LIKE,
  go: C_LIKE,
  dart: C_LIKE,
  swift: C_LIKE,
  kotlin: C_LIKE,
  scala: C_LIKE,
  csharp: C_LIKE,
  c: C_LIKE,
  cpp: C_LIKE,
  java: C_DQ,
  rust: C_DQ,
  php: { line: ["//", "#"], block: [["/*", "*/"]], strings: ['"', "'"] },
  python: { line: ["#"], block: [], strings: ['"""', "'''", '"', "'"] },
  ruby: HASH,
  shell: HASH,
  yaml: HASH,
  toml: HASH,
  r: HASH,
  dockerfile: HASH,
  css: { line: [], block: [["/*", "*/"]], strings: ['"', "'"] },
  scss: CSS_LIKE,
  sass: CSS_LIKE,
  less: CSS_LIKE,
  stylus: CSS_LIKE,
  sql: { line: ["--"], block: [["/*", "*/"]], strings: ["'", '"'] },
  lua: { line: ["--"], block: [["--[[", "]]"]], strings: ['"', "'"] },
  html: MARKUP,
  xml: MARKUP,
  vue: { line: ["//"], block: [["<!--", "-->"], ["/*", "*/"]], strings: ['"', "'", "`"] },
  svelte: { line: ["//"], block: [["<!--", "-->"], ["/*", "*/"]], strings: ['"', "'", "`"] },
  json: { line: [], block: [], strings: ['"'] },
};

export function commentSyntaxFor(language: string): CommentSyntax | undefined {
  return SYNTAX[language];
}

/** Drop comments; string literals pass through verbatim, delimiters included. */
export function stripComments(content: string, syntax: CommentSyntax): string {
  const quotes = [...syntax.strings].sort((a, b) => b.length - a.length);
  const n = content.length;
  let out = "";
  let i = 0;

  while (i < n) {
    const quote = quotes.find((q) => content.startsWith(q, i));
    if (quote) {
      let j = i + quote.length;
      while (j < n) {
        if (content[j] === "\\") { j += 2; continue; }
        if (content.startsWith(quote, j)) { j += quote.length; break; }
        // A single-line literal that never closes ends with its line.
        if (quote.length === 1 && quote !== "`" && content[j] === "\n") break;
        j++;
      }
      out += content.slice(i, j);
      i = j;
      continue;
    }

    const block = syntax.block.find(([open]) => content.startsWith(open, i));
    if (block) {
      const end = content.indexOf(block[1], i + block[0].length);
      i = end < 0 ? n : end + block[1].length;
      out += " ";
      continue;
    }

    if (syntax.line.some((marker) => content.startsWith(marker, i))) {
      const end = content.indexOf("\n", i);
      i = end < 0 ? n : end;
      continue;
    }

    out += content[i];
    i++;
  }

  return out;
}

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const WORD_BOUNDARY = /[_$]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

/** `sendWhatsAppMessage` → ["send", "Whats", "App", "Message"]; single words come back alone. */
export function splitIdentifier(identifier: string): string[] {
  return identifier.split(WORD_BOUNDARY).filter((w) => w.length > 1);
}

function expansionsOf(text: string): string[] {
  const words = new Set<string>();
  for (const id of text.match(IDENTIFIER) ?? []) {
    const parts = splitIdentifier(id);
    if (parts.length > 1) for (const p of parts) words.add(p);
  }
  return [...words];
}

/** Text handed to BM25 for one chunk. Re-index to apply: the sparse vector is stored. */
export function lexicalProjection(content: string, relativePath: string, language: string): string {
  const syntax = SYNTAX[language];
  const code = syntax ? stripComments(content, syntax) : content;
  const pathWords = relativePath.split(/[/.\-_]+/).filter(Boolean).join(" ");
  return [relativePath, pathWords, code, expansionsOf(code).join(" ")]
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

/** Same expansion on the query side, so `sendOperatorMessage` meets `send operator message`. */
export function expandQuery(query: string): string {
  const words = expansionsOf(query);
  return words.length > 0 ? `${query} ${words.join(" ")}` : query;
}
