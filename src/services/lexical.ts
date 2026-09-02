/**
 * Lexical projection for the BM25 leg of hybrid search: what a chunk *is*
 * (path, identifiers, literals), not what its comments say about it. The dense
 * vector keeps the full text, comments included.
 */

export interface CommentSyntax {
  line: string[];
  block: Array<[string, string]>;
  strings: string[];
  /** Line markers count only at line start or after whitespace / `;` (shell: `$#`, `${#x}` are code). */
  lineNeedsBoundary?: boolean;
  /** Rust raw strings: `r"…"`, `r#"…"#`, any number of hashes. */
  rawStrings?: boolean;
  /** Shell here-documents pass through whole: their body is data or another language's code. */
  heredocs?: boolean;
  /** Quoted strings may span lines (shell); elsewhere an unclosed quote ends with its line. */
  multilineStrings?: boolean;
}

const C_LIKE: CommentSyntax = { line: ["//"], block: [["/*", "*/"]], strings: ['"', "'", "`"] };
const C_DQ: CommentSyntax = { line: ["//"], block: [["/*", "*/"]], strings: ['"'] };
const HASH: CommentSyntax = { line: ["#"], block: [], strings: ['"', "'"] };
const SHELL: CommentSyntax = { ...HASH, lineNeedsBoundary: true, heredocs: true, multilineStrings: true };
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
  rust: { ...C_DQ, rawStrings: true },
  php: { line: ["//", "#"], block: [["/*", "*/"]], strings: ['"', "'"] },
  python: { line: ["#"], block: [], strings: ['"""', "'''", '"', "'"] },
  ruby: HASH,
  shell: SHELL,
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
  let pendingHeredoc = -1;

  while (i < n) {
    if (pendingHeredoc >= 0 && content[i] === "\n") {
      out += content.slice(i, pendingHeredoc);
      i = pendingHeredoc;
      pendingHeredoc = -1;
      continue;
    }
    if (syntax.heredocs && pendingHeredoc < 0 && content.startsWith("<<", i)) {
      const j = heredocEnd(content, i);
      if (j >= 0) {
        // The rest of the `<<` line is still shell; the body starts at the next newline.
        const tokenEnd = i + (HEREDOC.exec(content.slice(i, i + 64))?.[0].length ?? 2);
        out += content.slice(i, tokenEnd);
        i = tokenEnd;
        pendingHeredoc = j;
        continue;
      }
    }
    if (syntax.rawStrings && content[i] === "r" && (i === 0 || !/[\w$]/.test(content[i - 1]))) {
      let h = i + 1;
      while (content[h] === "#") h++;
      if (content[h] === '"') {
        const close = `"${"#".repeat(h - i - 1)}`;
        const end = content.indexOf(close, h + 1);
        const j = end < 0 ? n : end + close.length;
        out += content.slice(i, j);
        i = j;
        continue;
      }
    }

    const quote = quotes.find((q) => content.startsWith(q, i));
    if (quote) {
      let j = i + quote.length;
      while (j < n) {
        if (content[j] === "\\") { j += 2; continue; }
        if (content.startsWith(quote, j)) { j += quote.length; break; }
        // A single-line literal that never closes ends with its line.
        if (quote.length === 1 && quote !== "`" && !syntax.multilineStrings && content[j] === "\n") break;
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

    const atBoundary = !syntax.lineNeedsBoundary || i === 0 || /[\s;]/.test(content[i - 1]);
    if (atBoundary && syntax.line.some((marker) => content.startsWith(marker, i))) {
      const end = content.indexOf("\n", i);
      i = end < 0 ? n : end;
      continue;
    }

    out += content[i];
    i++;
  }

  return out;
}

const HEREDOC = /^<<-?\s*(?:'(\w+)'|"(\w+)"|(\w+))/;

/** Index just past the here-document whose `<<` starts at `i`, or -1 if none starts here. */
function heredocEnd(content: string, i: number): number {
  const m = HEREDOC.exec(content.slice(i, i + 64));
  if (!m) return -1;
  const tag = m[1] ?? m[2] ?? m[3];
  const bodyStart = content.indexOf("\n", i);
  if (bodyStart < 0) return content.length;
  const close = new RegExp(`^\\t*${tag}$`, "m");
  const rest = content.slice(bodyStart + 1);
  const hit = close.exec(rest);
  return hit ? bodyStart + 1 + hit.index + hit[0].length : content.length;
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
