import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NOTICE_MERGE_WINDOW_MS,
  NoticeLedgerService,
  mergeNotice,
  renderNoticeFromEvent,
  startNoticeLedger,
  type CdsNoticeRecord,
  type NoticeInput,
} from '../../src/services/notice-ledger.js';
import { cdsEventsBus } from '../../src/services/cds-events-bus.js';
import type { NoticeOutboundConfig } from '../../src/services/notice-outbound-map.js';

/**
 * 通知账本的行为用例。
 *
 * 事故值：CDS 至今没有任何服务端告警外发（doc/debt.cds.md「CDS 存活监控（uptime-monitor）」 债务 2-1），
 * 而「告警缺失」是最难被发现的缺陷——没人会注意到一个从没响过的铃。所以这里断言的
 * 三件事都刻意选了「错了也不会报错、只会静默走歪」的形状：
 *   1. 降噪窗口内不该重复外发（错了 = 刷屏，人学会忽略告警）；
 *   2. 未配置凭据时必须是 skipped 且理由非空、**绝不是 sent**（错了 = 假装通知过）；
 *   3. 外发挂掉时本地那条必须还在（错了 = MAP 不可达时连本地都丢）。
 */

const tempDirs: string[] = [];

function tempStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-notice-'));
  tempDirs.push(dir);
  return path.join(dir, 'notice-ledger.json');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function input(overrides: Partial<NoticeInput> = {}): NoticeInput {
  return {
    id: 'ntc_demo',
    dedupeKey: 'demo:target-1',
    level: 'danger',
    title: '生产发布失败',
    body: '官网 — exit code 1',
    source: 'release',
    ...overrides,
  };
}

function record(overrides: Partial<CdsNoticeRecord> = {}): CdsNoticeRecord {
  const iso = new Date(1_000_000).toISOString();
  return {
    id: 'ntc_demo',
    dedupeKey: 'demo:target-1',
    level: 'danger',
    title: '生产发布失败',
    body: '官网 — exit code 1',
    source: 'release',
    createdAt: iso,
    updatedAt: iso,
    occurrences: 1,
    ...overrides,
  };
}

describe('mergeNotice — 降噪判定（纯函数，可断言）', () => {
  it('窗口内同 dedupeKey 合并：次数累加、保留已读、创建时间不动', () => {
    const existing = record({ readAt: new Date(1_000_500).toISOString(), occurrences: 2 });
    const nowMs = 1_000_000 + NOTICE_MERGE_WINDOW_MS - 1;
    const merged = mergeNotice(existing, input(), nowMs);

    expect(merged.action).toBe('merged');
    expect(merged.record.occurrences).toBe(3);
    expect(merged.record.readAt).toBe(existing.readAt);
    expect(merged.record.createdAt).toBe(existing.createdAt);
    expect(Date.parse(merged.record.updatedAt)).toBe(nowMs);
  });

  it('超窗重燃：清 readAt/dismissedAt、次数归 1（这是新事实，该重新叫人）', () => {
    const existing = record({
      readAt: new Date(1_000_500).toISOString(),
      dismissedAt: new Date(1_000_600).toISOString(),
      occurrences: 5,
    });
    const nowMs = 1_000_000 + NOTICE_MERGE_WINDOW_MS + 1;
    const relit = mergeNotice(existing, input(), nowMs);

    expect(relit.action).toBe('relit');
    expect(relit.record.readAt).toBeUndefined();
    expect(relit.record.dismissedAt).toBeUndefined();
    expect(relit.record.occurrences).toBe(1);
    expect(relit.record.createdAt).toBe(existing.createdAt);
  });

  it('窗口内且已被「不再提醒」→ 不复活（用户刚说过别烦我）', () => {
    const existing = record({ dismissedAt: new Date(1_000_600).toISOString() });
    const merged = mergeNotice(existing, input(), 1_000_000 + 1_000);

    expect(merged.action).toBe('merged');
    expect(merged.record.dismissedAt).toBe(existing.dismissedAt);
  });

  it('首次出现 → created', () => {
    expect(mergeNotice(undefined, input(), 1_000_000).action).toBe('created');
  });
});

