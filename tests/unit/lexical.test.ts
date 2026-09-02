// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDynamicLanguages } from "../../src/services/code-graph.js";
import { chunkFileContent } from "../../src/services/indexer.js";
import {
  bm25TextFor,
  bm25TextMode,
  commentFreeCode,
  commentSyntaxFor,
  expandQuery,
  lexicalProjection,
  splitIdentifier,
  stripComments,
} from "../../src/services/lexical.js";

function syntax(language: string) {
  const found = commentSyntaxFor(language);
  if (!found) throw new Error(`no syntax for ${language}`);
  return found;
}

describe("bm25TextMode", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to lexical and accepts raw, case-insensitively", () => {
    vi.stubEnv("BM25_TEXT", "");
    expect(bm25TextMode()).toBe("lexical");
    vi.stubEnv("BM25_TEXT", " Raw ");
    expect(bm25TextMode()).toBe("raw");
  });

  it("rejects anything else, naming the variable", () => {
    vi.stubEnv("BM25_TEXT", "off");
    expect(() => bm25TextMode()).toThrow(/BM25_TEXT/);
  });
});

describe("comment-free code from the parse tree", () => {
  const chunks = (name: string, src: string) => chunkFileContent(`/p/${name}`, name, src);
  ensureDynamicLanguages();

  it("cuts a JSDoc and a trailing comment, keeps a regex that contains comment markers", () => {
    const src = [
      "/** Invia il messaggio al candidato. */",
      "export function sendOperatorMessage(s: string) {",
      "  return s.replace(/https?:\\/\\//g, ''); // strip the scheme",
      "}",
    ].join("\n");
    const [chunk] = chunks("a.ts", src);
    expect(chunk.code).toBeDefined();
    expect(chunk.code).not.toContain("candidato");
    expect(chunk.code).not.toContain("strip the scheme");
    expect(chunk.code).toContain("s.replace(/https?:\\/\\//g, '')");
  });

  it("keeps JSX text and attribute strings that look like comments", () => {
    const src = "export const A = () => <p title=\"//x\">Guida: https://example.com {item.retryBackoffLabel}</p>; // gone";
    const [chunk] = chunks("a.tsx", src);
    expect(chunk.code).toContain("https://example.com {item.retryBackoffLabel}");
    expect(chunk.code).not.toContain("gone");
  });

  it("handles PHP after ?>, Lua long strings and Rust nested comments through the grammar", () => {
    const [php] = chunks("a.php", "<?php\n$x = 1; // c\n?>\n<p>Visit http://example.com//two here</p>\n");
    expect(php.code).toContain("http://example.com//two");
    expect(php.code).not.toContain("// c");
    const [lua] = chunks("a.lua", "local s = [[hello -- not comment]] -- real\nlocal y = 2\n");
    expect(lua.code).toContain("hello -- not comment");
    expect(lua.code).not.toContain("real");
    const [rust] = chunks("a.rs", "/* outer /* inner */ still */ fn g() {} // tail\n");
    expect(rust.code).not.toContain("still");
    expect(rust.code).toContain("fn g() {}");
  });

  it("leaves code undefined for a format without a grammar", () => {
    const [chunk] = chunks("a.yaml", "key: value # note\n");
    expect(chunk.code).toBeUndefined();
    expect(commentFreeCode(chunk)).toBe("key: value \n");
  });

  it("aligns spans with the chunk after the character cap", () => {
    const body = Array.from({ length: 30 }, (_, i) => `  const v${i} = ${i}; // c${i}`).join("\n");
    const src = `export function big() {\n${body}\n}\n`;
    const [chunk] = chunkFileContent("/p/big.ts", "big.ts", src, { maxChunkChars: 200 });
    expect(chunk.content.length).toBe(200);
    expect(chunk.code).not.toMatch(/\/\/ c\d/);
    expect(chunk.code).toContain("const v0 = 0;");
  });
});

