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

  /** Resolve one qualified call written in `callerRel` and return its candidates. */
  async function candidatesOf(
    callerRel: string,
    name = "load",
    qualifier = "crate::config",
  ): Promise<string[]> {
    const graph = await buildCodeGraph(root);
    resolveCallSites(
      graph,
      graph.symbolsByFile,
      graph.outgoingCallsByFile,
      graph.rustBindingsByFile,
      graph.rustCrateRootByFile,
      graph.rustInlineScopedCalls,
    );
    const edge = (graph.outgoingCallsByFile.get(callerRel) ?? []).find(
      (e) => e.calleeName === name && e.calleeQualifier === qualifier,
    );
    expect(edge, `no qualified call to ${qualifier}::${name} in ${callerRel}`).toBeDefined();
    return (edge?.calleeCandidates ?? []).slice().sort();
  }

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-rust-crate-"));

    // ── A package at the project root, with a crate beside it in `sub/` ──
    // The root package's boundary is the whole tree, so a prefix comparison
    // puts `sub/src/config.rs` inside it.
    write("Cargo.toml", '[package]\nname = "rootpkg"\nedition = "2021"\n\n[dependencies]\nsub = { path = "sub" }\n');
    write("src/lib.rs", `pub mod config;
pub mod deep;
use sub::config as subcfg;

pub fn helper() -> u32 { 7 }

pub fn go() -> u32 {
    let _ = subcfg::load();
    crate::config::load()
}
`);
    write("src/config.rs", "pub fn load() -> u32 { 1 }\n");
    // A nested module calling the crate root. `deep/inner.rs` never imports
    // `lib.rs` — the import runs the other way — so `crate::helper()` is only
    // reachable by starting the path where Rust starts it.
    write("src/deep/mod.rs", "pub mod inner;\n");
    write("src/deep/inner.rs", `use crate as root;

pub fn go() -> u32 { crate::helper() }

pub fn go_aliased() -> u32 { root::helper() }
`);
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
    // ── One directory holding a library and a binary, which is two crates ──
    // `crate::` in `main.rs` is the binary's own root, and answering with the
    // library is a different file. Cargo gives `src/bin/x.rs` a crate too.
    write("tool/Cargo.toml", '[package]\nname = "tool"\nedition = "2021"\n');
    write("tool/src/lib.rs", "pub mod shared;\n\npub fn helper() -> u32 { 10 }\n");
    write("tool/src/shared.rs", "pub fn f() -> u32 { 11 }\n");
    write("tool/src/main.rs", `mod cli;

pub fn helper() -> u32 { 12 }

fn main() {
    let _ = crate::helper();
    let _ = cli::run();
}
`);
    write("tool/src/cli.rs", "pub fn run() -> u32 { crate::helper() }\n");
    write("tool/src/bin/x.rs", `pub fn helper() -> u32 { 13 }

fn main() {
    let _ = crate::helper();
}
`);

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

  it("reads `crate::` from the crate root, which a nested module never imports", async () => {
    expect(await candidatesOf("src/deep/inner.rs", "helper", "crate")).toEqual([
      "src/lib.rs::helper#5",
    ]);
  });

  it("reads an alias for the crate root the same way", async () => {
    // `use crate as root;` is the same path under another name, so it must
    // reach the same file — not the caller's own scope, which answers nothing.
    expect(await candidatesOf("src/deep/inner.rs", "helper", "root")).toEqual([
      "src/lib.rs::helper#5",
    ]);
  });

  it("reads `crate::` in a binary as the binary's own root", async () => {
    // `tool/src/lib.rs` declares a `helper` too, and is what taking the first
    // root module in the directory answers with — another file, as `unique`.
    expect(await candidatesOf("tool/src/main.rs", "helper", "crate")).toEqual([
      "tool/src/main.rs::helper#3",
    ]);
  });

  it("gives a `src/bin` file a crate root of its own", async () => {
    expect(await candidatesOf("tool/src/bin/x.rs", "helper", "crate")).toEqual([
      "tool/src/bin/x.rs::helper#1",
    ]);
  });

  it("follows the root that reaches the caller when a directory holds two", async () => {
    // `cli.rs` is declared by `main.rs` alone, so `crate::` there is the
    // binary — which the library's own `helper` must not answer.
    expect(await candidatesOf("tool/src/cli.rs", "helper", "crate")).toEqual([
      "tool/src/main.rs::helper#3",
    ]);
  });

  it("keeps a crate's `crate::` out of a crate nested inside its own directory", async () => {
    expect(await candidatesOf("crates/alpha/src/lib.rs")).toEqual([
      "crates/alpha/src/config.rs::load#1",
    ]);
  });
});