describe('NoticeLedgerService — 落盘与作用域', () => {
  it('上限有界：超出淘汰最老', () => {
    const ledger = new NoticeLedgerService({ storePath: '', maxNotices: 3 });
    for (let i = 0; i < 6; i += 1) {
      ledger.upsert(input({ id: `ntc_${i}`, dedupeKey: `demo:${i}` }));
    }
    const rows = ledger.list();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.dedupeKey)).toEqual(['demo:5', 'demo:4', 'demo:3']);
  });

  it('落盘 + 重载：写进独立文件，新实例读得回来', () => {
    const storePath = tempStore();
    const first = new NoticeLedgerService({ storePath });
    first.upsert(input());
    expect(fs.existsSync(storePath)).toBe(true);

    const reloaded = new NoticeLedgerService({ storePath });
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.getByDedupeKey('demo:target-1')?.title).toBe('生产发布失败');
  });

  it('文件损坏 → 从空账本开始且不抛（通知不能拖垮主流程）', () => {
    const storePath = tempStore();
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, '{ this is not json');
    const warn = vi.fn();

    const ledger = new NoticeLedgerService({ storePath, logger: { warn } });
    expect(ledger.list()).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('项目级作用域：只看得到自己项目，系统级条目一条都不给', () => {
    const ledger = new NoticeLedgerService({ storePath: '' });
    ledger.upsert(input({ id: 'a', dedupeKey: 'a', projectId: 'proj-a' }));
    ledger.upsert(input({ id: 'b', dedupeKey: 'b', projectId: 'proj-b' }));
    ledger.upsert(input({ id: 'sys', dedupeKey: 'sys' })); // 无 projectId = 系统级

    expect(ledger.list({ projectId: 'proj-a' }).map((r) => r.id)).toEqual(['a']);
    expect(ledger.list().map((r) => r.id).sort()).toEqual(['a', 'b', 'sys']);
  });

  it('dismiss 后不再出现在 list 里；跨项目 dismiss 被拒', () => {
    const ledger = new NoticeLedgerService({ storePath: '' });
    ledger.upsert(input({ id: 'a', dedupeKey: 'a', projectId: 'proj-a' }));

    expect(ledger.dismiss('a', 'proj-b')).toBe(false);
    expect(ledger.dismiss('a', 'proj-a')).toBe(true);
    expect(ledger.list()).toEqual([]);
  });

  it('pruneDeletedProjects：项目没了才删；判定源缺席或抛错一律不动（不误删）', () => {
    const ledger = new NoticeLedgerService({
      storePath: '',
      projectExists: (id) => id !== 'gone',
    });
    ledger.upsert(input({ id: 'live', dedupeKey: 'live', projectId: 'alive' }));
    ledger.upsert(input({ id: 'dead', dedupeKey: 'dead', projectId: 'gone' }));
    ledger.upsert(input({ id: 'sys', dedupeKey: 'sys' }));

    expect(ledger.pruneDeletedProjects()).toBe(1);
    expect(ledger.list().map((r) => r.id).sort()).toEqual(['live', 'sys']);

    const noSource = new NoticeLedgerService({ storePath: '' });
    noSource.upsert(input({ id: 'x', dedupeKey: 'x', projectId: 'whatever' }));
    expect(noSource.pruneDeletedProjects()).toBe(0);
    expect(noSource.list()).toHaveLength(1);
  });
});

describe('renderNoticeFromEvent — 只读结构化字段，不认事件名', () => {
  it('发布失败 → 深链带 project/target/run，正文取 errorMessage', () => {
    const rendered = renderNoticeFromEvent({
      type: 'release.failed',
      ts: new Date().toISOString(),
      data: {
        projectId: 'prd-agent',
        targetId: 'tgt-1',
        releaseId: 'rel_abc',
        targetName: '生产 / 官网',
        errorMessage: '门禁未通过：gateway_route_self_test 401',
      },
    });
    expect(rendered).not.toBeNull();
    expect(rendered!.level).toBe('danger');
    expect(rendered!.source).toBe('release');
    expect(rendered!.href).toBe('/release-center?project=prd-agent&target=tgt-1&run=rel_abc');
    expect(rendered!.body).toContain('生产 / 官网');
    expect(rendered!.body).toContain('gateway_route_self_test');
    expect(rendered!.dedupeKey).toContain('tgt-1');
  });

  it('存活掉线 → 落到状态页；不入账的事件返回 null', () => {
    const down = renderNoticeFromEvent({
      type: 'uptime.target.down',
      ts: new Date().toISOString(),
      data: { targetId: 'release@tgt-1', projectId: 'p', targetName: '生产 / 官网', message: 'HTTP 502' },
    });
    expect(down?.href).toBe('/status');
    expect(down?.source).toBe('uptime');

    expect(renderNoticeFromEvent({ type: 'heartbeat', ts: '', data: {} })).toBeNull();
  });
});

