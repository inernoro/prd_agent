import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ApiDownloadError } from '@/services/real/apiClient';
import {
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
    expect(readOfflineExportSummary(undefined)).toEqual({ missingCount: 0, missing: [] });
  });

  /** 头名是前后端契约：后端改了名、前端没跟，结论会静默变成「全装进去了」（形状 10）。 */
  it('头名与后端控制器一致', () => {
    expect(controllerSource).toContain(`MissingCountHeader = "${OFFLINE_EXPORT_MISSING_COUNT_HEADER}"`);
    expect(controllerSource).toContain(`MissingHeader = "${OFFLINE_EXPORT_MISSING_HEADER}"`);
  });
});

describe('下载结论', () => {
  it('全装进去了：说能断网打开', () => {
    const r = describeOfflineExportResult({ missingCount: 0, missing: [] });
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
    });
    expect(r.tone).toBe('warning');
    expect(r.text).toContain('3 处');
    expect(r.text).toContain('站点里找不到 2 处');
    expect(r.text).toContain('暂时读取失败 1 处');
    expect(r.text).toContain('img/a.png');
    expect(r.text, '读取失败是可恢复的，要给下一步').toContain('重新下载');
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
