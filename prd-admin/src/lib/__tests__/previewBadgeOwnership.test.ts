import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = new URL('../../', import.meta.url);
const read = (relativePath: string) => readFileSync(new URL(relativePath, sourceRoot), 'utf8');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    return entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)
      ? [path]
      : [];
  });
}

describe('预览分支标识由 CDS 代理注入，不进入 MAP 应用', () => {
  it('应用入口不再挂载或导入内置分支标记', () => {
    expect(read('app/App.tsx')).not.toContain('BranchBadge');
    expect(existsSync(fileURLToPath(new URL('components/BranchBadge.tsx', sourceRoot)))).toBe(false);
  });

  it('业务源码不再消费构建分支名或创建旧分支浮层', () => {
    for (const path of sourceFiles(fileURLToPath(sourceRoot))) {
      expect(readFileSync(path, 'utf8'), path).not.toMatch(/__GIT_BRANCH__|VITE_GIT_BRANCH|bt-branch-badge/);
    }
  });

  it('移除专用分支注入，同时保留不可变构建版本追踪', () => {
    const config = read('../vite.config.ts');
    expect(config).not.toMatch(/__GIT_BRANCH__|VITE_GIT_BRANCH|rev-parse --abbrev-ref/);
    expect(config).toContain('VITE_BUILD_ID');
    expect(config).toContain('GITHUB_SHA');
  });
});
