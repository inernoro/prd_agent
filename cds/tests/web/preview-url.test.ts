import { describe, expect, it } from 'vitest';
import {
  cleanHost,
  hostWithPort,
  isLocalHost,
  multiPreviewUrl,
  resolvePreviewUrl,
  resolveWebEntryUrl,
  simplePreviewUrl,
} from '../../web/src/lib/previewUrl.js';

/**
 * 预览地址推导的 SSOT 用例。这套逻辑此前只写在 BranchListPage 里，
 * 发布中心要就地发布也得算同一个地址——抄第二份必然漂移，于是抽到 lib 并在此钉住。
 */
const ORIGIN = { protocol: 'https:', hostname: 'cds.example.test' };

describe('previewUrl · host 归一', () => {
  it('剥掉协议与路径，只留主机名', () => {
    expect(cleanHost('https://preview.example.test/x/y')).toBe('preview.example.test');
    expect(cleanHost('  preview.example.test  ')).toBe('preview.example.test');
    expect(cleanHost(undefined)).toBe('');
  });

  it('本机域名才补端口——线上域名走反代，补端口等于给一个打不开的地址', () => {
    expect(isLocalHost('localhost')).toBe(true);
    expect(isLocalHost('cds.localhost')).toBe(true);
    expect(isLocalHost('127.0.0.1')).toBe(true);
    expect(isLocalHost('preview.example.test')).toBe(false);
    expect(hostWithPort('localhost', 5500)).toBe('localhost:5500');
    expect(hostWithPort('preview.example.test', 5500)).toBe('preview.example.test');
    expect(hostWithPort('localhost:9000', 5500)).toBe('localhost:9000');
    expect(hostWithPort('localhost', undefined)).toBe('localhost');
  });
});

describe('previewUrl · 多分支子域模式', () => {
  it('用 previewSlug 拼子域', () => {
    expect(multiPreviewUrl(
      { id: 'br_1', previewSlug: 'feat-x' },
      { previewDomain: 'preview.example.test', workerPort: 5500 },
      ORIGIN,
    )).toBe('https://feat-x.preview.example.test');
  });

  it('没有 previewSlug 时回落到分支 id', () => {
    expect(multiPreviewUrl(
      { id: 'br_1' },
      { rootDomains: ['preview.example.test'] },
      ORIGIN,
    )).toBe('https://br_1.preview.example.test');
  });

  it('没有可用域名时返回空串，交给发布前检查给出「缺少预览地址」的标准结论', () => {
    expect(multiPreviewUrl({ id: 'br_1' }, {}, ORIGIN)).toBe('');
  });
});

describe('previewUrl · 单站模式', () => {
  it('配了主域名就用主域名', () => {
    expect(simplePreviewUrl({ mainDomain: 'app.example.test' }, ORIGIN)).toBe('https://app.example.test');
  });

  it('没配主域名时退到当前主机 + worker 端口', () => {
    expect(simplePreviewUrl({ workerPort: 6000 }, ORIGIN)).toBe('https://cds.example.test:6000');
  });
});

describe('previewUrl · 按模式挑一条', () => {
  const config = { previewDomain: 'preview.example.test', mainDomain: 'app.example.test' };

  it('simple 走单站，其余走子域', () => {
    expect(resolvePreviewUrl('simple', { id: 'br_1' }, config, ORIGIN)).toBe('https://app.example.test');
    expect(resolvePreviewUrl('multi', { id: 'br_1' }, config, ORIGIN)).toBe('https://br_1.preview.example.test');
    // 模式未知（老后端 / 拉取失败）时按子域推导，不因为缺一个字段就整个不给地址。
    expect(resolvePreviewUrl(undefined, { id: 'br_1' }, config, ORIGIN)).toBe('https://br_1.preview.example.test');
  });
});

describe('previewUrl · 用户 Web 入口', () => {
  it('simple 模式保留共享主域名，只应用 CDS 声明的页面路径', () => {
    expect(resolveWebEntryUrl(
      'simple',
      'https://app.example.test',
      { url: 'https://feature.preview.example.test/console/?tab=models' },
    )).toBe('https://app.example.test/console/?tab=models');
  });

  it('port 模式保留运行期端口，同时应用非根落点', () => {
    expect(resolveWebEntryUrl(
      'port',
      'http://localhost:61234',
      { url: 'https://feature.preview.example.test/open/' },
    )).toBe('http://localhost:61234/open/');
  });

  it('multi 模式和命名子域入口使用 CDS 下发的完整地址', () => {
    const named = { subdomain: 'help', url: 'https://feature-help.preview.example.test/guide' };
    expect(resolveWebEntryUrl('multi', 'https://feature.preview.example.test', named)).toBe(named.url);
    expect(resolveWebEntryUrl('simple', 'https://app.example.test', named)).toBe(named.url);
  });
});
