// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCodeGraph } from "../../src/services/code-graph.js";
import { resolveCallSites } from "../../src/services/graph-symbol-resolution.js";
import type { SymbolEdge } from "../../src/types.js";

/**
 * What `super::` means when the call is written inside an inline `mod`.
 *
 * `super` counts modules, and an inline `mod` is one: inside
 * `#[cfg(test)] mod tests { … }` written in `a/b.rs`, `super::helper()` is
 * `b.rs`'s own `helper` and `super::super::sub::f()` is the `sub` of `b.rs`'s
 * parent. Resolution knows only files, so unless the nesting is accounted for
 * where it is still visible — in the extractor — both answer one module too
 * high: the parent's `helper`, and the grandparent's `sub`. Not a wider
 * answer, a different one, and reported as `unique`.
 *
 * This goes through the real `buildCodeGraph` pass rather than handing a
 * qualifier to `resolveCallSites`, because the qualifier is exactly what is
 * under test: by the time resolution sees it, it must already read as the file
 * would have written it.
 */
describe("Rust `super::` written inside an inline mod", () => {
  let root: string;
  let qualified: Map<string, SymbolEdge>;
  /** Kept so a test can check the fixture still declares what it is about. */
  let symbolsOf: (file: string) => string[];

  const write = (rel: string, body: string): void => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-rust-inline-mod-"));

    write("Cargo.toml", '[package]\nname = "inlinemod"\nedition = "2021"\n');
    write("src/lib.rs", "pub mod a;\npub mod sub;\n");
    write("src/sub.rs", "pub fn f() -> u32 { 1 }\npub fn h() -> u32 { 8 }\n");
    write("src/a.rs", `pub mod b;
pub mod c;
pub mod d;
pub mod sub;

pub fn helper() -> u32 { 2 }
`);
    // The name exists in this file only inside an inline `mod`, so from
    // `tests` there is nothing for `super::only_inside()` to reach. Checked
    // against rustc, which answers E0425 for exactly this shape.
    write("src/a/c.rs", `mod holder {
    pub fn only_inside() -> u32 { 11 }
}

#[cfg(test)]
mod tests {
    #[test]
    fn nothing_at_the_file_top_level() {
        let _ = super::only_inside();
    }
}
`);
    // The common shape, and the one that must not be lost: a `super::` call in
    // `mod tests` in a file with no homonym inside any inline `mod`. It is 5
    // edges on tokio 1.40.0 and 4 on the private tree.
    write("src/a/d.rs", `pub fn lone() -> u32 { 12 }

#[cfg(test)]
mod tests {
    #[test]
    fn the_common_shape_still_resolves() {
        let _ = super::lone();
    }
}
`);
    write("src/a/sub.rs", "pub fn f() -> u32 { 3 }\n");
    write("src/a/b/sub.rs", "pub fn g() -> u32 { 5 }\n");
    write("src/a/b/inner.rs", "pub fn probe() -> u32 { 7 }\n");
    write("src/a/b.rs", `pub mod sub;
pub mod inner;
use crate::sub as aliased;

pub fn helper() -> u32 { 4 }

#[cfg(test)]
mod tests {
    #[test]
    fn one_hop_is_this_file() {
        let _ = super::helper();
    }

    #[test]
    fn self_is_the_inline_mod() {
        let _ = self::helper();
    }

    #[test]
    fn one_hop_then_a_module() {
        let _ = super::sub::g();
    }

    #[test]
    fn one_hop_then_an_imported_name() {
        let _ = super::aliased::h();
    }

    #[test]
    fn two_hops_is_the_parent() {
        let _ = super::super::sub::f();
    }

    pub fn helper() -> u32 { 9 }

    struct Probe;

    impl Probe {
        fn twin() -> u32 { 11 }

        fn calls_its_own() -> u32 {
            Self::twin()
        }
    }

    mod deeper {
        #[test]
        fn fewer_hops_than_modules() {
            let _ = super::inner::probe();
        }

        #[test]
        fn a_scope_with_no_file() {
            let _ = super::helper();
        }
    }

    mod sibling {
        pub fn helper() -> u32 { 10 }
    }

    mod inner {
        pub fn probe() -> u32 { 6 }
    }
}
`);

    const graph = await buildCodeGraph(root);
    resolveCallSites(
      graph,
      graph.symbolsByFile,
      graph.outgoingCallsByFile,
      graph.rustBindingsByFile,
      graph.rustCrateRootByFile,
      graph.rustInlineScopedCalls,
      graph.rustInlineDeclaredSymbols,
    );
    // Keyed by the function the call is written in as well as by callee and
    // qualifier. `super::helper()` and `self::helper()` both reach resolution
    // as `helper@self` — the first because the rewrite consumed its one
    // `super`, the second because that is how it was written — so on the callee
    // and qualifier alone they would be one entry, and whichever came last
    // would silently stand for both. Two files also write `super::` calls of
    // their own, and the caller keeps those apart too.
    symbolsOf = (file) =>
      (graph.symbolsByFile.get(file) ?? [])
        .filter((s) => s.name !== "<module>")
        .map((s) => s.id);
    qualified = new Map();
    for (const file of ["src/a/b.rs", "src/a/c.rs", "src/a/d.rs"]) {
      for (const edge of graph.outgoingCallsByFile.get(file) ?? []) {
        if (!edge.calleeQualifier) continue;
        const caller = edge.callerId.split("::").pop()?.split("#")[0] ?? "";
        const key = `${caller}|${edge.calleeQualifier}::${edge.calleeName}`;
        expect(qualified.has(key), `two calls share the key ${key}`).toBe(false);
        qualified.set(key, edge);
      }
    }
  });

  /** The one qualified call `caller` writes as `qualifier::name`. */
  const edgeFor = (caller: string, qualifier: string, name: string): SymbolEdge => {
    const edge = qualified.get(`${caller}|${qualifier}::${name}`);
    expect(edge, `no call to ${qualifier}::${name} in ${caller}`).toBeDefined();
    return edge as SymbolEdge;
  };

  /** Its candidates, sorted. */
  const candidatesOf = (caller: string, qualifier: string, name: string): string[] =>
    edgeFor(caller, qualifier, name).calleeCandidates.slice().sort();

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads one `super` as the file the inline mod is written in", () => {
    // Read one module too high, this answers `src/a.rs::helper` — a file that
    // does declare a `helper`, so the wrong answer arrives as `unique`.
    const edge = edgeFor("one_hop_is_this_file", "self", "helper");
    expect(edge.confidence).toBe("local");
    expect(candidatesOf("one_hop_is_this_file", "self", "helper"))
      .toContain("src/a/b.rs::helper#5");
  });

  it("answers it with the file's top level and nothing an inline mod holds", () => {
    // The maintainer's case. First that the fixture is still the case: `b.rs`
    // has to declare three `helper`s for this to prove anything — `#5` at its
    // top level, `#34` in `tests`, `#59` in `tests::sibling` — and a fixture
    // that quietly lost one of them would leave the assertion below green and
    // empty.
    expect(symbolsOf("src/a/b.rs").filter((id) => id.includes("::helper#"))).toEqual([
      "src/a/b.rs::helper#5",
      "src/a/b.rs::helper#34",
      "src/a/b.rs::helper#59",
    ]);

    // From `tests`, `super::helper()` names the file's own module, and rustc
    // binds the top-level one: a crate of this shape compiles with that
    // assertion passing, and with the top-level `helper` removed it is E0425.
    //
    // So `#34` and `#59` are not a wider answer, they are calls Rust cannot
    // make from where this one is written. Handing them back put two symbols
    // in front of whoever walks the candidates for an impact analysis.
    expect(candidatesOf("one_hop_is_this_file", "self", "helper"))
      .toEqual(["src/a/b.rs::helper#5"]);
  });

  it("refuses a `self::` path written inside an inline mod", () => {
    // `self` is the module the path is written in, so here it is `tests`, and
    // rustc binds `tests::helper` — not the file's. `tests` has no file and no
    // spelling resolution can follow, which is the refusal already in place
    // for a `super::` path rooted the same way.
    //
    // Without it this path would be read as the file's own module and answered
    // with the top-level `#5`, which is the one `helper` Rust does *not* mean
    // here: a wrong answer stated as `local`.
    const edge = edgeFor("self_is_the_inline_mod", "self", "helper");
    expect(edge.calleeQualifier).toBe("self");
    expect(edge.calleeCandidates).toEqual([]);
    expect(edge.confidence).toBe("unresolved");
  });

  it("refuses the call when the file's top level declares nothing of that name", () => {
    // `c.rs` declares `only_inside` inside `mod holder` and nowhere else, so
    // from `tests` there is nothing to reach: rustc answers E0425 for exactly
    // this shape. The edge keeps its qualifier and goes unresolved rather than
    // pointing at the one declaration in the file that Rust cannot call.
    const edge = edgeFor("nothing_at_the_file_top_level", "self", "only_inside");
    expect(edge.calleeQualifier).toBe("self");
    expect(edge.calleeCandidates).toEqual([]);
    expect(edge.confidence).toBe("unresolved");
  });

  it("still resolves the common shape, where no inline mod declares the name", () => {
    // The form this must not cost anything: `super::lone()` in `mod tests`, in
    // a file whose only `lone` is at its top level. It is 5 edges on tokio
    // 1.40.0 and 4 on the private tree, and all 9 are still answered.
    const edge = edgeFor("the_common_shape_still_resolves", "self", "lone");
    expect(edge.confidence).toBe("local");
    expect(edge.calleeCandidates).toEqual(["src/a/d.rs::lone#1"]);
  });

  it("leaves `Self::` alone: it is the implementing type, not a module", () => {
    // `Self::twin()` inside `#[cfg(test)] mod tests` names the type the `impl`
    // is for, which is right there in the inline mod. Reading `Self` as the
    // lowercase `self` would refuse it and drop a call the graph can answer —
    // and tokio writes this shape inside its test modules.
    const edge = edgeFor("calls_its_own", "Self", "twin");
    expect(edge.confidence).toBe("local");
    expect(edge.calleeCandidates).toEqual(["src/a/b.rs::twin#39"]);
  });

  it("reads two `super` as that file's parent", () => {
    // `src/sub.rs` also declares `f`, and is what one hop too many reaches.
    expect(candidatesOf("two_hops_is_the_parent", "super::sub", "f"))
      .toEqual(["src/a/sub.rs::f#1"]);
  });

  it("keeps what is left of the path relative to that file", () => {
    // `super::sub` inside the inline mod is `b.rs`'s own `sub` module.
    expect(candidatesOf("one_hop_then_a_module", "sub", "g")).toEqual(["src/a/b/sub.rs::g#1"]);
  });

  it("lets what is left reach a name the file imported", () => {
    // `super::aliased` is the file's own `use crate::sub as aliased;`. In Rust
    // a module's namespace holds the names its `use` declarations bring in, so
    // the leftover has to stay bare: read as `self::aliased` it would be
    // matched against the file's modules alone, and answer nothing.
    expect(candidatesOf("one_hop_then_an_imported_name", "aliased", "h"))
      .toEqual(["src/sub.rs::h#2"]);
  });

  it("leaves a path rooted in an inline mod unresolved, with its qualifier", () => {
    // Two inline modules deep and one `super`: the path is rooted in `tests`,
    // which has no file. Answering with `b.rs` would hand back every `helper`
    // the file holds — including `tests::sibling`'s, which Rust cannot reach
    // from `tests::deeper` — and whoever walks the candidates would follow it.
    const edge = edgeFor("a_scope_with_no_file", "super", "helper");
    expect(edge.calleeCandidates).toEqual([]);
    expect(edge.confidence).toBe("unresolved");
  });

  it("does not answer a rooted path with the file either", () => {
    // The same rule for a path that continues: `super::inner` is `tests`'s own
    // `inner`, and `b.rs` declares a `mod inner;` of its own — a different
    // file — so neither that file nor the caller's is an answer.
    const edge = edgeFor("fewer_hops_than_modules", "super::inner", "probe");
    expect(edge.calleeCandidates).toEqual([]);
    expect(edge.confidence).toBe("unresolved");
  });
});
