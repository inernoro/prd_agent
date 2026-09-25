import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ApiDownloadError } from '@/services/real/apiClient';
import {
  OFFLINE_EXPORT_EXTERNAL_COUNT_HEADER,
  OFFLINE_EXPORT_EXTERNAL_HEADER,
  OFFLINE_EXPORT_MISSING_COUNT_HEADER,
  OFFLINE_EXPORT_MISSING_HEADER,
  describeOfflineExportFailure,
  describeOfflineExportResult,
  offlineExportProgressLabel,
  parseMissingHeader,
  readOfflineExportSummary,
} from './offlineExport';

const controllerSource = readFileSync(
  new URL('../../../../prd-api/src/PrdAgent.Api/Controllers/Api/HostedSiteExportController.cs', import.meta.url),
  'utf8',
);

describe('缺失资源响应头', () => {
  it('解析「原因:百分号编码路径」，中文路径能还原', () => {
    const header = `not-in-site:${encodeURIComponent('img/缺图.png')},read-failed:css%2Fa.css`;
    expect(parseMissingHeader(header)).toEqual([
      { reason: 'not-in-site', reference: 'img/缺图.png' },
      { reason: 'read-failed', reference: 'css/a.css' },
    ]);
  });

  it('认不出的原因、坏编码逐条丢弃，不拖垮整句', () => {
    expect(parseMissingHeader('weird:a.png,not-in-site:%E0%A4%A,outside-site-root:..%2Fx.css')).toEqual([
      { reason: 'outside-site-root', reference: '../x.css' },
    ]);
    expect(parseMissingHeader(null)).toEqual([]);
  });

  it('总数以计数头为准（明细头最多 20 条）', () => {
    const headers = new Headers({
      [OFFLINE_EXPORT_MISSING_COUNT_HEADER]: '35',
      [OFFLINE_EXPORT_MISSING_HEADER]: 'not-in-site:a.png',
    });
    expect(readOfflineExportSummary(headers).missingCount).toBe(35);
    expect(readOfflineExportSummary(undefined)).toEqual({ missingCount: 0, missing: [], externalCount: 0, externalHosts: [] });
  });

  /** 头名是前后端契约：后端改了名、前端没跟，结论会静默变成「全装进去了」（形状 10）。 */
  it('头名与后端控制器一致', () => {
    expect(controllerSource).toContain(`MissingCountHeader = "${OFFLINE_EXPORT_MISSING_COUNT_HEADER}"`);
    expect(controllerSource).toContain(`MissingHeader = "${OFFLINE_EXPORT_MISSING_HEADER}"`);
    expect(controllerSource).toContain(`ExternalCountHeader = "${OFFLINE_EXPORT_EXTERNAL_COUNT_HEADER}"`);
    expect(controllerSource).toContain(`ExternalHeader = "${OFFLINE_EXPORT_EXTERNAL_HEADER}"`);
  });

  /** 跨域部署时浏览器只把显式暴露的响应头交给脚本；少暴露一个，结论就静默变成「全装进去了」。 */
  it('结论头都在 CORS 暴露名单里', () => {
    const program = readFileSync(
      new URL('../../../../prd-api/src/PrdAgent.Api/Program.cs', import.meta.url),
      'utf8',
    );
    for (const header of [
      OFFLINE_EXPORT_MISSING_COUNT_HEADER,
      OFFLINE_EXPORT_MISSING_HEADER,
      OFFLINE_EXPORT_EXTERNAL_COUNT_HEADER,
      OFFLINE_EXPORT_EXTERNAL_HEADER,
    ]) {
      expect(program, `${header} 没有暴露给前端`).toContain(`"${header}"`);
    }
  });
});

