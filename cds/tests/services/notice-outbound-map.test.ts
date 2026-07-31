import { describe, expect, it, vi } from 'vitest';
import {
  buildMapNotificationBody,
  forwardNoticeToMap,
  mapNoticeLevel,
  noticeOutboundUrl,
  resolveNoticeOutboundConfig,
  type NoticeOutboundConfig,
} from '../../src/services/notice-outbound-map.js';
import type { CdsNoticeRecord } from '../../src/services/notice-ledger.js';

/**
 * 外发适配器用例。
 *
 * 这里逐字断言字段名与枚举值，因为 MAP 侧对这两处都是**静默失败**：
 *   - `dedupKey` 拼成 dedupeKey → BuildEventKey 返回 null，同一件事每次新建一条（刷屏）；
 *   - level 传 'danger'（MAP AllowedLevels 没有它）→ 被静默降成 info（告警级别不对）。
 * 两者都不报错、不 4xx，只能靠测试钉住。
 */

const notice: CdsNoticeRecord = {
  id: 'ntc_x',
  dedupeKey: 'release.failed:tgt-1',
  level: 'danger',
  title: '生产发布失败',
  body: '生产 / 官网 — 门禁未通过',
  source: 'release',
  href: '/release-center?project=p&target=tgt-1',
  actionLabel: '查看发布记录',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  occurrences: 1,
};

const config: NoticeOutboundConfig = {
  baseUrl: 'https://map.example.com',
  token: 'tok',
  source: 'system-alert',
};

describe('resolveNoticeOutboundConfig', () => {
  it('缺 BASE_URL 或缺 TOKEN 任一项都返回 null（逐个断言，不许只测全缺）', () => {
    expect(resolveNoticeOutboundConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveNoticeOutboundConfig({
      CDS_NOTICE_MAP_BASE_URL: 'https://map.example.com',
    } as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveNoticeOutboundConfig({
      CDS_NOTICE_MAP_TOKEN: 'tok',
    } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('两项齐全 → 解析成功，source 默认 system-alert 且可被覆盖', () => {
    const base = resolveNoticeOutboundConfig({
      CDS_NOTICE_MAP_BASE_URL: 'https://map.example.com/',
      CDS_NOTICE_MAP_TOKEN: 'tok',
    } as NodeJS.ProcessEnv);
    expect(base).toEqual({ baseUrl: 'https://map.example.com', token: 'tok', source: 'system-alert' });

    const overridden = resolveNoticeOutboundConfig({
      CDS_NOTICE_MAP_BASE_URL: 'https://map.example.com',
      CDS_NOTICE_MAP_TOKEN: 'tok',
      CDS_NOTICE_MAP_SOURCE: 'cds',
      CDS_NOTICE_MAP_TARGET_USER: 'u1',
    } as NodeJS.ProcessEnv);
    expect(overridden?.source).toBe('cds');
    expect(overridden?.targetUserId).toBe('u1');
  });

  it('专用通知配置缺失时复用已加密保存的 MAP 服务端接入，不要求重复配置', () => {
    const fallback = resolveNoticeOutboundConfig({} as NodeJS.ProcessEnv, {
      baseUrl: 'https://stored-map.example.com/',
      token: 'stored-token',
    });
    expect(fallback).toEqual({
      baseUrl: 'https://stored-map.example.com',
      token: 'stored-token',
      source: 'system-alert',
    });

    const dedicated = resolveNoticeOutboundConfig({
      CDS_NOTICE_MAP_BASE_URL: 'https://notice-map.example.com',
      CDS_NOTICE_MAP_TOKEN: 'notice-token',
    } as NodeJS.ProcessEnv, {
      baseUrl: 'https://stored-map.example.com',
      token: 'stored-token',
    });
    expect(dedicated?.baseUrl).toBe('https://notice-map.example.com');
    expect(dedicated?.token).toBe('notice-token');
  });

  it('逃生阀 CDS_NOTICE_OUTBOUND_ENABLED=0 一刀关停', () => {
    expect(resolveNoticeOutboundConfig({
      CDS_NOTICE_MAP_BASE_URL: 'https://map.example.com',
      CDS_NOTICE_MAP_TOKEN: 'tok',
      CDS_NOTICE_OUTBOUND_ENABLED: '0',
    } as NodeJS.ProcessEnv, {
      baseUrl: 'https://stored-map.example.com',
      token: 'stored-token',
    })).toBeNull();
  });
});

describe('buildMapNotificationBody — 三个静默坑', () => {
  it('字段名逐字是 dedupKey，不是 dedupeKey', () => {
    const body = buildMapNotificationBody(notice, config);
    expect(Object.keys(body)).toContain('dedupKey');
    expect(Object.keys(body)).not.toContain('dedupeKey');
    expect(body.dedupKey).toBe('release.failed:tgt-1');
  });

  it('danger 映射成 MAP 的 error（MAP 的 AllowedLevels 没有 danger）', () => {
    expect(mapNoticeLevel('danger')).toBe('error');
    expect(mapNoticeLevel('warning')).toBe('warning');
    expect(mapNoticeLevel('info')).toBe('info');
    expect(buildMapNotificationBody(notice, config).level).toBe('error');
  });

  it('source 走配置（默认 system-alert），URL 是 MAP 的事件端点', () => {
    expect(buildMapNotificationBody(notice, config).source).toBe('system-alert');
    expect(noticeOutboundUrl(config)).toBe('https://map.example.com/api/dashboard/notifications/events');
  });

  it('重复发生次数写进正文，让 MAP 侧也看得到「近期第 N 次」', () => {
    const body = buildMapNotificationBody({ ...notice, occurrences: 4 }, config);
    expect(String(body.message)).toContain('4');
  });
});

describe('forwardNoticeToMap', () => {
  it('MAP 返 400「不支持的通知来源」→ ok:false 且原文保留', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ success: false, error: { message: '不支持的通知来源：cds' } }),
    }));
    const result = await forwardNoticeToMap(notice, config, fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('400');
    expect(result.reason).toContain('不支持的通知来源');
  });

  it('fetch 抛异常 → ok:false 且含「无法连接」，绝不返回 ok:true', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const result = await forwardNoticeToMap(notice, config, fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('无法连接');
  });

  it('成功 → ok:true 且带回 MAP 的通知 id', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, data: { id: 'notif_1' } }),
    }));
    const result = await forwardNoticeToMap(notice, config, fetchImpl);
    expect(result).toEqual({ ok: true, reference: 'notif_1' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://map.example.com/api/dashboard/notifications/events',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
      }),
    );
  });

  it('HTTP 200 但信封 success:false → 仍判失败（别把业务拒绝当成功）', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: false, error: { message: '权限不足' } }),
    }));
    const result = await forwardNoticeToMap(notice, config, fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('权限不足');
  });
});