describe('startNoticeLedger — 事件挂钩 + 外发降级', () => {
  const outboundConfig: NoticeOutboundConfig = {
    baseUrl: 'https://map.example.com',
    token: 'tok',
    source: 'system-alert',
  };

  function failedEvent(targetId = 'tgt-1'): void {
    cdsEventsBus.publish('release.failed', {
      projectId: 'prd-agent',
      targetId,
      releaseId: 'rel_1',
      targetName: '生产 / 官网',
      errorMessage: '门禁未通过',
    });
  }

  it('未配置凭据 → outbound.status 必须是 skipped 且理由非空，绝不是 sent', async () => {
    const ledger = new NoticeLedgerService({ storePath: '' });
    const handle = startNoticeLedger({ ledger, outbound: null });
    try {
      failedEvent();
      await Promise.resolve();
      const [notice] = ledger.list();
      expect(notice).toBeDefined();
      expect(notice.outbound?.status).toBe('skipped');
      expect(notice.outbound?.status).not.toBe('sent');
      expect(notice.outbound?.reason && notice.outbound.reason.length > 0).toBe(true);
    } finally {
      handle.stop();
    }
  });

  it('窗口内重复只累加次数，且**不重复外发**', async () => {
    const ledger = new NoticeLedgerService({ storePath: '' });
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"success":true,"data":{"id":"n1"}}' }));
    const handle = startNoticeLedger({ ledger, outbound: outboundConfig, fetchImpl });
    try {
      failedEvent();
      await new Promise((r) => setTimeout(r, 0));
      failedEvent();
      failedEvent();
      await new Promise((r) => setTimeout(r, 0));

      expect(ledger.list()).toHaveLength(1);
      expect(ledger.list()[0].occurrences).toBe(3);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(ledger.list()[0].outbound?.status).toBe('sent');
    } finally {
      handle.stop();
    }
  });

  it('外发抛异常 → 本地那条仍在，且 outbound.status 是 failed（不许连本地都丢）', async () => {
    const ledger = new NoticeLedgerService({ storePath: '' });
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const handle = startNoticeLedger({ ledger, outbound: outboundConfig, fetchImpl });
    try {
      failedEvent('tgt-boom');
      await new Promise((r) => setTimeout(r, 0));

      const [notice] = ledger.list();
      expect(notice).toBeDefined();
      expect(notice.outbound?.status).toBe('failed');
      expect(notice.outbound?.reason).toContain('无法连接');
    } finally {
      handle.stop();
    }
  });

  it('记账后回发 notice.created，前端据此实时亮铃', async () => {
    const ledger = new NoticeLedgerService({ storePath: '' });
    const publish = vi.fn();
    const handle = startNoticeLedger({ ledger, outbound: null, publish });
    try {
      failedEvent('tgt-publish');
      await Promise.resolve();
      expect(publish).toHaveBeenCalledWith('notice.created', expect.objectContaining({ source: 'release' }));
    } finally {
      handle.stop();
    }
  });

  it('非告警级成功事件默认不入账；带 rollbackOf 的自动回滚才入账', async () => {
    const ledger = new NoticeLedgerService({ storePath: '' });
    const handle = startNoticeLedger({ ledger, outbound: null });
    try {
      cdsEventsBus.publish('release.succeeded', { projectId: 'p', targetId: 't1', releaseId: 'r1', targetName: '官网' });
      await Promise.resolve();
      expect(ledger.list()).toHaveLength(0);

      cdsEventsBus.publish('release.succeeded', {
        projectId: 'p', targetId: 't2', releaseId: 'r2', targetName: '官网', rollbackOf: 'r1',
      });
      await Promise.resolve();
      expect(ledger.list()).toHaveLength(1);
    } finally {
      handle.stop();
    }
  });

  it('账本自己发的 notice.created 不会被再次入账（防自我递归）', async () => {
    const ledger = new NoticeLedgerService({ storePath: '' });
    const handle = startNoticeLedger({
      ledger,
      outbound: null,
      publish: (type, data) => cdsEventsBus.publish(type, data),
    });
    try {
      failedEvent('tgt-recursion');
      await new Promise((r) => setTimeout(r, 0));
      expect(ledger.list()).toHaveLength(1);
      expect(ledger.list()[0].occurrences).toBe(1);
    } finally {
      handle.stop();
    }
  });
});
