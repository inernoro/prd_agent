import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_TYPE_REGISTRY,
  getNotificationType,
  isEscalationNotification,
} from '../notificationTypeRegistry';

describe('notificationTypeRegistry', () => {
  describe('isEscalationNotification', () => {
    it('flags已下线的催办/超时提醒来源', () => {
      expect(isEscalationNotification({ source: 'defect-escalation', key: null, title: '' })).toBe(true);
      expect(isEscalationNotification({ source: 'defect-reminder', key: null, title: '' })).toBe(true);
      expect(isEscalationNotification({ source: 'pm-reminder', key: null, title: '' })).toBe(true);
    });

    it('flags按 key 前缀或标题命中的催办', () => {
      expect(isEscalationNotification({ source: 'defect-agent', key: 'defect-escalation:x', title: '' })).toBe(true);
      expect(isEscalationNotification({ source: 'defect-agent', key: null, title: '缺陷催办：DEF-1' })).toBe(true);
    });

    it('flags仅正文透出催办语义的残留（非成功语义，与后端口径对齐）', () => {
      expect(isEscalationNotification({ source: 'defect-agent', key: null, title: '缺陷进展', message: '请尽快跟进该缺陷', level: 'warning' })).toBe(true);
      expect(isEscalationNotification({ source: 'defect-agent', key: null, title: '缺陷进展', message: '该缺陷已超时仍未处理', level: 'info' })).toBe(true);
    });

    it('不误杀缺陷解决成功通知（正文含催办词也放行，防 false positive）', () => {
      // 报告人待验收的成功通知，处理说明恰好含「超时未处理」/「请尽快跟进」不得被隐藏
      expect(isEscalationNotification({ source: 'defect-agent', key: 'defect-resolved:x', title: '缺陷已解决，待你验收', message: '已修复超时未处理的问题', level: 'success' })).toBe(false);
      expect(isEscalationNotification({ source: 'defect-agent', key: 'defect-resolved:y', title: '缺陷已解决，待你验收', message: '请尽快跟进验收', level: 'success' })).toBe(false);
    });

    it('放行正常缺陷/系统通知', () => {
      expect(isEscalationNotification({ source: 'defect-agent', key: 'defect-resolved:x', title: '缺陷已解决，待你验收', message: '请前往验收', level: 'success' })).toBe(false);
      expect(isEscalationNotification({ source: 'report-agent', key: null, title: '本周周报已生成', message: '超时未提交', level: 'info' })).toBe(false);
    });
  });

  describe('getNotificationType', () => {
    it('按 source 命中对应类型', () => {
      expect(getNotificationType({ source: 'defect-agent', level: 'info', title: '' }).label).toBe('缺陷协作');
      expect(getNotificationType({ source: 'report-agent', level: 'info', title: '' }).label).toBe('周报月报');
      expect(getNotificationType({ source: 'system-alert', level: 'warning', title: '' }).popupStyle).toBe('alert');
      expect(getNotificationType({ source: 'stable-smoke', level: 'error', title: '' }).label).toBe('稳定冒烟');
    });

    it('缺陷解决(success)走庆祝气质', () => {
      const v = getNotificationType({ source: 'defect-agent', level: 'success', title: '缺陷已解决，待你验收' });
      expect(v.popupStyle).toBe('celebrate');
      expect(v.key).toBe('defect-agent');
    });

    it('未注册来源按 level 兜底', () => {
      expect(getNotificationType({ source: 'unknown-x', level: 'error', title: '' }).popupStyle).toBe('alert');
      expect(getNotificationType({ source: null, level: 'info', title: '' }).label).toBe('通知');
    });
  });
});

describe('accent 与 fg 必须成对', () => {
  /*
   * accent 是拼接用的 hex（`${accent}22` 当底、`${accent}55` 当描边，两个主题都成立），
   * fg 是当字色时走的双写 token。拆成两个字段之后，**凡是改 accent 的地方都必须同改 fg**，
   * 否则底变了色、字还继承着上一档的颜色。
   *
   * 我拆字段时就栽在这：warning/error 分支改对了，两个 success 分支只改 accent 没改 fg，
   * 于是「缺陷已解决」的通知底是绿的、字是紫的（Codex 在 PR #1374 第四轮抓到）。
   * 这条守卫扫源码：任何设了 accent 的对象字面量，必须同时设 fg。
   */
  it('任何设置 accent 的返回分支都必须同时设置 fg', () => {
    const src = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../notificationTypeRegistry.tsx'),
      'utf8',
    );
    // 逐个对象字面量看：出现 accent: 就必须在同一个字面量里出现 fg:
    const offenders: string[] = [];
    for (const m of src.matchAll(/\{[^{}]*\baccent:[^{}]*\}/g)) {
      if (!/\bfg:/.test(m[0])) offenders.push(m[0].replace(/\s+/g, ' ').slice(0, 110));
    }
    expect(
      offenders.length
        ? `这些分支改了 accent 却没给 fg，底色会与字色对不上：\n  ${offenders.join('\n  ')}`
        : '',
    ).toBe('');
  });

  it('每个 fg 都走双写 token，不许是写死的颜色', () => {
    for (const [key, cfg] of Object.entries(NOTIFICATION_TYPE_REGISTRY)) {
      expect(cfg.fg, `${key} 的 fg`).toMatch(/^var\(--accent-fg-[a-z-]+\)$|^var\(--text-[a-z-]+\)$/);
    }
  });
});
