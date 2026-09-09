import { describe, it, expect } from 'vitest';
import type { GitHubDirectoryNode } from '@/services/real/githubConnect';
import {
  buildDirectoryTree,
  defaultSelection,
  defaultExpanded,
  toggleSelection,
  setSelection,
  selectionSummary,
  filterDirectories,
  directoryLabel,
} from './githubDirectorySelection';

function dir(path: string, over: Partial<GitHubDirectoryNode> = {}): GitHubDirectoryNode {
  const name = path === '' ? '/' : path.slice(path.lastIndexOf('/') + 1);
  const parentPath = path === '' ? null : path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return {
    path,
    name,
    parentPath,
    depth: path === '' ? 0 : path.split('/').length,
    markdownCount: 0,
    fileCount: 0,
    recommended: false,
    ...over,
  };
}

describe('GitHub 同步向导 · 目录勾选', () => {
  it('默认选中后端算出的全部 doc/docs 目录（不是只勾根目录）', () => {
    const selected = defaultSelection({ recommendedPaths: ['doc', 'apps/web/docs', 'doc/guide'] });

    expect(selected.has('doc')).toBe(true);
    expect(selected.has('apps/web/docs')).toBe(true);
    expect(selected.has('doc/guide')).toBe(true);
    expect(selected.size).toBe(3);
  });

  it('没有推荐目录时默认一个都不勾', () => {
    expect(defaultSelection({ recommendedPaths: [] }).size).toBe(0);
  });

  it('扁平清单折成树，推荐目录排在同级最前', () => {
    const tree = buildDirectoryTree([
      dir(''),
      dir('src'),
      dir('doc', { recommended: true, markdownCount: 3 }),
      dir('doc/guide', { recommended: true, markdownCount: 2 }),
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0].path).toBe('');
    expect(tree[0].children.map((c) => c.path)).toEqual(['doc', 'src']);
    expect(tree[0].children[0].children.map((c) => c.path)).toEqual(['doc/guide']);
  });

  it('父目录被截断时孤儿节点挂到根上，不静默丢失', () => {
    const tree = buildDirectoryTree([
      dir(''),
      dir('a/b/c', { recommended: true }), // a、a/b 都不在清单里
    ]);

    expect(tree.map((n) => n.path).sort()).toEqual(['', 'a/b/c']);
  });

  it('勾选只影响自己，不级联子目录（同步本来就是单层的）', () => {
    let selected: ReadonlySet<string> = new Set(['doc']);
    selected = toggleSelection(selected, 'doc/guide');
    expect([...selected].sort()).toEqual(['doc', 'doc/guide']);

    selected = toggleSelection(selected, 'doc');
    expect([...selected]).toEqual(['doc/guide']);
  });

  it('全选 / 全不选只作用于传入的路径', () => {
    const selected = setSelection(new Set(['keep']), ['a', 'b'], true);
    expect([...selected].sort()).toEqual(['a', 'b', 'keep']);

    expect([...setSelection(selected, ['a', 'b'], false)]).toEqual(['keep']);
  });

  it('汇总给出目录数与预计同步的 Markdown 文件数', () => {
    const dirs = [
      dir('doc', { markdownCount: 12 }),
      dir('doc/guide', { markdownCount: 4 }),
      dir('src', { markdownCount: 1 }),
    ];

    expect(selectionSummary(dirs, new Set(['doc', 'doc/guide']))).toEqual({
      directoryCount: 2,
      markdownCount: 16,
    });
  });

  it('搜索保留命中目录的祖先，树不断链', () => {
    const dirs = [dir(''), dir('apps'), dir('apps/web'), dir('apps/web/docs'), dir('src')];

    const filtered = filterDirectories(dirs, 'docs').map((d) => d.path);
    expect(filtered).toContain('apps/web/docs');
    expect(filtered).toContain('apps/web');
    expect(filtered).toContain('apps');
    expect(filtered).not.toContain('src');
  });

  it('默认只展开通往已勾选目录的那几条链', () => {
    const dirs = [dir(''), dir('apps'), dir('apps/web'), dir('apps/web/docs'), dir('src'), dir('src/deep')];
    const expanded = defaultExpanded(dirs, new Set(['apps/web/docs']));

    // 通往 docs 的链要展开，才能让用户一眼看到默认勾了什么
    expect([...expanded].sort()).toEqual(['', 'apps', 'apps/web']);
    // 与勾选无关的分支保持折叠，几百个目录不会一次全摊开
    expect(expanded.has('src')).toBe(false);
  });

  it('一个都没勾时只展开根', () => {
    expect([...defaultExpanded([dir(''), dir('src')], new Set())]).toEqual(['']);
  });

  it('根目录显示成人话', () => {
    expect(directoryLabel(dir(''))).toBe('仓库根目录');
    expect(directoryLabel(dir('doc/guide'))).toBe('doc/guide');
  });
});
