// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCodeGraph } from "../../src/services/code-graph.js";
import { resolveCallSites } from "../../src/services/graph-symbol-resolution.js";

/**
 * What `crate::` reaches, through the real `buildCodeGraph` pass.
 *
 * The resolution tests hand `resolveCallSites` a crate map written by hand,
 * which cannot catch a break in the map itself: a boundary drawn from the
 * wrong manifest, or from the path instead of the manifest, passes those tests
 * and produces a graph where `crate::config::load()` names another crate's
 * `config.rs`. So the map gets built here the way a real build builds it.
 *
 * Both fixtures are layouts where a boundary compared as a *prefix* is wrong,
 * because one crate's directory contains another's: a package at the project
 * root beside a crate in `sub/`, and a crate nested inside another crate's
 * tree. `""` and `crates/alpha/` are prefixes of both sides.
 */
describe("Rust crate scope for `crate::`", () => {
  let root: string;

  const write = (rel: string, body: string): void => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };

  /** Resolve `callerRel`'s only qualified call and return its candidates. */
  async function candidatesOf(callerRel: string): Promise<string[]> {
    const graph = await buildCodeGraph(root);
    resolveCallSites(
      graph,
      graph.symbolsByFile,
      graph.outgoingCallsByFile,
      graph.rustBindingsByFile,
      graph.rustCrateRootByFile,
    );
    const edge = (graph.outgoingCallsByFile.get(callerRel) ?? []).find(
      (e) => e.calleeName === "load" && e.calleeQualifier === "crate::config",
    );
    expect(edge, `no qualified call to crate::config::load in ${callerRel}`).toBeDefined();
    return (edge?.calleeCandidates ?? []).slice().sort();
  }

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-rust-crate-"));

    // ── A package at the project root, with a crate beside it in `sub/` ──
    // The root package's boundary is the whole tree, so a prefix comparison
    // puts `sub/src/config.rs` inside it.
    write("Cargo.toml", '[package]\nname = "rootpkg"\nedition = "2021"\n\n[dependencies]\nsub = { path = "sub" }\n');
    write("src/lib.rs", `pub mod config;
use sub::config as subcfg;

pub fn go() -> u32 {
    let _ = subcfg::load();
    crate::config::load()
}
`);
    write("src/config.rs", "pub fn load() -> u32 { 1 }\n");
    write("sub/Cargo.toml", '[package]\nname = "sub"\nedition = "2021"\n');
    write("sub/src/lib.rs", "pub mod config;\n");
    write("sub/src/config.rs", "pub fn load() -> u32 { 2 }\n");

    // ── A crate nested inside another crate's directory ──────────────────
    write(
      "crates/alpha/Cargo.toml",
      '[package]\nname = "alpha"\nedition = "2021"\n\n[dependencies]\nbeta = { path = "inner/beta" }\n',
    );
    write("crates/alpha/src/lib.rs", `pub mod config;
use beta::config as bcfg;

pub fn go() -> u32 {
    let _ = bcfg::load();
    crate::config::load()
}
`);
    write("crates/alpha/src/config.rs", "pub fn load() -> u32 { 3 }\n");
    write("crates/alpha/inner/beta/Cargo.toml", '[package]\nname = "beta"\nedition = "2021"\n');
    write("crates/alpha/inner/beta/src/lib.rs", "pub mod config;\n");
    write("crates/alpha/inner/beta/src/config.rs", "pub fn load() -> u32 { 4 }\n");
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps a root package's `crate::` out of a crate beside it", async () => {
    expect(await candidatesOf("src/lib.rs")).toEqual(["src/config.rs::load#1"]);
  });

  it("keeps a crate's `crate::` out of a crate nested inside its own directory", async () => {
    expect(await candidatesOf("crates/alpha/src/lib.rs")).toEqual([
      "crates/alpha/src/config.rs::load#1",
    ]);
  });
});
