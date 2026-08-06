import { describe, expect, it } from 'vitest';
import {
  mainDomainEntryPath,
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

  /*
   * 2026-08-06 review P2-1：非根路由的 profile 被选成主入口时，URL 曾一律拼成主域名根，
   * 点开落到承载 `/` 的另一个应用上。入口路径是「该服务自己的页面」，落到主域名必须
   * 带上它的挂载前缀。把下面任何一条改回 entryPath 原样返回，本组用例必须变红。
   */
  describe('主域名落地路径 = 挂载前缀 + 入口路径', () => {
    it('挂在根路径的服务原样返回', () => {
      expect(mainDomainEntryPath({ pathPrefixes: ['/'] }, '/')).toBe('/');
      expect(mainDomainEntryPath({ pathPrefixes: ['/'] }, '/reports')).toBe('/reports');
    });

    it('挂在非根前缀时，入口路径挂到前缀下', () => {
      expect(mainDomainEntryPath({ pathPrefixes: ['/open/'] }, '/')).toBe('/open/');
      expect(mainDomainEntryPath({ pathPrefixes: ['/open'] }, '/')).toBe('/open/');
      expect(mainDomainEntryPath({ pathPrefixes: ['/open/'] }, '/settings')).toBe('/open/settings');
    });

    it('作者已经把前缀写进入口路径时不重复拼', () => {
      expect(mainDomainEntryPath({ pathPrefixes: ['/open/'] }, '/open/settings')).toBe('/open/settings');
      expect(mainDomainEntryPath({ pathPrefixes: ['/open/'] }, '/open')).toBe('/open');
      expect(mainDomainEntryPath({ pathPrefixes: ['/open/'] }, '/open?tab=api')).toBe('/open?tab=api');
    });

    it('查询串跟着一起挂到前缀下', () => {
      expect(mainDomainEntryPath({ pathPrefixes: ['/open/'] }, '/keys?tab=api')).toBe('/open/keys?tab=api');
    });

    it('没有可用前缀时退回原路径，不瞎拼', () => {
      expect(mainDomainEntryPath({ pathPrefixes: [] }, '/x')).toBe('/x');
      expect(mainDomainEntryPath({}, '/x')).toBe('/x');
      expect(mainDomainEntryPath({ pathPrefixes: ['  '] }, '/x')).toBe('/x');
    });
  });

  it('只写 path / primary 而没有名称的，不算用户入口', () => {
    expect(parseWebEntryLabels({ 'cds.web-entry-path': '/x' })).toBeUndefined();
    expect(parseWebEntryLabels({ 'cds.web-entry-primary': 'true' })).toBeUndefined();
    expect(parseWebEntryLabels({})).toBeUndefined();
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
