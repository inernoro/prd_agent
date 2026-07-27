/**
 * 快捷提 bug 的纯逻辑守卫：快捷键判定 + 环境采集 + payload 组装。
 *
 * cds/web 与 llmgw/web 是两个独立前端包，各自持有一份等价的 BugReportCore；
 * 本文件对**两份实现都跑同一组断言**，防止两端行为漂移（一个抢输入框、
 * 一个漏自动带入字段）。
 */

import { describe, expect, it } from 'vitest';

import * as cdsCore from '../../web/src/components/BugReportCore.js';
import * as llmgwCore from '../../../llmgw/web/src/components/BugReportCore.js';

const IMPLEMENTATIONS: Array<[string, typeof cdsCore]> = [
  ['cds/web', cdsCore],
  ['llmgw/web', llmgwCore as typeof cdsCore],
];

describe.each(IMPLEMENTATIONS)('BugReportCore (%s)', (_name, core) => {
  describe('shouldTriggerBugReportShortcut', () => {
    it('非输入区按 Ctrl+B 触发（Windows/Linux）', () => {
      expect(core.shouldTriggerBugReportShortcut({
        key: 'b',
        ctrlKey: true,
        target: { tagName: 'DIV' },
      })).toBe(true);
    });

    it('非输入区按 Command+B 触发（Mac）', () => {
      expect(core.shouldTriggerBugReportShortcut({
        key: 'b',
        metaKey: true,
        target: { tagName: 'BODY' },
      })).toBe(true);
    });

    it('大写 B（按住 Shift 或大写锁定）同样触发', () => {
      expect(core.shouldTriggerBugReportShortcut({
        key: 'B',
        ctrlKey: true,
        target: { tagName: 'MAIN' },
      })).toBe(true);
    });

    it('input 聚焦时不抢占', () => {
      expect(core.shouldTriggerBugReportShortcut({
        key: 'b',
        ctrlKey: true,
        target: { tagName: 'INPUT' },
      })).toBe(false);
    });

    it('textarea 聚焦时不抢占', () => {
      expect(core.shouldTriggerBugReportShortcut({
        key: 'b',
        metaKey: true,
        target: { tagName: 'TEXTAREA' },
      })).toBe(false);
    });

    it('contenteditable 聚焦时不抢占', () => {
      expect(core.shouldTriggerBugReportShortcut({
        key: 'b',
        ctrlKey: true,
        target: { tagName: 'DIV', isContentEditable: true },
      })).toBe(false);
    });

    it('没有 Ctrl/Command 修饰键不触发', () => {
      expect(core.shouldTriggerBugReportShortcut({ key: 'b', target: { tagName: 'DIV' } })).toBe(false);
    });

    it('带 Alt 的组合不触发（避免抢占输入法/浏览器组合键）', () => {
      expect(core.shouldTriggerBugReportShortcut({
        key: 'b',
        ctrlKey: true,
        altKey: true,
        target: { tagName: 'DIV' },
      })).toBe(false);
    });

    it('长按重复事件不触发', () => {
      expect(core.shouldTriggerBugReportShortcut({
        key: 'b',
        ctrlKey: true,
        repeat: true,
        target: { tagName: 'DIV' },
      })).toBe(false);
    });

    it('其它字母不触发', () => {
      expect(core.shouldTriggerBugReportShortcut({
        key: 'k',
        ctrlKey: true,
        target: { tagName: 'DIV' },
      })).toBe(false);
    });
  });

  describe('shortcutHint', () => {
    it('Mac 提示 Command+B', () => {
      expect(core.shortcutHint('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('Command+B');
    });

    it('其它平台提示 Ctrl+B', () => {
      expect(core.shortcutHint('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Ctrl+B');
      expect(core.shortcutHint(undefined)).toBe('Ctrl+B');
    });
  });

  describe('collectBugReportEnvironment', () => {
    const fakeWindow = {
      location: { href: 'https://cds.example.com/branch-panel/abc?tab=logs#top', pathname: '/branch-panel/abc', search: '?tab=logs', hash: '#top' },
      document: { referrer: 'https://cds.example.com/project-list', documentElement: { getAttribute: (name: string) => (name === 'data-theme' ? 'light' : null) } },
      navigator: { userAgent: 'TestAgent/1.0', language: 'zh-CN' },
      innerWidth: 1440,
      innerHeight: 900,
      screen: { width: 2560, height: 1440 },
      devicePixelRatio: 2,
    };

    it('自动带入地址、路由、主题、视口、浏览器等字段', () => {
      const env = core.collectBugReportEnvironment(fakeWindow, new Date('2026-07-27T03:04:05.000Z'));
      expect(env.url).toBe('https://cds.example.com/branch-panel/abc?tab=logs#top');
      expect(env.route).toBe('/branch-panel/abc?tab=logs#top');
      expect(env.theme).toBe('light');
      expect(env.viewport).toBe('1440x900');
      expect(env.screen).toBe('2560x1440@2x');
      expect(env.userAgent).toBe('TestAgent/1.0');
      expect(env.language).toBe('zh-CN');
      expect(env.referrer).toBe('https://cds.example.com/project-list');
      expect(env.occurredAt).toBe('2026-07-27T03:04:05.000Z');
    });

    it('取不到来源时退化为 unknown，不抛异常', () => {
      const env = core.collectBugReportEnvironment(undefined, new Date('2026-07-27T00:00:00.000Z'));
      expect(env.url).toBe('unknown');
      expect(env.route).toBe('unknown');
      expect(env.theme).toBe('unknown');
      expect(env.viewport).toBe('unknown');
    });
  });

  describe('validateBugReportDraft', () => {
    it('描述为空时拒绝', () => {
      expect(core.validateBugReportDraft({ title: '', description: '   ', severity: 'major' })).toBe('请填写问题描述');
    });

    it('严重程度非法时拒绝', () => {
      expect(core.validateBugReportDraft({
        title: '',
        description: '页面白屏',
        severity: 'blocker' as unknown as cdsCore.BugSeverity,
      })).toBe('严重程度取值非法');
    });

    it('合法草稿通过', () => {
      expect(core.validateBugReportDraft({ title: '', description: '页面白屏', severity: 'major' })).toBeNull();
    });
  });

  describe('buildBugReportPayload', () => {
    const environment = core.collectBugReportEnvironment(
      {
        location: { href: 'https://gw.example.com/logs', pathname: '/logs' },
        document: { referrer: '', documentElement: { getAttribute: () => 'dark' } },
        navigator: { userAgent: 'TestAgent/2.0', language: 'zh-CN' },
        innerWidth: 390,
        innerHeight: 844,
        screen: { width: 390, height: 844 },
        devicePixelRatio: 3,
      },
      new Date('2026-07-27T08:00:00.000Z'),
    );

    it('未填标题时取描述首行，并把环境信息拼进正文', () => {
      const payload = core.buildBugReportPayload({
        source: 'llmgw',
        draft: {
          title: '',
          description: '请求记录页筛选后计数不对\n\n复现：选最近 1 小时再切模型',
          severity: 'minor',
        },
        environment,
      });
      expect(payload.source).toBe('llmgw');
      expect(payload.title).toBe('请求记录页筛选后计数不对');
      expect(payload.severity).toBe('minor');
      expect(payload.attachments).toEqual([]);
      expect(payload.environment.route).toBe('/logs');
      // 正文必须同时含用户描述与自动采集的环境附录（缺陷系统可直接展示）
      expect(payload.content).toContain('请求记录页筛选后计数不对');
      expect(payload.content).toContain('## 环境信息（自动采集）');
      expect(payload.content).toContain('页面地址：https://gw.example.com/logs');
      expect(payload.content).toContain('主题：dark');
      expect(payload.content).toContain('视口：390x844');
      expect(payload.content).toContain('浏览器：TestAgent/2.0');
      expect(payload.content).toContain('发生时间：2026-07-27T08:00:00.000Z');
    });

    it('显式标题优先于首行提取', () => {
      const payload = core.buildBugReportPayload({
        source: 'cds',
        draft: { title: '分支卡片错位', description: '首行描述', severity: 'major' },
        environment,
      });
      expect(payload.title).toBe('分支卡片错位');
    });

    it('超长首行截断到 100 字符加省略号', () => {
      const long = 'x'.repeat(160);
      const payload = core.buildBugReportPayload({
        source: 'cds',
        draft: { title: '', description: long, severity: 'trivial' },
        environment,
      });
      expect(payload.title).toBe(`${'x'.repeat(100)}...`);
    });

    it('附件会带进 payload 并在正文列出文件名', () => {
      const payload = core.buildBugReportPayload({
        source: 'cds',
        draft: {
          title: '',
          description: '截图见附件',
          severity: 'critical',
          attachments: [{ name: 'shot.png', mimeType: 'image/png', size: 1024, dataBase64: 'AAAA' }],
        },
        environment,
      });
      expect(payload.attachments).toHaveLength(1);
      expect(payload.attachments[0]?.dataBase64).toBe('AAAA');
      expect(payload.content).toContain('## 附件');
      expect(payload.content).toContain('shot.png');
    });
  });

  describe('describeSubmitResult', () => {
    it('转发成功时说进了缺陷系统', () => {
      expect(core.describeSubmitResult({ id: 'a', delivery: 'forwarded', reference: 'BUG-1024' }))
        .toBe('已提交到缺陷系统（BUG-1024）');
    });

    it('本地留存时如实说明未同步 + 原因，绝不假装成功', () => {
      const text = core.describeSubmitResult({
        id: 'a',
        delivery: 'local',
        degradeReason: '未配置缺陷系统转发',
      });
      expect(text).toContain('已记录到本地待办，未同步到缺陷系统');
      expect(text).toContain('未配置缺陷系统转发');
    });
  });
});
