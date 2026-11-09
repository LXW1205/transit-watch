// Shared GTFS-cache helper for the test suite.
//
// The feed zip is gitignored (data/), so any test that parses it must skip on a
// clean checkout. When it *is* present we copy it into a temp directory and bump
// its mtime, because loadModel() re-downloads a zip older than 24 h; a fresh copy
// keeps every test completely offline. Nothing in the repo's data/ is touched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const ZIP_FILE = 'gtfs_rapid_bus_mrtfeeder.zip';
export const ZIP_PATH = path.join(REPO_ROOT, 'data', ZIP_FILE);
export const HAS_GTFS = fs.existsSync(ZIP_PATH);

// Pass this to node:test's `skip` option: false means "run", a string is the reason.
export const SKIP_GTFS = HAS_GTFS
  ? false
  : `GTFS cache ${path.relative(REPO_ROOT, ZIP_PATH)} is absent (offline checkout)`;

/** Temp data dir holding a fresh-mtime copy of the cached feed. */
export function freshDataDir() {
  if (!HAS_GTFS) throw new Error('freshDataDir() called without a cached GTFS zip');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transit-watch-gtfs-'));
  const copy = path.join(dir, ZIP_FILE);
  fs.copyFileSync(ZIP_PATH, copy);
  const now = new Date();
  fs.utimesSync(copy, now, now);
  return dir;
}

export function removeDir(dir) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}
