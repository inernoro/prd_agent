import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseGitHubRepoFullName,
  replaceDirectoriesAtomically,
  validateWebDistCandidate,
  WEB_DIST_BUILD_COMMAND,
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
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

  it('前端产物换代后保留上一代目录', () => {
    const root = makeTmpRoot();
    const current = path.join(root, 'dist');
    const next = path.join(root, 'dist.next');
    const previous = path.join(root, 'dist.previous');
    writeMarker(current, 'old-web');
    writeMarker(next, 'new-web');

    replaceDirectoriesAtomically([
      { currentPath: current, nextPath: next, previousPath: previous },
    ]);

    expect(readMarker(current)).toBe('new-web');
    expect(readMarker(previous)).toBe('old-web');
  });

  it('已存在上一代时候选目录上线失败会恢复两代产物', () => {
    const root = makeTmpRoot();
    const current = path.join(root, 'dist');
    const next = path.join(root, 'dist.next');
    const previous = path.join(root, 'dist.previous');
    writeMarker(current, 'current-web');
    writeMarker(next, 'candidate-web');
    writeMarker(previous, 'previous-web');

    const originalRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (from === next && to === current) {
        throw new Error('simulated candidate activation failure');
      }
      return originalRename(from, to);
    });

    try {
      expect(() => replaceDirectoriesAtomically([
        { currentPath: current, nextPath: next, previousPath: previous },
      ])).toThrow('simulated candidate activation failure');
    } finally {
      renameSpy.mockRestore();
    }

    expect(readMarker(current)).toBe('current-web');
    expect(readMarker(previous)).toBe('previous-web');
    expect(readMarker(next)).toBe('candidate-web');
  });
});

describe('validateWebDistCandidate', () => {
  it('把 Vite 输出定向候选目录且不传入多余分隔符', () => {
    expect(WEB_DIST_BUILD_COMMAND).toBe('pnpm build --outDir dist.next --emptyOutDir');
    expect(WEB_DIST_BUILD_COMMAND).not.toContain('build -- --outDir');
  });

  it('验证 index.html 引用的本地 JS 和 CSS 入口', () => {
    const root = makeTmpRoot();
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'index.html'),
      '<link rel="stylesheet" href="/assets/main.css"><script type="module" src="/assets/main.js"></script>',
    );
    fs.writeFileSync(path.join(root, 'assets', 'main.css'), 'body { color: black; }');
    fs.writeFileSync(path.join(root, 'assets', 'main.js'), 'export const ready = true;');

    expect(validateWebDistCandidate(root)).toEqual({
      ok: true,
      entryFiles: ['assets/main.css', 'assets/main.js'],
    });
  });

  it('拒绝 index.html 引用缺失入口的候选产物', () => {
    const root = makeTmpRoot();
    fs.writeFileSync(
      path.join(root, 'index.html'),
      '<script type="module" src="/assets/missing.js"></script>',
    );

    expect(validateWebDistCandidate(root)).toEqual({
      ok: false,
      error: 'candidate entry is missing: assets/missing.js',
    });
  });
});
