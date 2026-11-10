import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = ['src/hooks', 'src/components/admin', 'src/app/admin'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

/** Code lines only (imports excluded): whole-line and trailing `//` comments and block-comment lines dropped. */
function codeLines(src: string): string[] {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*|import\s|\}?\s*from\s)/.test(l))
    .map((l) => l.replace(/\s\/\/.*$/, ''));
}

function stringLiterals(line: string): string[] {
  return line.match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? [];
}

const files = ROOTS.flatMap(walk);

function offenders(test: (line: string, literals: string[]) => boolean): string[] {
  return files.flatMap((f) =>
    codeLines(readFileSync(f, 'utf8'))
      .filter((l) => test(l, stringLiterals(l)))
      .map((l) => `${f}: ${l.trim()}`),
  );
}

describe('copy canon', () => {
  it('scans a non-trivial set of files', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('has no "Failed to load/fetch" strings (use "Couldn’t load X. Please try again.")', () => {
    expect(offenders((_, lits) => lits.some((s) => /Failed to (load|fetch)/.test(s)))).toEqual([]);
  });

  it('never says "demo" in user-visible strings', () => {
    expect(offenders((_, lits) => lits.some((s) => /\bdemo\b/i.test(s)))).toEqual([]);
  });

  it('has no "Acme" placeholder', () => {
    expect(offenders((_, lits) => lits.some((s) => /Acme/.test(s)))).toEqual([]);
  });

  it('never feeds a raw exception message into UI error state', () => {
    expect(
      offenders((l) => /\bset\w*Error\([^)]*\b(e|err|error)\.message/.test(l)),
    ).toEqual([]);
  });
});
