import { describe, it, expect } from 'vitest';
import { computePreviewSlug, slugifyForPreview } from '../../src/services/preview-slug.js';

describe('slugifyForPreview', () => {
  it('lowercases the input', () => {
    expect(slugifyForPreview('FooBar')).toBe('foobar');
  });

  it('replaces non-[a-z0-9-] with hyphens', () => {
    expect(slugifyForPreview('foo_bar.baz')).toBe('foo-bar-baz');
    expect(slugifyForPreview('hello world')).toBe('hello-world');
  });

  it('collapses repeated hyphens', () => {
    expect(slugifyForPreview('foo___bar')).toBe('foo-bar');
    expect(slugifyForPreview('a----b')).toBe('a-b');
  });

  it('strips leading and trailing hyphens', () => {
    expect(slugifyForPreview('-foo-')).toBe('foo');
    expect(slugifyForPreview('___bar___')).toBe('bar');
  });

  it('handles empty / all-special input', () => {
    expect(slugifyForPreview('')).toBe('');
    expect(slugifyForPreview('___')).toBe('');
  });

  it('preserves digits and existing hyphens', () => {
    expect(slugifyForPreview('feat-123-x')).toBe('feat-123-x');
  });
});

describe('computePreviewSlug — v3 格式 (tail-prefix-project)', () => {
  it('split branch with single `/` puts tail first, prefix middle, project last', () => {
    expect(
      computePreviewSlug('claude/fix-refresh-error-handling-2Xayx', 'prd-agent'),
    ).toBe('fix-refresh-error-handling-2xayx-claude-prd-agent');
  });

  it('handles common AI agent prefixes', () => {
    expect(computePreviewSlug('claude/fix-foo', 'prd-agent')).toBe('fix-foo-claude-prd-agent');
    expect(computePreviewSlug('cursor/ui-tweak', 'prd-agent')).toBe('ui-tweak-cursor-prd-agent');
  });

  it('handles conventional git prefixes', () => {
    expect(computePreviewSlug('feat/login', 'demo')).toBe('login-feat-demo');
    expect(computePreviewSlug('fix/null-deref', 'demo')).toBe('null-deref-fix-demo');
    expect(computePreviewSlug('refactor/auth-module', 'demo')).toBe('auth-module-refactor-demo');
  });

  it('multi-level path: only first `/` becomes the prefix split', () => {
    // feat/auth/login → prefix=feat, tail=auth-login（剩余 / 走 slugify 变 -）
    expect(computePreviewSlug('feat/auth/login', 'prd-agent')).toBe('auth-login-feat-prd-agent');
    expect(computePreviewSlug('claude/agent/upgrade-x', 'prd-agent')).toBe(
      'agent-upgrade-x-claude-prd-agent',
    );
  });

  it('no prefix: omits the middle segment', () => {
    // main 没有 `/`，新格式是 `main-prd-agent`，不强行塞 default 占位
    expect(computePreviewSlug('main', 'prd-agent')).toBe('main-prd-agent');
    expect(computePreviewSlug('develop', 'demo')).toBe('develop-demo');
  });

  it('全部小写归一', () => {
    expect(computePreviewSlug('CLAUDE/Fix-Foo', 'PRD-Agent')).toBe('fix-foo-claude-prd-agent');
    expect(computePreviewSlug('Feature/UI-Refactor', 'My_Project')).toBe(
      'ui-refactor-feature-my-project',
    );
  });

  it('特殊字符全部走 slug 规则化', () => {
    // 下划线、点、空格全变 -
    expect(computePreviewSlug('feat/foo_bar.baz', 'my_proj')).toBe('foo-bar-baz-feat-my-proj');
    // 非 ASCII 字符全部丢弃
    expect(computePreviewSlug('feat/中文-test', 'demo')).toBe('test-feat-demo');
  });

  it('边界：分支名以 / 开头 → 视作无 prefix', () => {
    // /foo 没有有效 prefix，fallback 到 `tail-project`
    expect(computePreviewSlug('/foo', 'demo')).toBe('foo-demo');
  });

  it('边界：分支名以 / 结尾 → 视作仅有 prefix', () => {
    // foo/ 没有 tail，输出 `prefix-project`（虽然这种分支名实际不存在）
    expect(computePreviewSlug('foo/', 'demo')).toBe('foo-demo');
  });

  it('边界：空分支名 → 仅项目', () => {
    expect(computePreviewSlug('', 'demo')).toBe('demo');
  });

  it('一致性：同 (branch, projectSlug) 总是产出同一 slug', () => {
    const a = computePreviewSlug('claude/fix-refresh-error-handling-2Xayx', 'prd-agent');
    const b = computePreviewSlug('claude/fix-refresh-error-handling-2Xayx', 'prd-agent');
    expect(a).toBe(b);
  });

  it('唯一性：不同项目即便同分支名，slug 也不同', () => {
    const a = computePreviewSlug('claude/fix-foo', 'prd-agent');
    const b = computePreviewSlug('claude/fix-foo', 'my-fork');
    expect(a).not.toBe(b);
    expect(a).toBe('fix-foo-claude-prd-agent');
    expect(b).toBe('fix-foo-claude-my-fork');
  });
});
