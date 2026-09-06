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
    // The two `[[bin]]` entries are targets no convention would find: one
    // inside `src/bin/` with no `main.rs` beside it, one outside it entirely.
    // `cargo metadata` lists both (cargo 1.98), and nothing but the manifest
    // says so — which is why the resolver leaves them unresolved below.
    write(
      "tool/Cargo.toml",
      '[package]\nname = "tool"\nedition = "2021"\n\n[[bin]]\nname = "custom"\npath = "src/bin/custom/helper.rs"\n\n[[bin]]\nname = "launcher"\npath = "launcher/main.rs"\n',
    );
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

    // ── A multi-file binary: `src/bin/packer/main.rs` roots it, and every
    // file beside it is one of its modules, however deep. Checked with cargo
    // 1.98: `crate::helper()` in `packer/nested.rs` is the binary's `helper`,
    // and with that one removed the build fails with E0425 rather than falling
    // back to the library's.
    write("tool/src/bin/packer/main.rs", `mod nested;
mod sub;

pub fn helper() -> u32 { 14 }

fn main() {
    let _ = nested::go() + sub::deep::go();
}
`);
    write("tool/src/bin/packer/nested.rs", "pub fn go() -> u32 { crate::helper() }\n");
    write("tool/src/bin/packer/sub/mod.rs", "pub mod deep;\n");
    write("tool/src/bin/packer/sub/deep.rs", "pub fn go() -> u32 { crate::helper() }\n");

    // A `src/bin/` directory with no `main.rs`: a target only because the
    // manifest names the file, which is not readable from the resolver.
    write("tool/src/bin/custom/helper.rs", `mod thing;

pub fn helper() -> u32 { 21 }

fn main() {
    let _ = crate::helper();
    let _ = crate::thing::run();
}
`);
    write("tool/src/bin/custom/thing.rs", "pub fn run() -> u32 { 22 }\n");

    // ── Integration tests, benchmarks and examples: each a crate of its own,
    // and none of them reachable from the library, which never imports its
    // own tests.
    write("tool/tests/it.rs", `pub fn helper() -> u32 { 31 }

#[test]
fn t() {
    let _ = crate::helper();
}
`);
    write("tool/tests/dirtest/main.rs", `mod nested;

pub fn helper() -> u32 { 32 }

#[test]
fn t() {
    let _ = nested::go();
}
`);
    write("tool/tests/dirtest/nested.rs", "pub fn go() -> u32 { crate::helper() }\n");
    // The shared-helper idiom: `tests/common/` holds no `main.rs`, so it is no
    // target, and `crate::` in it means whichever test wrote `mod common;`.
    write("tool/tests/common/mod.rs", "pub fn shared() -> u32 { crate::helper() }\n");
    write("tool/benches/b.rs", `pub fn helper() -> u32 { 41 }

fn main() {
    let _ = crate::helper();
}
`);
    write("tool/examples/e.rs", `pub fn helper() -> u32 { 51 }

fn main() {
    let _ = crate::helper();
}
`);
    // A `[[bin]] path` outside every conventional directory. No root reaches
    // it, and it is named `main.rs`, which `mod x;` never resolves to.
    write("tool/launcher/main.rs", `pub fn helper() -> u32 { 61 }

fn main() {
    let _ = crate::helper();
}
`);

    // ── A crate whose root module sits where no convention looks ──────────
    // `[lib] path` is not read here, so nothing is known about this crate's
    // roots — which is the same absence of information as having no crate map
    // at all, and keeps `crate::` reading the caller's own scope rather than
    // turning into a verdict of "unresolved".
    write("odd/Cargo.toml", '[package]\nname = "odd"\nedition = "2021"\n\n[lib]\npath = "core/root.rs"\n');
    write("odd/core/root.rs", `pub mod config;

pub fn go() -> u32 { crate::config::load() }
`);
    write("odd/core/config.rs", "pub fn load() -> u32 { 91 }\n");

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

  it("reads `crate::` in a binary's nested module as that binary's `main.rs`", async () => {
    // `src/bin/packer/nested.rs` is a module of the `packer` binary, not a
    // crate root of its own. Three files declare `helper` here: the library,
    // the `src/main.rs` binary, and `packer/main.rs` — and only the last one
    // is what rustc reads.
    expect(await candidatesOf("tool/src/bin/packer/nested.rs", "helper", "crate")).toEqual([
      "tool/src/bin/packer/main.rs::helper#4",
    ]);
  });

  it("maps a file nested deeper under a binary to the same `main.rs`", async () => {
    // Cargo autodiscovers `src/bin/<name>/main.rs` and nothing below it, so
    // `packer/sub/deep.rs` belongs to `packer`, not to a `sub` of its own.
    expect(await candidatesOf("tool/src/bin/packer/sub/deep.rs", "helper", "crate")).toEqual([
      "tool/src/bin/packer/main.rs::helper#4",
    ]);
  });

  it("reads `crate::` in an integration test as the test's own root", async () => {
    // A library never imports its own tests, so no root reaches `tests/it.rs`
    // and every root used to be the answer — which collapses onto the library
    // as soon as the library alone declares the name.
    expect(await candidatesOf("tool/tests/it.rs", "helper", "crate")).toEqual([
      "tool/tests/it.rs::helper#1",
    ]);
  });

  it("reads `crate::` in a benchmark as the benchmark's own root", async () => {
    expect(await candidatesOf("tool/benches/b.rs", "helper", "crate")).toEqual([
      "tool/benches/b.rs::helper#1",
    ]);
  });

  it("reads `crate::` in an example as the example's own root", async () => {
    expect(await candidatesOf("tool/examples/e.rs", "helper", "crate")).toEqual([
      "tool/examples/e.rs::helper#1",
    ]);
  });

  it("reads a folder test's module as that test's `main.rs`", async () => {
    expect(await candidatesOf("tool/tests/dirtest/nested.rs", "helper", "crate")).toEqual([
      "tool/tests/dirtest/main.rs::helper#3",
    ]);
  });

  it("leaves a `src/bin` directory with no `main.rs` unresolved", async () => {
    // `[[bin]] path = "src/bin/custom/helper.rs"` is the only thing that makes
    // this file a target, and the manifest is not read here. The library and
    // the `src/main.rs` binary both declare `helper`, and neither is it.
    expect(await candidatesOf("tool/src/bin/custom/helper.rs", "helper", "crate")).toEqual([]);
  });

  it("does not read an unprovable target's `crate::` in its own scope", async () => {
    // `crate::thing::run()` would find `custom/thing.rs` through the caller's
    // own dependencies. Right answer, wrong reason: whether the crate root is
    // `helper.rs` is exactly what cannot be established here, so the honest
    // answer is none.
    expect(await candidatesOf("tool/src/bin/custom/helper.rs", "run", "crate::thing")).toEqual([]);
  });

  it("leaves a shared `tests/common/mod.rs` unresolved", async () => {
    // No `main.rs` beside it, so `tests/common/` is no target: this file is a
    // module of whichever integration tests write `mod common;`, and `crate::`
    // in it means a different root for each of them.
    expect(await candidatesOf("tool/tests/common/mod.rs", "helper", "crate")).toEqual([]);
  });

  it("leaves a `main.rs` no root reaches unresolved", async () => {
    // `launcher/main.rs` is a `[[bin]] path` target outside every conventional
    // directory. `mod x;` reads `x.rs` or `x/mod.rs` and never `x/main.rs`, so
    // this is no module of the library either — answering with every root
    // would name the library, which is a different crate.
    expect(await candidatesOf("tool/launcher/main.rs", "helper", "crate")).toEqual([]);
  });

  it("keeps reading `crate::` in its own scope when a crate shows no root", async () => {
    // Knowing nothing is not the same verdict as knowing the caller is out of
    // reach: the empty answer above leaves an edge unresolved, and this one
    // must not, or a crate laid out by `[lib] path` would lose every
    // `crate::` edge it has.
    expect(await candidatesOf("odd/core/root.rs")).toEqual(["odd/core/config.rs::load#1"]);
  });

  it("keeps a crate's `crate::` out of a crate nested inside its own directory", async () => {
    expect(await candidatesOf("crates/alpha/src/lib.rs")).toEqual([
      "crates/alpha/src/config.rs::load#1",
    ]);
  });
});
