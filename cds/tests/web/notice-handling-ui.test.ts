/**
 * 站内信处理状态在渲染侧的判定 + 面板渲染冒烟。
 *
 * 为什么值得单独一组：这几条错了都**不会报错**，只会静默把界面变成谎话——
 *   1. 旧记录（后端旧构建 / 历史账本没有 handling）若不归「待处理」，
 *      存量告警会整批从筛选里消失，最该被看见的反而不见；
 *   2. 认领人为空时若回退成调用通道桶名（'user' / 'ai'），所有人会看到同一个
 *      「责任人」——CDS 的账号身份只在 github 模式与 SSO 会话里存在，而标准部署
 *      （exec_cds.sh init）是 basic 共享口令，那里一个真实身份都拿不到。
 *
 * 渲染冒烟单独一条：源码扫描只能证明「调用写在那儿」，渲染才证明「东西真的出现在屏幕上」。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  NOTICE_STATUSES,
  NOTICE_STATUS_META,
  noticeHandlerText,
  noticeStatusOf,
  type NoticeHandling,
} from '@/lib/noticeStatus';
import { SiteNoticeInbox } from '@/components/SiteNoticeInbox';

function handling(overrides: Partial<NoticeHandling> = {}): NoticeHandling {
  return {
    status: 'working',
    updatedAt: new Date(1_700_000_000_000).toISOString(),
    actor: { channel: 'user', userId: null, userLabel: null, provider: null },
    ...overrides,
  };
}

describe('noticeStatusOf — 旧记录必须算「待处理」', () => {
  it('没有 handling（旧账本 / 后端旧构建）→ open', () => {
    expect(noticeStatusOf({})).toBe('open');
    expect(noticeStatusOf({ handling: null })).toBe('open');
  });

  it('非法状态 → open，不原样透传到界面', () => {
    expect(noticeStatusOf({ handling: { status: 'resolvedd' } })).toBe('open');
    expect(noticeStatusOf({ handling: { status: '' } })).toBe('open');
  });

  it('三档合法状态原样返回，且每档都有中文标签与双主题配色', () => {
    for (const status of NOTICE_STATUSES) {
      expect(noticeStatusOf({ handling: { status } })).toBe(status);
      expect(NOTICE_STATUS_META[status].label.length).toBeGreaterThan(0);
      // 颜色只能来自主题 token 或 dark: 分支，白天模式不许出现暗色字面量。
      expect(NOTICE_STATUS_META[status].badgeClass).toMatch(/hsl\(var\(--|dark:/);
    }
  });
});

describe('noticeHandlerText — 拿不到身份就明说，绝不显示假责任人', () => {
  it('有真实账号身份 → 显示这个人', () => {
    const text = noticeHandlerText(handling({
      actor: { channel: 'user', userId: 'usr_1', userLabel: '张三', provider: 'github' },
    }));
    expect(text).toContain('张三');
    expect(text).toContain('正在处理');
  });

  it('无身份部署 → 明说未记录责任人，且不把通道桶名当人名', () => {
    const text = noticeHandlerText(handling());
    expect(text).toContain('未记录责任人');
    // 'user' 只能作为「调用通道」出现，不能出现在人名位置（即「XX 正在处理」的 XX）。
    expect(text).not.toMatch(/^user /);
  });

  it('从未被处理过 → 不显示任何处理行', () => {
    expect(noticeHandlerText(undefined)).toBeNull();
    expect(noticeHandlerText(null)).toBeNull();
  });
});

describe('SiteNoticeInbox 渲染冒烟', () => {
  it('无挂载点时安全降级为空（useOverlayDock 拿不到 host）', () => {
    // 组件用 createPortal 挂到 #cds-information-center-host；SSR 下没有 document，
    // useOverlayDock 返回 null，组件必须 return 空而不是抛异常——否则整个 shell 白屏。
    expect(() => renderToStaticMarkup(createElement(SiteNoticeInbox))).not.toThrow();
  });
});
