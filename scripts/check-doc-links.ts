import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Docs link check (D3 of the #302 plan): every relative Markdown link in the
// tracked *.md files must resolve to an existing file on disk. External
// (http/https/mailto) links and pure-anchor links are skipped — this is an
// existence check, not a link checker.

const root = resolve(process.cwd());

const files = execFileSync('git', ['ls-files', '-z', '*.md'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter((file) => file.endsWith('.md'));

// Inline links: [text](target), optional "title" suffix. Angle-bracket
// destinations and reference-style definitions are out of scope for this repo.
const linkPattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

const broken: string[] = [];
let checked = 0;

for (const file of files) {
  const content = readFileSync(join(root, file), 'utf8');
  for (const match of content.matchAll(linkPattern)) {
    const target = match[1];
    if (/^(https?:|mailto:)/.test(target)) continue;
    const pathPart = target.split('#')[0];
    if (!pathPart) continue; // pure in-page anchor
    checked += 1;
    const resolved = resolve(root, dirname(file), pathPart);
    if (!existsSync(resolved)) {
      broken.push(`${file} -> ${target}`);
    }
  }
}

if (broken.length > 0) {
  console.error(`Broken relative doc links (${broken.length}):`);
  for (const entry of broken) {
    console.error(`  ${entry}`);
  }
  process.exit(1);
}

console.log(`OK: ${files.length} markdown files, ${checked} relative links resolved.`);
