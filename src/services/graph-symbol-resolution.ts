// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Cross-file call-site resolution. Given a file-import graph (from
 * `code-graph.ts`) and the per-file extracted symbols, populates each call
 * edge's `calleeCandidates` and `confidence`.
 *
 * Strategy (uniform across languages):
 *   1. Local — callee name matches a symbol in the caller's own file
 *   2. Imported — walk caller's file `dependencies` from the file graph;
 *      any dependency exposing a same-named symbol is a candidate
 *   3. Wildcard / re-export — barrel files re-export symbols transitively;
 *      we do one extra hop through dependency files
 *   4. Resolution: 0 → "unresolved", 1 → "unique", >1 → "multiple-candidates"
 *
 * No type inference. Method calls resolve by name only.
 */

import type { CodeGraph, SymbolEdge, SymbolNode } from "../types.js";
import type { RustUseBinding } from "./graph-symbols.js";

/** Normalize relative path components like `foo/../bar` -> `bar` */
function normalizePath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  const stack: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join("/");
}

const KNOWN_CODE_EXT =
  /\.(?:[jt]sx?|m[jt]s|c[jt]s|py|rb|php|go|rs|java|kt|scala|cs|swift|dart|c|cpp|h|hpp|ex|exs|vue|svelte|lua|sh)$/i;

function stripKnownExt(p: string): string {
  const lastSlash = p.lastIndexOf("/");
  const dir = lastSlash >= 0 ? p.slice(0, lastSlash + 1) : "";
  const fileName = lastSlash >= 0 ? p.slice(lastSlash + 1) : p;
  const stripped = fileName.replace(KNOWN_CODE_EXT, "");
  return dir + stripped;
}

/**
 * The dependencies whose own path ends with these module segments.
 *
 * A Rust module is a file, a directory's `mod.rs`, or a crate's `lib.rs` /
 * `main.rs`, so `a::b` can be `…/a/b.rs`, `…/a/b/mod.rs` or, when `b` is a
 * crate, `…/b/src/lib.rs`. All three are matched; anything else is not a module
 * path and the caller falls through to reading the qualifier as a type.
 *
 * Matched against the caller's resolved dependencies only. A path that names a
 * real module the caller never imports returns nothing, which is the answer
 * that keeps the qualifier narrowing.
 */
function matchModulePath(deps: string[], segments: string[]): string[] {
  if (segments.length === 0) return [];
  const wanted = segments.join("/");
  const hits: string[] = [];
  for (const dep of deps) {
    const noExt = stripKnownExt(dep);
    const tails = [noExt];
    const last = noExt.slice(noExt.lastIndexOf("/") + 1);
    if (last === "mod" || last === "lib" || last === "main") {
      tails.push(noExt.slice(0, noExt.lastIndexOf("/")));
    }
    for (const tail of tails) {
      if (tail === wanted || tail.endsWith(`/${wanted}`)) {
        hits.push(dep);
        break;
      }
    }
  }
  return hits;
}

