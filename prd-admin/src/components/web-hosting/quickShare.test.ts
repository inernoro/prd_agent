import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ShareLinkItem } from '@/services/real/webPages';
import {
  QUICK_SHARE_DEFAULTS,
  describeQuickShare,
  expiryLabel,
  isLiveShareLink,
  pickQuickShareLink,
  resolveVisibility,
} from './quickShare';

const NOW = new Date('2026-08-25T12:00:00Z').getTime();
const at = (days: number) => new Date(NOW + days * 86400000).toISOString();

const link = (over: Partial<ShareLinkItem> & { visibility?: ShareLinkItem['visibility'] } = {}): ShareLinkItem => ({
  id: 'l1',
  token: 'tok1',
  siteId: 's1',
  siteIds: ['s1'],
  shareType: 'single',
  accessLevel: 'public',
  viewCount: 0,
  createdBy: 'u1',
  createdAt: at(-1),
  isRevoked: false,
  visibility: 'logged-in',
  ...over,
});

describe('还打得开吗', () => {
  it('撤销的不算', () => {
    expect(isLiveShareLink(link({ isRevoked: true }), NOW)).toBe(false);
  });

  it('过期的不算，没到期的算', () => {
    expect(isLiveShareLink(link({ expiresAt: at(-1) }), NOW)).toBe(false);
    expect(isLiveShareLink(link({ expiresAt: at(1) }), NOW)).toBe(true);
  });

  it('没有过期时间 = 永久有效', () => {
    expect(isLiveShareLink(link({ expiresAt: undefined }), NOW)).toBe(true);
  });
});

describe('面板显示哪一条链接', () => {
  it('只认指向这一个站点的单站点链接', () => {
    const picked = pickQuickShareLink([link({ id: 'other', siteId: 's2', siteIds: ['s2'] }), link()], 's1', NOW);
    expect(picked?.id).toBe('l1');
  });

  // 合集链接指向一堆站点，在单站点面板里改它的可见性会波及其他站点——那不是用户在这个入口的意图
  it('合集链接不进这个面板，哪怕它包含本站点', () => {
    const collection = link({ id: 'c1', shareType: 'collection', siteId: undefined, siteIds: ['s1', 's2'] });
    expect(pickQuickShareLink([collection], 's1', NOW)).toBeNull();
  });

  it('没有有效链接时返回 null（面板走「生成一条」那一屏）', () => {
    expect(pickQuickShareLink([link({ isRevoked: true }), link({ id: 'l2', expiresAt: at(-3) })], 's1', NOW)).toBeNull();
  });

  it('多条有效时取最晚过期的那条', () => {
    const picked = pickQuickShareLink(
      [link({ id: 'soon', expiresAt: at(1) }), link({ id: 'later', expiresAt: at(30) })],
      's1',
      NOW,
    );
    expect(picked?.id).toBe('later');
  });

  // 两条永久链会让「最晚过期」比出 Infinity - Infinity = NaN，排序退化成实现相关的随机顺序
  it('永久链排在限期链前面，两条永久链之间按创建时间', () => {
    expect(pickQuickShareLink(
      [link({ id: 'dated', expiresAt: at(90) }), link({ id: 'forever', expiresAt: undefined })],
      's1', NOW,
    )?.id).toBe('forever');

    expect(pickQuickShareLink(
      [link({ id: 'old', expiresAt: undefined, createdAt: at(-9) }), link({ id: 'new', expiresAt: undefined, createdAt: at(-1) })],
      's1', NOW,
    )?.id).toBe('new');
  });
});

describe('有效期文案', () => {
  it('不足一天说「今天内过期」，不说「剩 0 天」', () => {
    expect(expiryLabel(at(0.5), NOW)).toBe('今天内过期');
  });

  it('没有过期时间说永不过期', () => {
    expect(expiryLabel(undefined, NOW)).toBe('永不过期');
  });

  it('已经过期就如实说，不装作还有效', () => {
    expect(expiryLabel(at(-1), NOW)).toBe('已过期');
  });

  it('正常档位给天数', () => {
    expect(expiryLabel(at(7), NOW)).toBe('7 天后过期');
  });
});

