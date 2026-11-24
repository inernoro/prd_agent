/**
 * preview-dispatch —— 「这次提交该给哪些预览地址」判据测试。
 *
 * 钉住三件事：
 *   1. 四种结论分得开（合并成「取不到地址」就把可诊断状态压没了）；
 *   2. 地址行格式：`[项目 · 入口] URL`，单入口收缩成 `[项目] URL`；
 *   3. 未波及的项目**仍然出现在结果里**并说明原因 —— 缺席要能声明，不能悄悄消失。
 */

import { describe, it, expect } from 'vitest';
import {
  formatEntryLabel,
  resolvePreviewDispatch,
  type PreviewProjectFacts,
} from '../../src/services/preview-dispatch.js';

const MAIN: PreviewProjectFacts = {
  projectId: 'p-main',
  projectSlug: 'main-proj',
  projectName: 'MAP',
  scope: ['prd-api/**', 'prd-admin/**'],
  branchId: 'main-proj-feature-x',
  entries: [{ name: '主应用入口', url: 'https://feature-x-main.example.org/' }],
};

const SELF: PreviewProjectFacts = {
  projectId: 'p-self',
  projectSlug: 'self-proj',
  projectName: 'CDS Self',
  scope: ['cds/**'],
  branchId: 'self-proj-feature-x',
  entries: [{ name: '主应用入口', url: 'https://feature-x-self.example.org/' }],
};

describe('formatEntryLabel', () => {
  it('单入口收缩成项目名', () => {
    expect(formatEntryLabel('CDS Self', '主应用入口', 1)).toBe('[CDS Self]');
  });

  it('多入口必须带入口名，否则同项目两行同名分不出该点哪个', () => {
    expect(formatEntryLabel('MAP', '网关控制台', 2)).toBe('[MAP · 网关控制台]');
  });
});

describe('resolvePreviewDispatch', () => {
  it('两个项目都被波及时，两行地址都给出来，没有主从之分', () => {
    const result = resolvePreviewDispatch('feature/x', [MAIN, SELF], ['prd-api/a.cs', 'cds/src/b.ts']);
    expect(result.lines).toEqual([
      '[MAP] https://feature-x-main.example.org/',
      '[CDS Self] https://feature-x-self.example.org/',
    ]);
    expect(result.projects.every((p) => p.status === 'affected-deployed')).toBe(true);
  });

  it('只改 cds/** 时：自托管项目给地址，主项目明说「与它无关」而不是消失', () => {
    const result = resolvePreviewDispatch('feature/x', [MAIN, SELF], ['cds/src/b.ts']);
    expect(result.lines).toEqual(['[CDS Self] https://feature-x-self.example.org/']);

    const main = result.projects.find((p) => p.projectId === 'p-main')!;
    expect(main.status).toBe('not-affected');
    expect(main.summary).toContain('与它无关');
    expect(main.entries).toEqual([]);
    // 未波及也要出现在结果里 —— 缺席要能声明
    expect(result.projects).toHaveLength(2);
  });

  it('波及但 CDS 上没有这条分支：affected-no-branch，不是「取不到地址」', () => {
    const noBranch: PreviewProjectFacts = { ...SELF, branchId: undefined, entries: [] };
    const result = resolvePreviewDispatch('feature/x', [noBranch], ['cds/src/b.ts']);
    expect(result.projects[0].status).toBe('affected-no-branch');
    expect(result.projects[0].summary).toContain("还没有分支 'feature/x'");
    expect(result.lines).toEqual([]);
  });

  it('波及、分支在、但还没有入口：affected-not-deployed', () => {
    const notDeployed: PreviewProjectFacts = { ...SELF, entries: [] };
    const result = resolvePreviewDispatch('feature/x', [notDeployed], ['cds/src/b.ts']);
    expect(result.projects[0].status).toBe('affected-not-deployed');
    expect(result.projects[0].summary).toContain('还没有已发布的用户入口');
  });

  it('多入口项目：每个入口一行，都带入口名', () => {
    const multi: PreviewProjectFacts = {
      ...MAIN,
      entries: [
        { name: '主应用入口', url: 'https://a.example.org/' },
        { name: '网关控制台', url: 'https://b.example.org/' },
      ],
    };
    const result = resolvePreviewDispatch('feature/x', [multi], ['prd-api/a.cs']);
    expect(result.lines).toEqual([
      '[MAP · 主应用入口] https://a.example.org/',
      '[MAP · 网关控制台] https://b.example.org/',
    ]);
  });

  it('未声明作用域的项目恒被视为波及（与 push 分发同一份判据）', () => {
    const unscoped: PreviewProjectFacts = { ...MAIN, scope: [] };
    const result = resolvePreviewDispatch('feature/x', [unscoped], ['whatever/else.txt']);
    expect(result.projects[0].status).toBe('affected-deployed');
    expect(result.projects[0].scopeReason).toContain('全通配');
  });
});
