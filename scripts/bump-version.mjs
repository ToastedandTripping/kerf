#!/usr/bin/env node
/**
 * scripts/bump-version.mjs
 *
 * Syncs the release version across every version-carrying file in one shot:
 *   - package.json
 *   - src-tauri/tauri.conf.json
 *   - src-tauri/Cargo.toml
 *   - src-tauri/Cargo.lock  (kerf package entry, patched directly)
 *   - package-lock.json     (refreshed via `npm install --package-lock-only`)
 *
 * This exists to kill the known version-drift problem: Cargo.lock and
 * package-lock.json have silently fallen behind the other three files
 * before (v0.8.21 shipped with both lockfiles stuck at 0.8.18 while
 * package.json/tauri.conf.json/Cargo.toml read 0.8.21). A CI step asserts
 * package.json / tauri.conf.json / Cargo.toml agree; this script is how you
 * fix all five in one command instead of hand-editing each one.
 *
 * Usage:
 *   node scripts/bump-version.mjs <version>
 *   node scripts/bump-version.mjs 0.8.24
 *
 * Idempotent — running it twice with the same version is a no-op on the
 * second run. Fails loudly (non-zero exit, clear message) on a missing or
 * malformed target file rather than silently skipping it.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function fail(msg) {
  console.error(`bump-version: ${msg}`);
  process.exit(1);
}

const newVersion = process.argv[2];
if (!newVersion) {
  fail("missing version argument. Usage: node scripts/bump-version.mjs <version>");
}
if (!VERSION_RE.test(newVersion)) {
  fail(`"${newVersion}" doesn't look like a semver version (expected e.g. 0.8.24)`);
}

function requireFile(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!existsSync(abs)) {
    fail(`required file missing: ${relPath}`);
  }
  return abs;
}

/** package.json / tauri.conf.json — JSON files with a top-level "version" key. */
function bumpJsonVersion(relPath) {
  const abs = requireFile(relPath);
  const raw = readFileSync(abs, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    fail(`${relPath} is not valid JSON: ${e.message}`);
    return;
  }
  if (typeof data.version !== "string") {
    fail(`${relPath} has no top-level "version" string field`);
  }
  data.version = newVersion;
  writeFileSync(abs, JSON.stringify(data, null, 2) + "\n");
  console.log(`  ${relPath} -> ${newVersion}`);
}

/** src-tauri/Cargo.toml — replace the version = "..." line inside [package]. */
function bumpCargoToml(relPath) {
  const abs = requireFile(relPath);
  const raw = readFileSync(abs, "utf8");
  const lines = raw.split("\n");

  let inPackageSection = false;
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      inPackageSection = sectionMatch[1] === "package";
      continue;
    }
    if (inPackageSection && /^version\s*=\s*"/.test(line)) {
      lines[i] = `version = "${newVersion}"`;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    fail(`${relPath}: could not find version = "..." inside [package]`);
  }
  writeFileSync(abs, lines.join("\n"));
  console.log(`  ${relPath} -> ${newVersion}`);
}

/** src-tauri/Cargo.lock — patch the kerf package's own version entry directly.
 *  (cargo would also rewrite this on the next `cargo check`/`build`, but we
 *  patch it up front so the lockfile is never left drifted, even briefly.) */
function bumpCargoLock(relPath) {
  const abs = requireFile(relPath);
  const raw = readFileSync(abs, "utf8");
  const marker = 'name = "kerf"\nversion = "';
  const idx = raw.indexOf(marker);
  if (idx === -1) {
    fail(`${relPath}: could not find the "kerf" package entry`);
  }
  const versionStart = idx + marker.length;
  const versionEnd = raw.indexOf('"', versionStart);
  if (versionEnd === -1) {
    fail(`${relPath}: malformed version entry for the "kerf" package`);
  }
  const patched = raw.slice(0, versionStart) + newVersion + raw.slice(versionEnd);
  writeFileSync(abs, patched);
  console.log(`  ${relPath} -> ${newVersion}`);
}

console.log(`Bumping Kerf version to ${newVersion}...`);

bumpJsonVersion("package.json");
bumpJsonVersion("src-tauri/tauri.conf.json");
bumpCargoToml("src-tauri/Cargo.toml");
bumpCargoLock("src-tauri/Cargo.lock");

console.log("Refreshing package-lock.json...");
try {
  execFileSync("npm", ["install", "--package-lock-only"], {
    cwd: ROOT,
    stdio: "inherit",
  });
} catch (e) {
  fail(`npm install --package-lock-only failed: ${e.message}`);
}

console.log(`Done. All version files now read ${newVersion}.`);
