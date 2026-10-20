import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COMMIT_ENV_KEY,
  readCommit,
  readContractVersion,
  readProductVersion,
  UNKNOWN_COMMIT,
} from '../src/build-info.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const agentUsageDoc = readFileSync(
  new URL('../docs/AGENT_USAGE.md', import.meta.url),
  'utf8',
);

describe('readProductVersion', () => {
  it('reports the version declared in package.json', () => {
    expect(readProductVersion()).toBe(packageJson.version);
    expect(readProductVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('refuses a package.json that declares no version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mission-hub-build-info-'));
    try {
      const path = join(dir, 'package.json');
      writeFileSync(path, JSON.stringify({ name: 'mission-hub' }));

      expect(() => readProductVersion(pathToFileURL(path))).toThrow(
        /declares no version/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readContractVersion', () => {
  it('reports a contract revision read from the inventory', () => {
    expect(readContractVersion()).toMatch(/^v\d+\.\d+$/);
  });

  it('matches the Contract-Version line of docs/AGENT_USAGE.md', () => {
    const declared = /^Contract-Version:\s*(\S+)/m.exec(agentUsageDoc);

    expect(declared?.[1]).toBe(readContractVersion());
  });
});

describe('readCommit', () => {
  it('reports unknown when the build supplied no commit', () => {
    // Point at a stamp that cannot exist: a source checkout carries none, and a
    // developer may have a local `commit.txt` from running the stamp script.
    const absent = pathToFileURL(
      join(tmpdir(), `mission-hub-absent-${Date.now()}.txt`),
    );

    expect(readCommit({}, absent)).toBe(UNKNOWN_COMMIT);
    expect(readCommit({ [COMMIT_ENV_KEY]: '' }, absent)).toBe(UNKNOWN_COMMIT);
    expect(readCommit({ [COMMIT_ENV_KEY]: '   ' }, absent)).toBe(UNKNOWN_COMMIT);
  });

  it('reports the commit the build supplied, trimmed', () => {
    const sha = 'a'.repeat(40);

    expect(readCommit({ [COMMIT_ENV_KEY]: sha })).toBe(sha);
    expect(readCommit({ [COMMIT_ENV_KEY]: ` ${sha}\n` })).toBe(sha);
  });

  it('reads the process environment by default', () => {
    expect(readCommit()).toBe(readCommit(process.env));
  });

  it('falls back to the build stamp when the build passed no argument', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mission-hub-stamp-'));
    try {
      const stampPath = join(dir, 'commit.txt');
      const sha = 'b'.repeat(40);
      writeFileSync(stampPath, `${sha}\n`);

      expect(readCommit({}, pathToFileURL(stampPath))).toBe(sha);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers the explicit build argument over the stamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mission-hub-stamp-'));
    try {
      const stampPath = join(dir, 'commit.txt');
      const fromFile = 'c'.repeat(40);
      const fromBuild = 'd'.repeat(40);
      writeFileSync(stampPath, `${fromFile}\n`);

      expect(
        readCommit({ [COMMIT_ENV_KEY]: fromBuild }, pathToFileURL(stampPath)),
      ).toBe(fromBuild);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports unknown when the stamp is missing or carries no revision', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mission-hub-stamp-'));
    try {
      expect(
        readCommit({}, pathToFileURL(join(dir, 'absent.txt'))),
      ).toBe(UNKNOWN_COMMIT);

      const unknownStamp = join(dir, 'commit.txt');
      writeFileSync(unknownStamp, `${UNKNOWN_COMMIT}\n`);
      expect(readCommit({}, pathToFileURL(unknownStamp))).toBe(UNKNOWN_COMMIT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
