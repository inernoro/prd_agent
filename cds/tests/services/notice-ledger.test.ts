import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NOTICE_BODY_MAX_CHARS,
  NOTICE_MERGE_WINDOW_MS,
  NoticeLedgerService,
  compactNoticeText,
  mergeNotice,
  noticeStatusOf,
  renderNoticeFromEvent,
  startNoticeLedger,
  type CdsNoticeActor,
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

/**
 * 处理状态机（认领闭环）。
 *
 * 事故值：这一组断言的每一条错了都**不会报错**，只会静默把界面变成谎话——
 *   1. 旧记录不归 open → 存量告警从「待处理」筛选里整批消失，最该被看见的反而不见；
 *   2. 状态不落盘 → 换台机器/重启 CDS 就回到「没人处理」，两个人重复干同一件事；
 *   3. 超窗重燃不清 handling → 上个月标「已解决」的通知这次重新坏了还显示已解决，
 *      把新故障伪装成旧结论；
 *   4. 认领人在无身份部署上被回填成通道桶名 → 界面显示一个假责任人。
 */
describe('处理状态机 — 待处理/处理中/已解决', () => {
  const anonymousActor: CdsNoticeActor = { channel: 'user', userId: null, userLabel: null, provider: null };
  const namedActor: CdsNoticeActor = {
    channel: 'user', userId: 'usr_1', userLabel: '张三', provider: 'github',
  };

  it('从没被处理过的（含旧账本无 handling 字段）一律算待处理', () => {
    const ledger = new NoticeLedgerService({ storePath: '' });
    ledger.upsert(input());
    const [row] = ledger.list();
    expect(row.handling).toBeUndefined();
    expect(noticeStatusOf(row)).toBe('open');
    expect(ledger.summary().counts).toEqual({ open: 1, working: 0, resolved: 0 });
  });

  it('认领 → 处理中：记录变更时间与变更者，并顺带标已读', () => {
    const ledger = new NoticeLedgerService({ storePath: '', now: () => 5_000_000 });
    ledger.upsert(input({ id: 'a', dedupeKey: 'a' }));
    const updated = ledger.setHandling('a', 'working', namedActor);

    expect(updated?.handling?.status).toBe('working');
    expect(updated?.handling?.actor.userLabel).toBe('张三');
    expect(Date.parse(updated!.handling!.updatedAt)).toBe(5_000_000);
    expect(updated?.readAt).toBeDefined();
    expect(ledger.summary().counts).toEqual({ open: 0, working: 1, resolved: 0 });
    expect(ledger.summary().unread).toBe(0);
  });

  it('无身份部署（basic / 项目 Key）：状态照样推进，但责任人如实留空', () => {
    const ledger = new NoticeLedgerService({ storePath: '' });
    ledger.upsert(input({ id: 'a', dedupeKey: 'a' }));
    const updated = ledger.setHandling('a', 'working', anonymousActor);

    expect(updated?.handling?.status).toBe('working');
    // 留空是刻意的：把 channel（'user'）填进 userLabel 会让所有人看到同一个「责任人」。
    expect(updated?.handling?.actor.userId).toBeNull();
    expect(updated?.handling?.actor.userLabel).toBeNull();
    expect(updated?.handling?.actor.channel).toBe('user');
  });

  it('状态落盘：新实例读得回来（换台机器打开不该回到「没人处理」）', () => {
    const storePath = tempStore();
    const first = new NoticeLedgerService({ storePath });
    first.upsert(input({ id: 'a', dedupeKey: 'a' }));
    first.setHandling('a', 'working', namedActor);

    const reloaded = new NoticeLedgerService({ storePath });
    const [row] = reloaded.list();
    expect(noticeStatusOf(row)).toBe('working');
    expect(row.handling?.actor.userLabel).toBe('张三');
  });

  it('落盘文件里的非法状态 → 归一成待处理，不原样渲染', () => {
    const storePath = tempStore();
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      notices: [{
        ...record({ id: 'a', dedupeKey: 'a' }),
        handling: { status: 'resolvedd', updatedAt: 'x', actor: { channel: 42 } },
      }],
    }));

    const ledger = new NoticeLedgerService({ storePath });
    const [row] = ledger.list();
    expect(noticeStatusOf(row)).toBe('open');
    expect(row.handling?.actor.channel).toBe('unknown');
  });

  it('list 按状态筛选：能回答「还有几条没人处理」', () => {
    const ledger = new NoticeLedgerService({ storePath: '' });
    for (const id of ['a', 'b', 'c']) ledger.upsert(input({ id, dedupeKey: id }));
    ledger.setHandling('b', 'working', anonymousActor);
    ledger.setHandling('c', 'resolved', anonymousActor);

    expect(ledger.list({ status: 'open' }).map((r) => r.id)).toEqual(['a']);
    expect(ledger.list({ status: 'working' }).map((r) => r.id)).toEqual(['b']);
    expect(ledger.summary().counts).toEqual({ open: 1, working: 1, resolved: 1 });
  });

  it('按 (id, 作用域) 一次查：A 项目认领不会命中 B 那条同 id 的通知', () => {
    const ledger = new NoticeLedgerService({ storePath: '' });
    // 刻意让 B 后写（排在前面），才能暴露「取第一条同 id」的写法。
    for (const projectId of ['proj-a', 'proj-b']) {
      ledger.upsert(input({ id: 'release-failed', dedupeKey: `api:${projectId}:release-failed`, projectId }));
    }
    expect(ledger.setHandling('release-failed', 'working', anonymousActor, 'proj-a')).not.toBeNull();

    const a = ledger.list({ projectId: 'proj-a' })[0];
    const b = ledger.list({ projectId: 'proj-b' })[0];
    expect(noticeStatusOf(a)).toBe('working');
    expect(noticeStatusOf(b)).toBe('open');
    expect(ledger.setHandling('release-failed', 'working', anonymousActor, 'proj-c')).toBeNull();
  });

  it('已被「不再提醒」的不给推进（它已不在任何人视野里，改了只会让计数对不上）', () => {
    const ledger = new NoticeLedgerService({ storePath: '' });
    ledger.upsert(input({ id: 'a', dedupeKey: 'a' }));
    ledger.dismiss('a');
    expect(ledger.setHandling('a', 'working', anonymousActor)).toBeNull();
  });

  it('窗口内又抖一次：处理进展保留（不该让「已认领」在对方眼里凭空消失）', () => {
    const existing = record({
      handling: { status: 'working', updatedAt: new Date(1_000_100).toISOString(), actor: namedActor },
    });
    const merged = mergeNotice(existing, input(), 1_000_000 + NOTICE_MERGE_WINDOW_MS - 1);
    expect(merged.action).toBe('merged');
    expect(noticeStatusOf(merged.record)).toBe('working');
    expect(merged.record.handling?.actor.userLabel).toBe('张三');
  });

  it('超窗重燃：handling 一起清掉（否则新故障会被伪装成上次的「已解决」）', () => {
    const existing = record({
      handling: { status: 'resolved', updatedAt: new Date(1_000_100).toISOString(), actor: namedActor },
    });
    const relit = mergeNotice(existing, input(), 1_000_000 + NOTICE_MERGE_WINDOW_MS + 1);
    expect(relit.action).toBe('relit');
    expect(relit.record.handling).toBeUndefined();
    expect(noticeStatusOf(relit.record)).toBe('open');
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

  it('优先展示结构化失败摘要，并把原始多行日志压缩到通知正文上限', () => {
    const structured = renderNoticeFromEvent({
      type: 'release.failed',
      ts: new Date().toISOString(),
      data: {
        projectId: 'prd-agent',
        targetId: 'tgt-1',
        targetName: '生产 / 官网',
        errorMessage: 'raw stderr '.repeat(100),
        failure: { summary: '镜像拉取失败，请检查不可变版本是否存在' },
      },
    });
    expect(structured?.body).toContain('镜像拉取失败');
    expect(structured?.body).not.toContain('raw stderr');

    const compact = compactNoticeText(`第一行\n${'下载日志 '.repeat(100)}`);
    expect(compact).not.toContain('\n');
    expect(compact.length).toBeLessThanOrEqual(NOTICE_BODY_MAX_CHARS);
    expect(compact.endsWith('…')).toBe(true);
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
