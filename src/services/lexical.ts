// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The text handed to the BM25 leg of hybrid search.
 *
 * `raw` is the pre-existing behaviour: the same string the dense vector embeds.
 * `lexical` appends the words inside every multi-word identifier, so a lookup
 * by `send operator message` meets the chunk that defines `sendOperatorMessage`
 * (the `qdrant/bm25` tokenizer never splits on case change and keeps `_` inside
 * a token). The mode is part of the collection's effective index profile: a
 * collection built as `raw` stays `raw` through incremental updates and is
 * queried as `raw`.
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

const IDENTIFIER = /[\p{L}_$][\p{L}\p{N}_$]*/gu;
const WORD_BOUNDARY = /[_$]+|(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u;

/** `sendWhatsAppMessage` → ["send", "Whats", "App", "Message"]; a lone word comes back alone. */
export function splitIdentifier(identifier: string): string[] {
  return identifier.split(WORD_BOUNDARY).filter((w) => w.length > 1);
}

/** The distinct words of every multi-word identifier in `text`, in order of first appearance. */
export function identifierWords(text: string): string[] {
  const words = new Set<string>();
  for (const id of text.match(IDENTIFIER) ?? []) {
    const parts = splitIdentifier(id);
    if (parts.length > 1) for (const p of parts) words.add(p);
  }
  return [...words];
}

/** BM25 text for one chunk under the collection's profile. `documentText` is what the dense leg embeds. */
export function bm25TextFor(documentText: string, profile: { bm25Text?: Bm25TextMode }): string {
  if (profile.bm25Text !== "lexical") return documentText;
  const words = identifierWords(documentText);
  return words.length > 0 ? `${documentText}\n${words.join(" ")}` : documentText;
}

/** Query-side counterpart for `lexical` collections, so `sendOperatorMessage` also meets `send operator message`. */
export function expandQuery(query: string): string {
  const words = identifierWords(query);
  return words.length > 0 ? `${query} ${words.join(" ")}` : query;
}
