import { describe, expect, it } from "vitest";
import {
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

const ts = syntax("typescript");

describe("stripComments", () => {
  it("drops line and block comments, keeps the code", () => {
    const src = `// header\nconst a = 1; /* inline */ const b = 2;\n/**\n * doc\n */\nexport function f() {}`;
    const out = stripComments(src, ts);
    expect(out).not.toContain("header");
    expect(out).not.toContain("inline");
    expect(out).not.toContain("doc");
    expect(out).toContain("const a = 1;");
    expect(out).toContain("export function f() {}");
  });

  it("leaves comment markers inside string literals alone", () => {
    const src = `const url = "https://example.com/x"; const t = 'a // b'; const u = \`/* not */\`;`;
    expect(stripComments(src, ts)).toBe(src);
  });

  it("handles escaped quotes inside a literal", () => {
    const src = `const s = "say \\"hi\\" // still string"; // gone`;
    const out = stripComments(src, ts);
    expect(out).toContain(`"say \\"hi\\" // still string"`);
    expect(out).not.toContain("gone");
  });

  it("does not treat a Rust lifetime as an open string", () => {
    const src = `fn f<'a>(x: &'a str) -> &'a str { x } // comment\nfn g() {}`;
    const out = stripComments(src, syntax("rust"));
    expect(out).not.toContain("comment");
    expect(out).toContain("fn g() {}");
  });

  it("keeps Python floor division and drops # comments", () => {
    const src = `x = a // b  # halve\n"""doc"""\ny = 2`;
    const out = stripComments(src, syntax("python"));
    expect(out).toContain("x = a // b");
    expect(out).not.toContain("halve");
    expect(out).toContain('"""doc"""');
  });

  it("treats a Lua --[[ block ]] before the -- line marker", () => {
    const src = `--[[ multi\nline ]] local x = 1 -- tail\nlocal y = 2`;
    const out = stripComments(src, syntax("lua"));
    expect(out).not.toContain("multi");
    expect(out).toContain("local x = 1");
    expect(out).not.toContain("tail");
    expect(out).toContain("local y = 2");
  });

  it("survives an unterminated block comment", () => {
    expect(stripComments("const a = 1; /* open", ts)).toContain("const a = 1;");
  });
});

describe("splitIdentifier", () => {
  it("splits camelCase, PascalCase, snake_case and acronyms", () => {
    expect(splitIdentifier("sendWhatsAppMessage")).toEqual(["send", "Whats", "App", "Message"]);
    expect(splitIdentifier("getHTTPClient")).toEqual(["get", "HTTP", "Client"]);
    expect(splitIdentifier("wa_id_hash")).toEqual(["wa", "id", "hash"]);
    expect(splitIdentifier("plain")).toEqual(["plain"]);
  });
});

describe("lexicalProjection", () => {
  it("removes an Italian JSDoc and keeps the English identifiers, split and whole", () => {
    const src = [
      "/**",
      " * Invia il messaggio al candidato e aggiorna lo stato della conversazione.",
      " */",
      "export async function sendOperatorMessage(waId: string) {",
      "  return dispatcher.attemptOne(waId)",
      "}",
    ].join("\n");
    const out = lexicalProjection(src, "whatsapp/src/modules/messages-send.routes.ts", "typescript");
    expect(out).not.toContain("candidato");
    expect(out).toContain("sendOperatorMessage");
    expect(out).toContain("Operator");
    expect(out).toContain("attemptOne");
    expect(out).toContain("whatsapp src modules messages send routes ts");
  });

  it("keeps a document whole", () => {
    const md = "# Titolo\n\nTesto in italiano.";
    expect(lexicalProjection(md, "docs/guida.md", "markdown")).toContain("Testo in italiano.");
  });

  it("leaves an unknown language untouched apart from the path", () => {
    const src = "-- not a comment here\nvalue";
    expect(lexicalProjection(src, "a.unknown", "unknown")).toContain("-- not a comment here");
  });
});

describe("expandQuery", () => {
  it("appends split words only when an identifier splits", () => {
    expect(expandQuery("sendOperatorMessage handler")).toBe("sendOperatorMessage handler send Operator Message");
    expect(expandQuery("invio messaggio")).toBe("invio messaggio");
  });
});
