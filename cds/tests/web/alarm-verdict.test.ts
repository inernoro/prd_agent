/*
 * 守卫：「出问题会不会有人被通知」这一句。
 *
 * 2026-09-15 面板上真的撒过一次谎：Bark 通道已经配好、演练通过、状态 healthy，
 * 而面板底部那一行照旧写着「出问题时不会有任何人被通知」——它只认识早先那条单一
 * MAP 通道，看不见新配的。一条**关于铃的谎**比没有这一行更糟：它会让人以为自己
 * 还没接，或者反过来以为接好了其实没有。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { judgeAlarm, type AlarmChannelStatus } from '../../web/src/lib/alarmVerdict.js';
import type { AlarmChannelView } from '../../web/src/lib/monitorCenter.js';

const ch = (over: Partial<AlarmChannelStatus> = {}): AlarmChannelStatus => ({
  id: 'c1', name: '我的手机', kind: 'bark', status: 'healthy',
  delivered: 3, failed: 0, enabled: true, ...over,
});
const legacyUnconfigured: AlarmChannelView = {
  status: 'unconfigured', channel: 'MAP 站内通知', delivered: 0, failed: 0,
  missing: ['CDS_MAP_NOTIFY_ENDPOINT'],
};

describe('通知判定', () => {
  // 这一条就是那次谎的判据。
  it('新通道通着时，不许因为旧的那条空着就说「不会有人被通知」', () => {
    const v = judgeAlarm(legacyUnconfigured, [ch()]);
    expect(v.text).not.toContain('不会有任何人被通知');
    expect(v.tone).toBe('ok');
    expect(v.live).toBe(1);
  });

  it('一条都没有才叫没有', () => {
    const v = judgeAlarm(legacyUnconfigured, []);
    expect(v.text).toContain('不会有任何人被通知');
    expect(v.tone).toBe('bad');
    expect(v.live).toBe(0);
  });

  it('配了但全停用 / 全没配齐，照样是没有', () => {
    expect(judgeAlarm(legacyUnconfigured, [ch({ enabled: false })]).live).toBe(0);
    expect(judgeAlarm(legacyUnconfigured, [ch({ status: 'unconfigured' })]).text).toContain('全都停用或没配齐');
  });

  // 两个来源都缺 = 不知道。不许说成「没配」——那是两件事，下一步也不同。
  it('服务端没下发任何通道信息时说「不知道」，不说「没配」', () => {
    const v = judgeAlarm(undefined, undefined);
    expect(v.tone).toBe('unknown');
    expect(v.text).toContain('说不准');
    expect(v.text).not.toContain('不会有任何人被通知');
  });

  it('唯一一条通道上次没送出去 → 红；一好一坏 → 黄，并说清仍有几条通着（Codex #1543 P2）', () => {
    expect(judgeAlarm(undefined, [ch({ status: 'failing' })]).tone).toBe('bad');
    const partial = judgeAlarm(undefined, [ch(), ch({ id: 'c2', name: '运维群', status: 'failing' })]);
    expect(partial.tone).toBe('warn');
    expect(partial.live).toBe(1);
    expect(partial.text).toContain('仍有 1 条通着');
    expect(partial.text).not.toContain('没人收到');
  });

  it('「通着」只数成功送出过的：唯一一条通道上次失败 → live 是 0，不是 1（Codex #1543 P2）', () => {
    const failed = judgeAlarm(undefined, [ch({ status: 'failing', delivered: 0, failed: 1 })]);
    expect(failed.live).toBe(0);
    expect(failed.tone).toBe('bad');
    const untested = judgeAlarm(undefined, [ch({ status: 'untested', delivered: 0 })]);
    expect(untested.live).toBe(0);
    // 一好一坏：通着的是 1 条
    const mixed = judgeAlarm(undefined, [ch(), ch({ id: 'c2', status: 'failing' })]);
    expect(mixed.live).toBe(1);
    // 旧 MAP 通道同一口径
    expect(judgeAlarm({ ...legacyUnconfigured, status: 'failing' }, []).live).toBe(0);
  });

  it('全都没演练过是黄的，不是绿的', () => {
    const v = judgeAlarm(undefined, [ch({ status: 'untested', delivered: 0 })]);
    expect(v.tone).toBe('warn');
    expect(v.text).toContain('还没真发过一次');
  });

  it('一部分没演练过时仍提醒，但不否认已经通的那些', () => {
    const v = judgeAlarm(undefined, [ch(), ch({ id: 'c2', status: 'untested', delivered: 0 })]);
    expect(v.tone).toBe('warn');
    expect(v.text).toContain('通着');
    expect(v.live).toBe(1);
    expect(v.text).toContain('1 条还没演练过');
  });

  it('旧的单通道自己通着也算数', () => {
    const v = judgeAlarm({ ...legacyUnconfigured, status: 'healthy', delivered: 2 }, []);
    expect(v.live).toBe(1);
    expect(v.tone).toBe('ok');
  });
});

describe('这一句只许有一份', () => {
  const src = readFileSync(fileURLToPath(new URL('../../web/src/pages/status/OwnerBoard.tsx', import.meta.url)), 'utf8');

  it('面板走 judgeAlarm，不自己再拼一遍', () => {
    expect(src).toMatch(/judgeAlarm\(alarm, alarmChannels\)/);
    // 自己拼的那一版有这句字面量；它必须只存在于 alarmVerdict 里。
    expect(src).not.toContain('的凭据没配齐');
  });

  it('多通道状态真的从摘要传进来了', () => {
    const page = readFileSync(fileURLToPath(new URL('../../web/src/pages/StatusPage.tsx', import.meta.url)), 'utf8');
    expect(page).toContain('alarmChannels={summary?.alarmChannels}');
  });
});