describe("stripComments (formats without a grammar)", () => {
  it("YAML: a hash inside a value is not a comment", () => {
    const out = stripComments("image: registry.io/app#sha256abc # pin\nref: master#deadbeef\n", syntax("yaml"));
    expect(out).toContain("registry.io/app#sha256abc");
    expect(out).toContain("master#deadbeef");
    expect(out).not.toContain("pin");
  });

  it("SQL: -- inside a string stays, block comments go", () => {
    const out = stripComments("select '--x' /*+ hint */ from t -- tail\n", syntax("sql"));
    expect(out).toContain("'--x'");
    expect(out).not.toContain("hint");
    expect(out).not.toContain("tail");
  });

  it("survives an unterminated block comment", () => {
    expect(stripComments("select 1 /* open", syntax("sql"))).toContain("select 1");
  });
});

describe("splitIdentifier", () => {
  it("splits camelCase, PascalCase, snake_case, acronyms and non-ASCII letters", () => {
    expect(splitIdentifier("sendWhatsAppMessage")).toEqual(["send", "Whats", "App", "Message"]);
    expect(splitIdentifier("getHTTPClient")).toEqual(["get", "HTTP", "Client"]);
    expect(splitIdentifier("wa_id_hash")).toEqual(["wa", "id", "hash"]);
    expect(splitIdentifier("berechneGröße")).toEqual(["berechne", "Größe"]);
    expect(splitIdentifier("plain")).toEqual(["plain"]);
  });
});

describe("lexicalProjection", () => {
  const chunk = {
    content: "/** Invia il messaggio. */\nexport function sendOperatorMessage(waId: string) {}",
    code: "\nexport function sendOperatorMessage(waId: string) {}",
    relativePath: "whatsapp/src/messages-send.routes.ts",
    language: "typescript",
  };

  it("ends with the expansion block, which the code alone does not contain", () => {
    const out = lexicalProjection(chunk, true);
    expect(out).not.toContain("Invia");
    expect(out.endsWith("\nsend Operator Message wa Id")).toBe(true);
    expect(out.startsWith("whatsapp/src/messages-send.routes.ts\nwhatsapp src messages send routes ts\n")).toBe(true);
  });

  it("omits the path entirely when the profile does not embed it", () => {
    const out = lexicalProjection(chunk, false);
    expect(out).not.toContain("whatsapp");
    expect(out).toContain("sendOperatorMessage");
  });

  it("does not fragment a non-ASCII identifier", () => {
    const out = lexicalProjection({ ...chunk, code: "const berechneGröße = 1;" }, false);
    expect(out).toContain("berechne Größe");
    expect(out).not.toMatch(/\sGr\s/);
  });
});

describe("bm25TextFor", () => {
  const chunk = { content: "// c\nconst a = 1;", code: "\nconst a = 1;", relativePath: "a.ts", language: "typescript" };

  it("returns the document text unchanged for a raw profile", () => {
    expect(bm25TextFor(chunk, "search_document: a.ts\n// c\nconst a = 1;", { bm25Text: "raw", documentIncludesPath: true }))
      .toBe("search_document: a.ts\n// c\nconst a = 1;");
    expect(bm25TextFor(chunk, "doc", { documentIncludesPath: true })).toBe("doc");
  });

  it("returns the projection for a lexical profile", () => {
    const out = bm25TextFor(chunk, "doc", { bm25Text: "lexical", documentIncludesPath: true });
    expect(out).not.toContain("search_document");
    expect(out).not.toContain("// c");
    expect(out).toContain("const a = 1;");
  });
});

describe("expandQuery", () => {
  it("appends split words only when an identifier splits", () => {
    expect(expandQuery("sendOperatorMessage handler")).toBe("sendOperatorMessage handler send Operator Message");
    expect(expandQuery("invio messaggio")).toBe("invio messaggio");
    expect(expandQuery("a // b")).toBe("a // b");
  });
});
