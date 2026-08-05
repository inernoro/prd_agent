import { describe, expect, it } from 'vitest';
import {
  normalizeWebEntryPath,
  parseWebEntryLabels,
  selectPrimaryWebEntry,
} from '../../src/services/web-entry.js';

describe('Web 入口契约', () => {
  it('页面路径可用，健康与就绪路径被拒绝', () => {
    expect(normalizeWebEntryPath('/knowledge?tab=all')).toBe('/knowledge?tab=all');
    expect(normalizeWebEntryPath('/healthz')).toBeNull();
    expect(normalizeWebEntryPath('/api/ready')).toBeNull();
    expect(normalizeWebEntryPath('https://example.com')).toBeNull();
  });

  it('入口名称由 compose 声明，路径默认根页面', () => {
    expect(parseWebEntryLabels({ 'cds.web-entry-name': '知识库' }))
      .toEqual({ name: '知识库', path: '/' });
  });

  it('根路由自动成为主入口，显式 primary 只用于消除歧义', () => {
    const profiles = [
      { id: 'admin', pathPrefixes: ['/'], webEntry: { name: '管理端', path: '/' } },
      { id: 'help', pathPrefixes: ['/help/'], webEntry: { name: '帮助中心', path: '/' } },
    ];
    expect(selectPrimaryWebEntry(profiles)?.id).toBe('admin');
    expect(selectPrimaryWebEntry([
      ...profiles,
      { id: 'open', pathPrefixes: ['/open/'], webEntry: { name: '开放平台', path: '/', primary: true } },
    ])?.id).toBe('open');
  });
});
