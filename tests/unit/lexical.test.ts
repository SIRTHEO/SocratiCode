// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from "vitest";
import {
  bm25TextFor,
  bm25TextMode,
  expandQuery,
  identifierWords,
  splitIdentifier,
} from "../../src/services/lexical.js";

const original = process.env.BM25_TEXT;
afterEach(() => {
  if (original === undefined) delete process.env.BM25_TEXT;
  else process.env.BM25_TEXT = original;
});

describe("bm25TextMode", () => {
  it("defaults to lexical and accepts raw, case-insensitively", () => {
    delete process.env.BM25_TEXT;
    expect(bm25TextMode()).toBe("lexical");
    process.env.BM25_TEXT = "";
    expect(bm25TextMode()).toBe("lexical");
    process.env.BM25_TEXT = " RAW ";
    expect(bm25TextMode()).toBe("raw");
  });

  it("rejects anything else, naming the variable", () => {
    process.env.BM25_TEXT = "code";
    expect(() => bm25TextMode()).toThrow(/BM25_TEXT.*"code"/);
  });
});

describe("splitIdentifier", () => {
  it("splits camelCase, PascalCase, snake_case, acronyms and non-ASCII letters", () => {
    expect(splitIdentifier("sendOperatorMessage")).toEqual(["send", "Operator", "Message"]);
    expect(splitIdentifier("HTTPServer")).toEqual(["HTTP", "Server"]);
    expect(splitIdentifier("send_operator_message")).toEqual(["send", "operator", "message"]);
    expect(splitIdentifier("$scope")).toEqual(["scope"]);
    expect(splitIdentifier("berechneGröße")).toEqual(["berechne", "Größe"]);
    expect(splitIdentifier("alone")).toEqual(["alone"]);
  });
});

describe("identifierWords", () => {
  it("lists each word once, only from identifiers that actually split", () => {
    expect(identifierWords("sendOperatorMessage(waId, waId); const alone = 1;")).toEqual([
      "send", "Operator", "Message", "wa", "Id",
    ]);
  });

  it("does not fragment a non-ASCII single-word identifier", () => {
    expect(identifierWords("const größe = 1;")).toEqual([]);
  });
});

describe("bm25TextFor", () => {
  it("returns the document text unchanged for a raw or absent mode", () => {
    const text = "search_document: routes.ts\nexport function sendOperatorMessage() {}";
    expect(bm25TextFor(text, { bm25Text: "raw" })).toBe(text);
    expect(bm25TextFor(text, {})).toBe(text);
  });

  it("appends the identifier words after the document text for a lexical profile", () => {
    const text = "passage: routes.ts\n/** Sends. */\nexport function sendOperatorMessage() {}";
    expect(bm25TextFor(text, { bm25Text: "lexical" })).toBe(`${text}\nsend Operator Message`);
  });

  it("leaves text without a multi-word identifier untouched in lexical mode", () => {
    expect(bm25TextFor("plain prose here", { bm25Text: "lexical" })).toBe("plain prose here");
  });
});

describe("expandQuery", () => {
  it("appends split words only when an identifier splits", () => {
    expect(expandQuery("sendOperatorMessage")).toBe("sendOperatorMessage send Operator Message");
    expect(expandQuery("send operator message")).toBe("send operator message");
  });
});
