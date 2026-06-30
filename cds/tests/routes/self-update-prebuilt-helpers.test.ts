import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseGitHubRepoFullName,
  replaceDirectoriesAtomically,
} from '../../src/routes/branches.js';

const tmpRoots: string[] = [];

function makeTmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-prebuilt-helpers-'));
  tmpRoots.push(dir);
  return dir;
}

function writeMarker(dir: string, value: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'marker.txt'), value);
}

function readMarker(dir: string): string {
  return fs.readFileSync(path.join(dir, 'marker.txt'), 'utf8');
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseGitHubRepoFullName', () => {
  it('解析常见 GitHub remote 和 owner/repo 输入', () => {
    expect(parseGitHubRepoFullName('inernoro/prd_agent')).toBe('inernoro/prd_agent');
    expect(parseGitHubRepoFullName('git@github.com:inernoro/prd_agent.git')).toBe('inernoro/prd_agent');
    expect(parseGitHubRepoFullName('https://github.com/inernoro/prd_agent.git')).toBe('inernoro/prd_agent');
    expect(parseGitHubRepoFullName('https://github.com/inernoro/prd_agent.git?x=1')).toBe('inernoro/prd_agent');
  });

  it('拒绝非 owner/repo 形态', () => {
    expect(parseGitHubRepoFullName('prd_agent')).toBeNull();
    expect(parseGitHubRepoFullName('inernoro/prd_agent/extra')).toBeNull();
    expect(parseGitHubRepoFullName('https://example.com/inernoro/prd_agent.git')).toBeNull();
    expect(parseGitHubRepoFullName('')).toBeNull();
    expect(parseGitHubRepoFullName(undefined)).toBeNull();
  });
});

describe('replaceDirectoriesAtomically', () => {
  it('同时替换两个目录并清理 staging', () => {
    const root = makeTmpRoot();
    const currentA = path.join(root, 'dist');
    const currentB = path.join(root, 'web-dist');
    const nextA = path.join(root, 'next-dist');
    const nextB = path.join(root, 'next-web-dist');
    writeMarker(currentA, 'old-a');
    writeMarker(currentB, 'old-b');
    writeMarker(nextA, 'new-a');
    writeMarker(nextB, 'new-b');

    replaceDirectoriesAtomically([
      { currentPath: currentA, nextPath: nextA },
      { currentPath: currentB, nextPath: nextB },
    ]);

    expect(readMarker(currentA)).toBe('new-a');
    expect(readMarker(currentB)).toBe('new-b');
    expect(fs.existsSync(nextA)).toBe(false);
    expect(fs.existsSync(nextB)).toBe(false);
  });

  it('第二个目录替换失败时回滚第一个目录', () => {
    const root = makeTmpRoot();
    const currentA = path.join(root, 'dist');
    const currentB = path.join(root, 'web-dist');
    const nextA = path.join(root, 'next-dist');
    const missingNextB = path.join(root, 'missing-web-dist');
    writeMarker(currentA, 'old-a');
    writeMarker(currentB, 'old-b');
    writeMarker(nextA, 'new-a');

    expect(() => replaceDirectoriesAtomically([
      { currentPath: currentA, nextPath: nextA },
      { currentPath: currentB, nextPath: missingNextB },
    ])).toThrow();

    expect(readMarker(currentA)).toBe('old-a');
    expect(readMarker(currentB)).toBe('old-b');
  });
});