describe('下载结论', () => {
  it('外部依赖头解析：总数以计数头为准，主机逐条解码', () => {
    const headers = new Headers({
      [OFFLINE_EXPORT_EXTERNAL_COUNT_HEADER]: '5',
      [OFFLINE_EXPORT_EXTERNAL_HEADER]: `cdn.example.com,${encodeURIComponent('字体.example.cn')}`,
    });
    const summary = readOfflineExportSummary(headers);
    expect(summary.externalCount).toBe(5);
    expect(summary.externalHosts).toEqual(['cdn.example.com', '字体.example.cn']);
  });

  it('全装进去了：说能断网打开', () => {
    const r = describeOfflineExportResult({ missingCount: 0, missing: [], externalCount: 0, externalHosts: [] });
    expect(r.tone).toBe('info');
    expect(r.text).toContain('断网');
  });

  it('有缺口：说清缺几处、为什么、会怎样，并举例', () => {
    const r = describeOfflineExportResult({
      missingCount: 3,
      missing: [
        { reason: 'not-in-site', reference: 'img/a.png' },
        { reason: 'not-in-site', reference: 'img/b.png' },
        { reason: 'read-failed', reference: 'font/x.woff2' },
      ],
      externalCount: 0,
      externalHosts: [],
    });
    expect(r.tone).toBe('warning');
    expect(r.text).toContain('3 处');
    expect(r.text).toContain('站点里找不到 2 处');
    expect(r.text).toContain('暂时读取失败 1 处');
    expect(r.text).toContain('img/a.png');
    expect(r.text, '读取失败是可恢复的，要给下一步').toContain('重新下载');
  });

  /** Codex P1：页面引用的 CDN 资源原样留在文件里，断网时加载不到——这时不许说「断网也能打开」。 */
  it('仍依赖外部网络时不宣称能断网打开，说清几处、哪些主机', () => {
    const r = describeOfflineExportResult({
      missingCount: 0,
      missing: [],
      externalCount: 4,
      externalHosts: ['cdn.example.com', 'fonts.example.org', 'img.example.net', 'x.example.io'],
    });
    expect(r.tone).toBe('warning');
    expect(r.text).not.toContain('断网也能打开');
    expect(r.text).toContain('仍有 4 处依赖外部网络（如 CDN）');
    expect(r.text).toContain('断网时这些部分可能无法显示');
    expect(r.text).toContain('cdn.example.com、fonts.example.org、img.example.net 等');
  });

  it('缺失与外部依赖同时存在时两件事都说', () => {
    const r = describeOfflineExportResult({
      missingCount: 1,
      missing: [{ reason: 'not-in-site', reference: 'a.png' }],
      externalCount: 1,
      externalHosts: [],
    });
    expect(r.text).toContain('1 处资源没能装进去');
    expect(r.text).toContain('仍有 1 处依赖外部网络');
  });
});

describe('失败文案', () => {
  /**
   * 覆盖守卫：后端每一种打包失败都要有自己的一句话。后端新增了失败码而前端没跟，
   * 用户只会看到一句「稍后再试」，而「超限」重试一万次也没用。
   */
  it('后端每个打包失败码都有专属文案', () => {
    const codes = [...controllerSource.matchAll(/=> "(OFFLINE_EXPORT_[A-Z_]+)"/g)].map((m) => m[1])
      .filter((code) => code !== 'OFFLINE_EXPORT_FAILED');
    expect(codes.length).toBeGreaterThanOrEqual(5);
    const generic = describeOfflineExportFailure(new ApiDownloadError('x', 'UNKNOWN_CODE', 500)).text;
    for (const code of codes) {
      const text = describeOfflineExportFailure(new ApiDownloadError('x', code, 400)).text;
      expect(text, `${code} 落到了通用兜底`).not.toBe(generic);
    }
  });

  it('分享门禁的几种拒绝都有专属文案（密码不对不能说成登录失效）', () => {
    for (const code of ['SHARE_PASSWORD_REQUIRED', 'SHARE_EXPIRED', 'VISIBILITY_DENIED', 'NOT_FOUND', 'RATE_LIMITED']) {
      const text = describeOfflineExportFailure(new ApiDownloadError('x', code, 403)).text;
      expect(text).not.toContain('稍后再试一次；一直不行请联系管理员');
    }
    expect(describeOfflineExportFailure(new ApiDownloadError('x', 'SHARE_PASSWORD_REQUIRED', 403)).text).toContain('密码');
  });

  it('超限要给替代路径，而不是只说不行', () => {
    const text = describeOfflineExportFailure(new ApiDownloadError('x', 'OFFLINE_EXPORT_TOO_LARGE', 413)).text;
    expect(text).toContain('20MB');
    expect(text).toContain('新窗口打开');
  });

  it('认不出的错误保留下载器给的原文作附注', () => {
    const out = describeOfflineExportFailure(new Error('网络连接异常，请检查网络后重试。'));
    expect(out.detail).toBe('网络连接异常，请检查网络后重试。');
    expect(describeOfflineExportFailure('???').detail).toBeUndefined();
  });
});

describe('打包进度文案', () => {
  it('2 秒后带上秒数持续变化，15 秒后解释为什么慢', () => {
    expect(offlineExportProgressLabel(0)).toBe('正在打包…');
    expect(offlineExportProgressLabel(3)).toContain('3 秒');
    expect(offlineExportProgressLabel(4)).not.toBe(offlineExportProgressLabel(3));
    expect(offlineExportProgressLabel(20)).toContain('图片较多');
  });
});

describe('工作台接线（形状 2：建了没人用）', () => {
  const stage = readFileSync(new URL('./workbench/SiteEditStage.tsx', import.meta.url), 'utf8');

  it('线上版操作区有「下载离线 HTML」，走站内导出端点与共用 hook', () => {
    expect(stage).toContain('downloadSiteOfflineHtml(site.id');
    expect(stage).toContain('useOfflineExport()');
    expect(stage).toContain("'下载离线 HTML'");
    // 打包中按钮换成会动的进度文字，而不是一个静止的「加载中」
    expect(stage).toContain('exportingOffline ? offlineExportLabel');
  });
});
