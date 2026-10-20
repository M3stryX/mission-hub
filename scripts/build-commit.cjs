#!/usr/bin/env node
/**
 * Stamp the image with the commit it was built from.
 *
 * `docker build` never learns the git revision on its own: neither the Dockerfile
 * nor Dokploy has a variable carrying it, so `MISSION_HUB_COMMIT` stays empty and
 * `GET /health` reports `unknown` — the build cannot say what it is. This script
 * runs inside the builder stage, while `.git` is still in the build context, and
 * writes the revision to `commit.txt`; the runtime copies that file and
 * `readCommit()` uses it when no explicit build argument was passed.
 *
 * Precedence stays: explicit `--build-arg MISSION_HUB_COMMIT` > this file > unknown.
 * The file records what was actually checked out — it is never invented.
 *
 * Resolution order for the git directory:
 *   1. `.git` directory at the repo root (normal clone)
 *   2. `.git` file containing `gitdir: <path>` (worktree / submodule)
 *
 * Ref resolution: loose ref file first, then `packed-refs`, then a detached HEAD.
 * Any failure writes `unknown` — never a guess.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const UNKNOWN = 'unknown';
const OUT = path.resolve(__dirname, '..', 'commit.txt');

function gitDir() {
  const dotGit = path.resolve(__dirname, '..', '.git');
  let stat;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;
  // Worktree or submodule: `.git` is a file pointing at the real git dir.
  const pointer = fs.readFileSync(dotGit, 'utf8').trim();
  const match = /^gitdir:\s*(.+)$/.exec(pointer);
  return match ? path.resolve(path.dirname(dotGit), match[1]) : null;
}

/**
 * In a linked worktree the git dir holds HEAD but the refs live in the common
 * dir named by `commondir`. Both are searched, git dir first.
 */
function refDirs(dir) {
  const dirs = [dir];
  try {
    const common = fs.readFileSync(path.join(dir, 'commondir'), 'utf8').trim();
    if (common) dirs.push(path.resolve(dir, common));
  } catch {
    // A normal clone has no `commondir`.
  }
  return dirs;
}

function resolveRef(dirs, ref) {
  for (const dir of dirs) {
    try {
      return fs.readFileSync(path.join(dir, ref), 'utf8').trim();
    } catch {
      // Not a loose ref here — try packed-refs / the next dir.
    }
  }
  for (const dir of dirs) {
    try {
      const packed = fs.readFileSync(path.join(dir, 'packed-refs'), 'utf8');
      for (const line of packed.split('\n')) {
        if (line.startsWith('#') || line.trim() === '') continue;
        const [sha, name] = line.trim().split(/\s+/, 2);
        if (name === ref) return sha;
      }
    } catch {
      // No packed-refs here.
    }
  }
  return null;
}

function readCommit() {
  const dir = gitDir();
  if (!dir) return UNKNOWN;

  let head;
  try {
    head = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
  } catch {
    return UNKNOWN;
  }

  if (!head.startsWith('ref:')) {
    return /^[0-9a-f]{7,40}$/i.test(head) ? head : UNKNOWN;
  }

  const ref = head.slice(4).trim();
  const sha = resolveRef(refDirs(dir), ref);
  return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : UNKNOWN;
}

const commit = readCommit();
fs.writeFileSync(OUT, `${commit}\n`);
console.log(`build-commit: ${commit} -> ${OUT}`);
