import { describe, expect, it } from 'vitest';

import { shouldRequireTrustConfirm } from '../trustGate';

describe('同意页的当场准入判据', () => {
  it('两个条件都成立时不必再勾', () => {
    expect(shouldRequireTrustConfirm({ providerEnabled: true, originAllowed: true })).toBe(false);
  });

  it('来源不在名单里要勾', () => {
    expect(shouldRequireTrustConfirm({ providerEnabled: true, originAllowed: false })).toBe(true);
  });

  it('来源在名单里但对外同步开关关着，同样要勾', () => {
    // 这一种是回归本体：界面原来只看 originAllowed，于是确认框不显示、
    // 按钮却可点，而服务端那道判据要求勾——点一次 409 一次，救不回来。
    expect(shouldRequireTrustConfirm({ providerEnabled: false, originAllowed: true })).toBe(true);
  });

  it('两个都不成立要勾', () => {
    expect(shouldRequireTrustConfirm({ providerEnabled: false, originAllowed: false })).toBe(true);
  });

  it('readiness 还没拉回来时不催人勾', () => {
    expect(shouldRequireTrustConfirm(null)).toBe(false);
    expect(shouldRequireTrustConfirm(undefined)).toBe(false);
  });
});

describe('界面判据与服务端判据接在一起', () => {
  it('同意页用的是共享判据，没有把条件内联回去', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../DataSyncAuthorizePage.tsx', import.meta.url), 'utf8');
    expect(source).toContain("import { shouldRequireTrustConfirm } from './trustGate'");
    expect(source).toContain('shouldRequireTrustConfirm(catalog?.readiness)');
    // 只看 originAllowed 的那种写法不许回来。
    expect(source).not.toMatch(/!catalog\.readiness\.originAllowed \? \(/);
    expect(source).not.toMatch(/!catalog\.readiness\.originAllowed && !trustOrigin/);
  });
});
