// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The text handed to the BM25 leg of hybrid search.
 *
 * `raw` is the pre-existing behaviour: the same string the dense vector embeds.
 * `lexical` gives BM25 what a chunk *is* — path, code without comments, and the
 * words inside every identifier — so a lookup by name or by its words meets the
 * defining chunk. The dense vector keeps the full text either way. The mode is
 * part of the collection's effective index profile: a collection built as `raw`
 * stays `raw` through incremental updates and is queried as `raw`.
 */

export type Bm25TextMode = "raw" | "lexical";

/** BM25 text mode requested for fresh code indexes, from `BM25_TEXT`. Default: `lexical`. */
export function bm25TextMode(): Bm25TextMode {
  const raw = process.env.BM25_TEXT;
  if (!raw || raw.trim() === "") return "lexical";
  const value = raw.trim().toLowerCase();
  if (value === "raw" || value === "lexical") return value;
  throw new Error(`Invalid BM25_TEXT: "${raw}". Must be "raw", "lexical", or left unset.`);
}

export interface CommentSyntax {
  line: string[];
  block: Array<[string, string]>;
  strings: string[];
  /** Line markers count only at line start or after whitespace: `a#b` is a value. */
  lineNeedsBoundary?: boolean;
}

// Only formats without an ast-grep grammar. Code with a grammar gets its
// comments from the parse tree (`FileChunk.code`), never from this table.
const SYNTAX: Record<string, CommentSyntax> = {
  yaml: { line: ["#"], block: [], strings: ['"', "'"], lineNeedsBoundary: true },
  toml: { line: ["#"], block: [], strings: ['"', "'"] },
  dockerfile: { line: ["#"], block: [], strings: ['"', "'"] },
  sql: { line: ["--"], block: [["/*", "*/"]], strings: ["'", '"'] },
};

export function commentSyntaxFor(language: string): CommentSyntax | undefined {
  return SYNTAX[language];
}

/** Drop comments; string literals pass through verbatim. An unclosed quote ends with its line. */
export function stripComments(content: string, syntax: CommentSyntax): string {
  const n = content.length;
  let out = "";
  let i = 0;

  while (i < n) {
    const quote = syntax.strings.find((q) => content.startsWith(q, i));
    if (quote) {
      let j = i + quote.length;
      while (j < n) {
        if (content[j] === "\\") { j += 2; continue; }
        if (content.startsWith(quote, j)) { j += quote.length; break; }
        if (content[j] === "\n") break;
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

    const atBoundary = !syntax.lineNeedsBoundary || i === 0 || /\s/.test(content[i - 1]);
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

const IDENTIFIER = /[\p{L}_$][\p{L}\p{N}_$]*/gu;
const WORD_BOUNDARY = /[_$]+|(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u;

/** `sendWhatsAppMessage` → ["send", "Whats", "App", "Message"]; a lone word comes back alone. */
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

export interface LexicalChunk {
  content: string;
  /** Content with comments removed by the parser; absent when no grammar parsed the file. */
  code?: string;
  relativePath: string;
  language: string;
}

/** The chunk without its comments: from the parse tree when there is one, else from the table, else whole. */
export function commentFreeCode(chunk: LexicalChunk): string {
  if (chunk.code !== undefined) return chunk.code;
  const syntax = SYNTAX[chunk.language];
  return syntax ? stripComments(chunk.content, syntax) : chunk.content;
}

/** BM25 text in `lexical` mode. The path follows the profile's `documentIncludesPath`. */
export function lexicalProjection(chunk: LexicalChunk, includesPath: boolean): string {
  const code = commentFreeCode(chunk);
  const pathWords = includesPath
    ? chunk.relativePath.split(/[/.\-_]+/).filter(Boolean).join(" ")
    : "";
  return [includesPath ? chunk.relativePath : "", pathWords, code, expansionsOf(code).join(" ")]
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

/** BM25 text for one chunk under the collection's profile. `documentText` is what the dense leg embeds. */
export function bm25TextFor(
  chunk: LexicalChunk,
  documentText: string,
  profile: { bm25Text?: Bm25TextMode; documentIncludesPath: boolean },
): string {
  return profile.bm25Text === "lexical"
    ? lexicalProjection(chunk, profile.documentIncludesPath)
    : documentText;
}

/** Query-side expansion for `lexical` collections, so `sendOperatorMessage` meets `send operator message`. */
export function expandQuery(query: string): string {
  const words = expansionsOf(query);
  return words.length > 0 ? `${query} ${words.join(" ")}` : query;
}