/** Resolve an import's module specifier to a dependency file path */
function resolveDepFile(callerFile: string, sourceModule: string, deps: string[]): string | null {
  if (!sourceModule) return null;
  const callerDir = callerFile.includes("/") ? callerFile.slice(0, callerFile.lastIndexOf("/")) : "";
  const rawCombined = callerDir ? `${callerDir}/${sourceModule}` : sourceModule;
  const normalized = stripKnownExt(normalizePath(rawCombined.replace(/^\.\//, "")));
  const cleanSpec = stripKnownExt(sourceModule.replace(/^[./\\]+/, ""));

  // Pass 1: exact normalized match or normalized/index
  for (const dep of deps) {
    const depWithoutExt = stripKnownExt(dep);
    if (depWithoutExt === normalized || depWithoutExt === `${normalized}/index`) {
      return dep;
    }
  }

  // Pass 2: suffix match (only if uniquely matched among dependencies)
  const suffixMatches: string[] = [];
  for (const dep of deps) {
    const depWithoutExt = stripKnownExt(dep);
    if (
      depWithoutExt.endsWith(`/${cleanSpec}`) ||
      depWithoutExt.endsWith(`/${cleanSpec}/index`)
    ) {
      suffixMatches.push(dep);
    }
  }
  if (suffixMatches.length === 1) {
    return suffixMatches[0];
  }

  // Fallback: match by basename if unique among dependencies
  const baseSpec = cleanSpec.split("/").pop();
  if (baseSpec) {
    const matches = deps.filter((d) => {
      const depBase = stripKnownExt(d.split("/").pop() ?? "");
      return depBase === baseSpec || d.includes(`/${baseSpec}/index.`);
    });
    if (matches.length === 1) return matches[0];
  }

  return null;
}

/**
 * Resolve all call sites for every file in `symbolsByFile`. Mutates the
 * passed-in `outgoingCallsByFile` edges in place.
 */
export function resolveCallSites(
  fileGraph: CodeGraph,
  symbolsByFile: Map<string, SymbolNode[]>,
  outgoingCallsByFile: Map<string, SymbolEdge[]>,
  /**
   * Rust `use` bindings per file. Absent for every other language, and absent
   * when a caller does not have them — resolution then behaves exactly as it
   * did, which is what keeps a graph built before this readable.
   */
  rustBindingsByFile?: Map<string, RustUseBinding[]>,
  /**
   * Rust file → the directory prefix of the crate it belongs to, from the
   * manifests. Absent for every other language, and absent when a caller does
   * not have it — `crate::` then confines nothing, which is what it did before.
   */
  rustCrateRootByFile?: Map<string, string>,
): void {
  // Build a fast lookup: file → Map<symbolName, SymbolNode[]>
  const symbolIndexByFile = new Map<string, Map<string, SymbolNode[]>>();
  // symbol id → the file that declares it. Needed to turn "where is the type
  // `Foo` declared?" into a scope of files, without taking the file apart from
  // the id string.
  const fileOfSymbolId = new Map<string, string>();
  for (const [file, syms] of symbolsByFile.entries()) {
    const idx = new Map<string, SymbolNode[]>();
    for (const s of syms) {
      fileOfSymbolId.set(s.id, file);
      if (s.name === "<module>") continue;
      const existing = idx.get(s.name);
      if (existing) existing.push(s);
      else idx.set(s.name, [s]);

      if (s.exportedAs && s.exportedAs !== s.name) {
        const asExisting = idx.get(s.exportedAs);
        if (asExisting) asExisting.push(s);
        else idx.set(s.exportedAs, [s]);
      }
    }
    symbolIndexByFile.set(file, idx);
  }

  // Build file → dependency files (1-hop from the file-import graph)
  const depsByFile = new Map<string, string[]>();
  // And the reverse, which is the only way to reach what `super::` names: a
  // module's parent is the file that declares `mod x;`, so it is a dependent
  // of the module, never a dependency of it.
  const dependentsByFile = new Map<string, string[]>();
  for (const node of fileGraph.nodes) {
    depsByFile.set(node.relativePath, node.dependencies.slice());
    dependentsByFile.set(node.relativePath, node.dependents.slice());
  }

  /**
   * The file `super::` names from `file`, if this project has it.
   *
   * Computed from the caller's own path and then checked against the
   * dependents, in that order. Filtering the dependents by name instead — "any
   * dependent called `lib`" — accepts the crate root as the parent of every
   * file in the crate, because the crate root imports them all: `super::x()`
   * in `a/b/leaf.rs` would then reach `src/lib.rs`, which Rust does not allow
   * and the graph would state as `unique`.
   *
   * `a/b/leaf.rs` has parent `a/b/mod.rs`, or `a/b.rs` when the module is
   * written beside its directory. `a/b/mod.rs` is itself the module `a::b`, so
   * its parent is one level further up.
   */
  function parentModulesOf(file: string): string[] {
    const noExt = stripKnownExt(file);
    const stem = noExt.slice(noExt.lastIndexOf("/") + 1);
    let dir = file.slice(0, file.lastIndexOf("/"));
    // A module root stands for its own directory, so its parent is the
    // directory above.
    if (stem === "mod" || stem === "lib" || stem === "main") {
      if (!dir.includes("/")) return [];
      dir = dir.slice(0, dir.lastIndexOf("/"));
    }
    if (!dir) return [];
    const candidates = [`${dir}/mod.rs`, `${dir}.rs`, `${dir}/lib.rs`, `${dir}/main.rs`];
    const dependents = new Set(dependentsByFile.get(file) ?? []);
    return candidates.filter((c) => dependents.has(c));
  }

  /**
   * The scope a `super`-rooted path is read in, one hop per leading `super`:
   * the modules reached by climbing, and what they import. `null` when a hop
   * has no reachable parent, which leaves the edge unresolved rather than
   * falling back to the caller's own scope — the caller's scope is a different
   * namespace, and answering out of it is how `use super::config;` would land
   * on the caller's own `config` submodule.
   */
  function climbSuper(
    callerFile: string,
    path: string[],
  ): { homes: string[]; deps: string[]; rest: string[] } | null {
    let homes = [callerFile];
    let deps: string[] = [];
    let rest = path;
    while (rest[0] === "super") {
      const parents = new Set<string>();
      for (const home of homes) {
        for (const parent of parentModulesOf(home)) parents.add(parent);
      }
      if (parents.size === 0) return null;
      homes = [...parents];
      const reached = new Set<string>();
      for (const home of homes) {
        for (const dep of depsByFile.get(home) ?? []) reached.add(dep);
      }
      deps = [...reached];
      rest = rest.slice(1);
    }
    return { homes, deps, rest };
  }

  // Re-export traversal is on the hot path for every unresolved edge. Build
  // this once rather than rescanning every edge in a barrel on every lookup.
  const reexportsByFile = new Map<string, SymbolEdge[]>();
  for (const [file, edges] of outgoingCallsByFile.entries()) {
    const reexports = edges.filter((edge) => edge.kind === "reexport");
    if (reexports.length > 0) reexportsByFile.set(file, reexports);
  }

  /** Recursively find symbols matching `symbolName` in `targetFile` or its re-export chains */
  function findSymbolsInTarget(
    targetFile: string,
    symbolName: string,
    visited = new Set<string>(),
  ): string[] {
    const visitKey = `${targetFile}::${symbolName}`;
    if (visited.has(visitKey)) return [];
    visited.add(visitKey);

    const candidates: string[] = [];
    const targetIdx = symbolIndexByFile.get(targetFile);

    // 1. Direct definition in targetFile (exported bindings only)
    const directMatches = targetIdx?.get(symbolName);
    if (directMatches && directMatches.length > 0) {
      for (const s of directMatches) {
        if (s.isExported !== false) {
          if (symbolName === "default") {
            if (s.exportedAs === "default" || s.name === "default") {
              candidates.push(s.id);
            }
          } else {
            if (s.exportedAs === undefined || s.exportedAs === symbolName || s.name === symbolName) {
              candidates.push(s.id);
            }
          }
        }
      }
    }

    // If seeking default export and no exact name match, look for any symbol with exportedAs === "default"
    if (symbolName === "default" && candidates.length === 0) {
      const syms = symbolsByFile.get(targetFile) ?? [];
      for (const s of syms) {
        if (s.isExported !== false && (s.exportedAs === "default" || s.name === "default")) {
          candidates.push(s.id);
        }
      }
    }

    // 2. Follow re-export chains in targetFile
    const targetEdges = reexportsByFile.get(targetFile) ?? [];
    const targetDeps = depsByFile.get(targetFile) ?? [];

    for (const edge of targetEdges) {
      const edgeSourceDep = edge.sourceModule
        ? resolveDepFile(targetFile, edge.sourceModule, targetDeps)
        : null;

      // Named re-export: `export { X as Y } from './mod'` or `export { X } from './mod'`
      if (edge.localAlias === symbolName || (!edge.localAlias && edge.importedName === symbolName) || (!edge.localAlias && !edge.importedName && edge.calleeName === symbolName)) {
        const nextName = edge.importedName ?? edge.calleeName;
        if (edgeSourceDep) {
          const sub = findSymbolsInTarget(edgeSourceDep, nextName, visited);
          candidates.push(...sub);
        } else {
          // Local re-export within same file
          const localMatch = targetIdx?.get(nextName);
          if (localMatch) for (const s of localMatch) candidates.push(s.id);
        }
      }

      // Wildcard re-export: `export * from './mod'` (only when unaliased)
      if (!edge.localAlias && (edge.calleeName === "*" || edge.importedName === "*") && edgeSourceDep) {
        const sub = findSymbolsInTarget(edgeSourceDep, symbolName, visited);
        candidates.push(...sub);
      }
    }

    return candidates;
  }

  /**
   * The files a Rust qualifier names, or `null` when it names none that this
   * project can reach. `null` is not "resolve it some other way": the caller
   * leaves the edge unresolved, because widening a qualified call to a
   * repository-wide name match is how `Vec::new()` would land on all 191 `new`.
   *
   * The search never leaves the caller's own scope — its file, its resolved
   * dependencies, and the re-export chains those reach — so a qualifier can
   * only ever narrow.
   */
  function rustQualifierScope(
    callerFile: string,
    qualifier: string,
    deps: string[],
    bindings: RustUseBinding[],
  ): string[] | null {
    const segments = qualifier.split("::").map((s) => s.trim()).filter(Boolean);
    if (segments.length === 0) return null;

    // `<T as Tr>::go()` and anything else the grammar hands back with syntax in
    // it: not a path this can follow.
    if (qualifier.includes("<") || qualifier.includes(">")) return null;

    // `self::` and `Self::` name the caller itself. `super::` names its parent,
    // which the remaining segments are then matched against.
    //
    // `homes` and `scopeDeps` are the scope the rest of the path is read in:
    // ordinarily the caller's own file and its dependencies, but under `super::`
    // the parent module's, because `super::sibling::f()` names a module the
    // caller may never import.
    let rest = segments;
    let inOwnCrate = false;
    let homes = [callerFile];
    let scopeDeps = deps;
    if (segments[0] === "self" || segments[0] === "Self") {
      if (segments.length === 1) return [callerFile];
      rest = segments.slice(1);
    } else if (segments[0] === "super") {
      const climbed = climbSuper(callerFile, segments);
      if (!climbed) return null;
      homes = climbed.homes;
      scopeDeps = climbed.deps;
      rest = climbed.rest;
      if (rest.length === 0) return homes;
    } else if (segments[0] === "crate") {
      rest = segments.slice(1);
      if (rest.length === 0) return null;
      // Confined to the caller's own crate, which is what `crate::` means.
      inOwnCrate = true;
    } else {
      // An imported binding rewrites the head into the path it names, so
      // `use crate::a::Type as Alias` makes `Alias::method()` reach exactly
      // what `crate::a::Type::method()` reaches and nothing else.
      const binding = bindings.find((b) => b.local === segments[0]);
      if (binding) {
        const bound = binding.path.split("::").map((s) => s.trim()).filter(Boolean);
        if (bound[0] === "crate") inOwnCrate = true;
        if (bound[0] === "super") {
          // `use super::config;` binds the parent's `config`, so the bound path
          // is read where `super::config` is read. Stripping the hop and
          // matching `config` against the caller's own dependencies reaches the
          // caller's own child module of that name instead — a wrong answer
          // reported as `unique`.
          const climbed = climbSuper(callerFile, bound);
          if (!climbed) return null;
          homes = climbed.homes;
          scopeDeps = climbed.deps;
          rest = [...climbed.rest, ...segments.slice(1)];
          // `use super as up;` binds the parent itself, so `up::f()` is a call
          // into the parent — the same answer `super::f()` gets.
          if (rest.length === 0) return homes;
        } else {
          const head = bound[0] === "crate" || bound[0] === "self" ? bound.slice(1) : bound;
          rest = [...head, ...segments.slice(1)];
          if (rest.length === 0) return null;
        }
      }
    }
    if (rest.length === 0) return null;

    // Same crate, by identity rather than by prefix. A prefix is a superset:
    // `""` for a package at the project root also covers a crate in `sub/`,
    // and `crates/alpha/` covers one nested at `crates/alpha/inner/beta`. The
    // map already says which crate each file belongs to, so comparing that
    // answer costs nothing and gets nesting right.
    const mine = rustCrateRootByFile?.get(callerFile);
    const reachable = inOwnCrate && mine !== undefined
      ? scopeDeps.filter((d) => rustCrateRootByFile?.get(d) === mine)
      : scopeDeps;

    // A module path: the dependency whose own path ends with these segments.
    const byPath = matchModulePath(reachable, rest);
    if (byPath.length > 0) return byPath;

    // A type qualifier: the files, within reach, that declare that name. The
    // last segment is the type — `crate::a::Type::method()` qualifies `method`
    // with `crate::a::Type`.
    //
    // Anything before it is a module path and it is not decoration: it says
    // *which* `Type`. Looked up without it, an alias for `crate::a::Type` would
    // reach `b.rs`'s `Type` as well, which is the opposite of what an alias is
    // for. When that prefix names no reachable module the answer is nothing,
    // not everything — a qualifier narrows or it fails.
    const typeName = rest[rest.length - 1];
    const modulePrefix = rest.slice(0, -1);
    let searchIn: string[];
    if (modulePrefix.length > 0) {
      searchIn = matchModulePath(reachable, modulePrefix);
      if (searchIn.length === 0) return null;
    } else {
      searchIn = [...homes, ...reachable];
    }

    const declaring = new Set<string>();
    for (const file of searchIn) {
      for (const id of findSymbolsInTarget(file, typeName)) {
        const declaredIn = fileOfSymbolId.get(id);
        if (declaredIn) declaring.add(declaredIn);
      }
    }
    if (declaring.size > 0) return [...declaring];

    return null;
  }

  for (const [callerFile, edges] of outgoingCallsByFile.entries()) {
    const localIdx = symbolIndexByFile.get(callerFile);
    const deps = depsByFile.get(callerFile) ?? [];
    const bindings = rustBindingsByFile?.get(callerFile) ?? [];

    for (const edge of edges) {
      const candidates: string[] = [];

      // A qualified call is resolved by its qualifier or not at all.
      //
      // Gated on the caller being Rust, not merely on the field being present.
      // Everything below reads `::`, `crate`, `self` and `super` as Rust means
      // them, and `rawCallsToUnresolvedEdges` carries `calleeQualifier` for
      // every language — so the day another extractor fills it, this would
      // apply Rust's semantics to it silently.
      if (edge.calleeQualifier && callerFile.endsWith(".rs")) {
        const scope = rustQualifierScope(callerFile, edge.calleeQualifier, deps, bindings);
        if (scope) {
          for (const file of scope) candidates.push(...findSymbolsInTarget(file, edge.calleeName));
        }
        const uniq = Array.from(new Set(candidates));
        edge.calleeCandidates = uniq;
        if (uniq.length === 0) edge.confidence = "unresolved";
        // `self::helper()` lands in the caller's own file, which is what
        // `local` has always meant here — the qualifier changes how it was
        // found, not where it was found.
        else if (uniq.every((id) => fileOfSymbolId.get(id) === callerFile)) {
          edge.confidence = "local";
        } else if (uniq.length === 1) edge.confidence = "unique";
        else edge.confidence = "multiple-candidates";
        continue;
      }

      // 1. Local (unless edge explicitly specifies an external source module)
      if (!edge.sourceModule) {
        const local = localIdx?.get(edge.calleeName);
        if (local && local.length > 0) {
          for (const s of local) candidates.push(s.id);
          edge.calleeCandidates = candidates;
          edge.confidence = "local";
          continue;
        }
      }

      // 2. Module-targeted import / reference
      if (edge.sourceModule) {
        const targetDep = resolveDepFile(callerFile, edge.sourceModule, deps);
        const searchName = edge.importedName ?? edge.calleeName;
        if (targetDep) {
          const found = findSymbolsInTarget(targetDep, searchName);
          candidates.push(...found);
        }
      } else {
        // 3. Untargeted cross-file resolution (fallback for languages without explicit module specifiers)
        const searchName = edge.importedName ?? edge.calleeName;
        for (const dep of deps) {
          const found = findSymbolsInTarget(dep, searchName);
          candidates.push(...found);
        }
      }

      // De-duplicate
      const uniq = Array.from(new Set(candidates));
      edge.calleeCandidates = uniq;
      if (uniq.length === 0) edge.confidence = "unresolved";
      else if (uniq.length === 1) edge.confidence = "unique";
      else edge.confidence = "multiple-candidates";
    }
  }
}

/** Compute the percentage of unresolved edges (0..100). */
export function computeUnresolvedPct(
  outgoingCallsByFile: Map<string, SymbolEdge[]>,
): number {
  let total = 0;
  let unresolved = 0;
  for (const edges of outgoingCallsByFile.values()) {
    for (const e of edges) {
      total++;
      if (e.confidence === "unresolved") unresolved++;
    }
  }
  return total === 0 ? 0 : (unresolved / total) * 100;
}