describe('状态一句话', () => {
  it('三档可见性各说各的，不含糊', () => {
    expect(describeQuickShare(link({ visibility: 'public', expiresAt: at(7) }), NOW)).toContain('未登录');
    expect(describeQuickShare(link({ visibility: 'logged-in', expiresAt: at(7) }), NOW)).toContain('登录');
    expect(describeQuickShare(link({ visibility: 'owner-only', expiresAt: at(7) }), NOW)).toContain('只有你自己');
  });

  it('有密码就说要输密码', () => {
    expect(describeQuickShare(link({ accessLevel: 'password' }), NOW)).toContain('密码');
    expect(describeQuickShare(link({ accessLevel: 'public' }), NOW)).not.toContain('密码');
  });
});

describe('一键生成的默认值', () => {
  /**
   * 这条是本次改造的核心契约，不是凑数：
   * 配置弹窗的默认是 owner-only（先建出来自己核一遍），而下拉是「点一下发给别人」——
   * 沿用 owner-only 就会发出一条别人打不开的链接，用户以为分享成功了，对方看到「无权限」。
   * 谁把这里改回 owner-only，这条必须红。
   */
  it('默认必须是别人能打开的档，不能是 owner-only', () => {
    expect(QUICK_SHARE_DEFAULTS.visibility).not.toBe('owner-only');
    expect(describeQuickShare(link({ visibility: QUICK_SHARE_DEFAULTS.visibility }), NOW)).not.toContain('只有你自己');
  });

  it('默认有有效期，不是永久裸链', () => {
    expect(QUICK_SHARE_DEFAULTS.expiresInDays).toBeGreaterThan(0);
  });
});

describe('前后端可见性档位一致', () => {
  // 前端面板给三个选项，后端 PATCH 的白名单只认三个值：任何一边多一个少一个，
  // 用户点了会拿到 400，而界面上那一档看起来是合法的。
  it('后端 PATCH 白名单与面板的三档对得上', () => {
    const service = fs.readFileSync(
      path.join(__dirname, '../../../../prd-api/src/PrdAgent.Infrastructure/Services/HostedSiteService.cs'),
      'utf8',
    );
    const at2 = service.indexOf('UpdateShareSettingsAsync');
    expect(at2, '后端方法改名了，守卫要同步').toBeGreaterThan(-1);
    const body = service.slice(at2, at2 + 900);
    for (const v of ['"public"', '"logged-in"', '"owner-only"']) {
      expect(body, `后端白名单缺 ${v}`).toContain(v);
    }
  });
});

describe('存量链接（没有 visibility 字段）', () => {
  /**
   * 后端读路径把 legacy 空值按 public 处理（否则功能上线那刻旧链接会被一起拒掉）。
   * 面板要是自己猜成 owner-only，就会告诉用户「只有你自己能打开」，而实际上谁都能打开——
   * 往「更安全」的方向猜，在这里是最危险的猜法。
   */
  it('按 public 显示，不按 owner-only 猜', () => {
    expect(resolveVisibility({ visibility: undefined })).toBe('public');
    expect(resolveVisibility({ visibility: '' })).toBe('public');
    expect(resolveVisibility({ visibility: null })).toBe('public');
    expect(describeQuickShare(link({ visibility: undefined }), NOW)).toContain('未登录');
  });

  it('认识的三档原样返回', () => {
    expect(resolveVisibility({ visibility: 'owner-only' })).toBe('owner-only');
    expect(resolveVisibility({ visibility: 'logged-in' })).toBe('logged-in');
    expect(resolveVisibility({ visibility: 'public' })).toBe('public');
  });
});
