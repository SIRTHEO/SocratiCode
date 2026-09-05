// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCodeGraph } from "../../src/services/code-graph.js";
import { resolveCallSites } from "../../src/services/graph-symbol-resolution.js";

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
  let candidates: Map<string, string[]>;

  const write = (rel: string, body: string): void => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-rust-inline-mod-"));

    write("Cargo.toml", '[package]\nname = "inlinemod"\nedition = "2021"\n');
    write("src/lib.rs", "pub mod a;\npub mod sub;\n");
    write("src/sub.rs", "pub fn f() -> u32 { 1 }\n");
    write("src/a.rs", `pub mod b;
pub mod sub;

pub fn helper() -> u32 { 2 }
`);
    write("src/a/sub.rs", "pub fn f() -> u32 { 3 }\n");
    write("src/a/b/sub.rs", "pub fn g() -> u32 { 5 }\n");
    write("src/a/b.rs", `pub mod sub;
use crate::sub as aliased;

pub fn helper() -> u32 { 4 }

pub fn use_the_alias() -> u32 { aliased::f() }

#[cfg(test)]
mod tests {
    #[test]
    fn one_hop_is_this_file() {
        let _ = super::helper();
    }

    #[test]
    fn one_hop_then_a_module() {
        let _ = super::sub::g();
    }

    #[test]
    fn two_hops_is_the_parent() {
        let _ = super::super::sub::f();
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
    );
    candidates = new Map();
    for (const edge of graph.outgoingCallsByFile.get("src/a/b.rs") ?? []) {
      if (edge.calleeQualifier) candidates.set(edge.calleeName, edge.calleeCandidates.slice().sort());
    }
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads one `super` as the file the inline mod is written in", () => {
    // Read one module too high, this answers `src/a.rs::helper` — a file that
    // does declare a `helper`, so the wrong answer arrives as `unique`.
    expect(candidates.get("helper")).toEqual(["src/a/b.rs::helper#4"]);
  });

  it("reads two `super` as that file's parent", () => {
    // `src/sub.rs` also declares `f`, and is what one hop too many reaches.
    expect(candidates.get("f")).toEqual(["src/a/sub.rs::f#1"]);
  });

  it("keeps what is left of the path relative to that file", () => {
    // `super::sub` inside the inline mod is `b.rs`'s own `sub` module. `b.rs`
    // also has `use crate::sub as aliased;`, so a leftover path read as a bare
    // one would be looked up among the file's bindings before its modules.
    expect(candidates.get("g")).toEqual(["src/a/b/sub.rs::g#1"]);
  });
});
