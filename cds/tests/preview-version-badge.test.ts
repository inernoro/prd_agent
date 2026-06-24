import { describe, expect, it } from 'vitest';
import {
  buildPreviewVersionBadgeScript,
  modeLabelOf,
  shortBranchOf,
} from '../src/preview-version-badge.js';

/**
 * 预览版本标记（2026-06-24）。
 * 让混搭多版本预览时每个页面自报家门：左上角药丸 + 标签页标题前缀。
 * 这里只测纯函数（标签映射 / 分支尾巴 / 脚本片段内容与转义），注入逻辑在 proxy.ts。
 */
describe('modeLabelOf', () => {
  it('express / prebuilt / release → 极速', () => {
    expect(modeLabelOf('express')).toBe('极速');
    expect(modeLabelOf('prebuilt')).toBe('极速');
    expect(modeLabelOf('release')).toBe('极速');
    expect(modeLabelOf('EXPRESS')).toBe('极速');
  });
  it('static / dev / 其它 → 源码', () => {
    expect(modeLabelOf('static')).toBe('源码');
    expect(modeLabelOf('dev')).toBe('源码');
    expect(modeLabelOf('whatever')).toBe('源码');
  });
  it('空值 → 空串（不显示模式段）', () => {
    expect(modeLabelOf('')).toBe('');
    expect(modeLabelOf(null)).toBe('');
    expect(modeLabelOf(undefined)).toBe('');
  });
});

describe('shortBranchOf', () => {
  it('取最后一个 / 之后的尾巴', () => {
    expect(shortBranchOf('claude/youthful-gates-o6tnz5')).toBe('youthful-gates-o6t');
    expect(shortBranchOf('main')).toBe('main');
  });
  it('截断到 maxLen', () => {
    expect(shortBranchOf('feat/very-long-branch-name-exceeding', 10)).toBe('very-long-');
  });
  it('多级路径取最末段', () => {
    expect(shortBranchOf('cursor/fix/auth/login')).toBe('login');
  });
});

describe('buildPreviewVersionBadgeScript', () => {
  it('包含分支尾巴、sha7（截断）、模式标签', () => {
    const s = buildPreviewVersionBadgeScript({
      branchName: 'claude/youthful-gates-o6tnz5',
      sha: 'eeba7bf14a8c317c3717318bff35d95c8dd10845',
      mode: 'static',
    });
    expect(s).toContain('data-cds-version-badge');
    expect(s).toContain('youthful-gates-o6t'); // 尾巴
    expect(s).toContain('eeba7bf'); // sha 前 7 位
    expect(s).not.toContain('eeba7bf14a8c'); // 不含完整 sha
    expect(s).toContain('源码'); // static → 源码
  });

  it('express 模式标极速', () => {
    const s = buildPreviewVersionBadgeScript({ branchName: 'feat/x', sha: 'abc1234def', mode: 'express' });
    expect(s).toContain('极速');
  });

  it('幂等守卫 + 标题前缀逻辑存在', () => {
    const s = buildPreviewVersionBadgeScript({ branchName: 'main', sha: null, mode: null });
    expect(s).toContain('__cdsVersionBadge'); // 防重复注入
    expect(s).toContain('document.title'); // 标签页标题前缀
    expect(s).toContain("PREFIX='['+SHORT+'] '");
  });

  it('转义：分支名里的引号/尖括号被剥离，不破坏 <script>', () => {
    const s = buildPreviewVersionBadgeScript({
      branchName: 'evil/"</script><img src=x>',
      sha: null,
      mode: null,
    });
    expect(s).not.toContain('</script><img');
    expect(s).not.toContain('"</script>');
  });

  it('无 sha/无 mode 时仍可用（段缺省，不抛）', () => {
    const s = buildPreviewVersionBadgeScript({ branchName: 'main' });
    expect(s).toContain('data-cds-version-badge-root');
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThan(100);
  });
});
