import { describe, it, expect } from 'vitest';
import {
  connectionUriHasCredentials,
  evaluateDailyHealth,
  BACKUP_STALE_AFTER_MS,
  RESTORE_DRILL_STALE_AFTER_MS,
  EXEMPTION_URGENT_DAYS,
  type DailyHealthInput,
} from '../../src/services/platform-daily-health.js';

/**
 * 每日安全体检。
 *
 * 这些用例的取值不是编的：2026-08-23 那次人工安全审计查出来的每一条，
 * 本来都该由这个体检自己每天说出来。所以下面每一条都对着当时的一个真实发现。
 */

const NOW = new Date('2026-08-23T10:00:00.000Z');

function input(patch: Partial<DailyHealthInput> = {}): DailyHealthInput {
  return {
    now: NOW,
    infra: [],
    platformStores: [],
    backup: { lastCompletedAt: new Date(NOW.getTime() - 3_600_000).toISOString(), coverageGaps: [] },
    lastRestoreDrillAt: new Date(NOW.getTime() - 86_400_000).toISOString(),
    ...patch,
  };
}

describe('连接串里带没带凭据', () => {
  it('带账号口令才算数', () => {
    expect(connectionUriHasCredentials('mongodb://app:s3cret@db:27017/x')).toBe(true);
    expect(connectionUriHasCredentials('redis://:pw@cache:6379')).toBe(false); // 没有账号
    expect(connectionUriHasCredentials('mongodb://app:@db:27017')).toBe(false); // 空口令
    expect(connectionUriHasCredentials('mongodb://db:27017/x')).toBe(false);
    expect(connectionUriHasCredentials('')).toBe(false);
    expect(connectionUriHasCredentials(null)).toBe(false);
  });

  it('解析不了的一律当没有——安全自检里宁可误报也不漏报', () => {
    expect(connectionUriHasCredentials('这不是一个连接串')).toBe(false);
    expect(connectionUriHasCredentials('mongodb://')).toBe(false);
  });

  it('主机名里有 @ 之类的怪形态不会被当成凭据', () => {
    // 路径里的 @ 不算（正则限定在第一个 / 之前）
    expect(connectionUriHasCredentials('mongodb://db:27017/some@path')).toBe(false);
  });
});

describe('公网上的无认证数据库', () => {
  it('公网 + 无认证 = critical，且排在第一句话里', () => {
    const v = evaluateDailyHealth(input({
      infra: [{ id: 'old-mongo', publiclyPublished: true, authenticated: false }],
    }));
    expect(v.severity).toBe('critical');
    expect(v.headline).toContain('需要立刻处理');
    expect(v.headline).toContain('old-mongo');
    expect(v.findings.some((f) => f.id === 'infra.naked-public.old-mongo')).toBe(true);
  });

  it('公网但认不出有没有认证 → warn，不许当成没问题', () => {
    const v = evaluateDailyHealth(input({
      infra: [{ id: 'mystery', publiclyPublished: true, authenticated: null }],
    }));
    expect(v.severity).toBe('warn');
    expect(v.findings[0].id).toBe('infra.unknown-auth.mystery');
  });

  it('内网无口令仍要报，只是降一级', () => {
    const v = evaluateDailyHealth(input({
      infra: [{ id: 'inner-redis', publiclyPublished: false, authenticated: false }],
    }));
    expect(v.severity).toBe('warn');
    expect(v.findings[0].id).toBe('infra.naked-internal.inner-redis');
  });

  it('公网 + 有认证 = 不报（对照组，防判据恒真）', () => {
    const v = evaluateDailyHealth(input({
      infra: [{ id: 'fine', publiclyPublished: true, authenticated: true }],
    }));
    expect(v.severity).toBe('ok');
    expect(v.findings).toEqual([]);
  });
});

describe('平台自身的存储——门禁管不到的那一块', () => {
  it('CDS 自己的库没口令必须报出来', () => {
    // 认证门禁只挂在「启动项目基础设施容器」那一步，CDS 状态库不是项目基础设施，
    // 它**从来不在门禁管辖范围内**。审计查出的那条就是这个盲区。
    const v = evaluateDailyHealth(input({
      platformStores: [{ label: 'CDS 状态库', connectionUri: 'mongodb://cds-state-mongo:27017/cds' }],
    }));
    expect(v.severity).toBe('warn');
    expect(v.findings[0].message).toContain('CDS 状态库');
    expect(v.findings[0].message).toContain('管不到它');
  });

  it('结论里绝不出现连接串本身', () => {
    const v = evaluateDailyHealth(input({
      platformStores: [{ label: 'CDS 状态库', connectionUri: 'mongodb://cds-state-mongo:27017/cds' }],
    }));
    // 判定层拿到的是密钥，泄漏它比不做这个检查更糟。
    const serialized = JSON.stringify(v);
    expect(serialized).not.toContain('cds-state-mongo');
    expect(serialized).not.toContain('27017');
  });

  it('配了口令就不报', () => {
    const v = evaluateDailyHealth(input({
      platformStores: [{ label: 'CDS 状态库', connectionUri: 'mongodb://cds:pw@cds-state-mongo:27017/cds' }],
    }));
    expect(v.severity).toBe('ok');
  });
});

describe('存量豁免倒计时', () => {
  it('还剩两周以内 → critical，并说清到期后是起不来不是告警', () => {
    const soon = new Date(NOW.getTime() + (EXEMPTION_URGENT_DAYS - 1) * 86_400_000).toISOString();
    const v = evaluateDailyHealth(input({
      infra: [{ id: 'legacy-mongo', publiclyPublished: false, authenticated: true, authExemptionExpiresAt: soon }],
    }));
    expect(v.severity).toBe('critical');
    expect(v.findings[0].message).toContain('起不来');
  });

  it('还早 → warn', () => {
    const later = new Date(NOW.getTime() + 60 * 86_400_000).toISOString();
    const v = evaluateDailyHealth(input({
      infra: [{ id: 'legacy-mongo', publiclyPublished: false, authenticated: true, authExemptionExpiresAt: later }],
    }));
    expect(v.severity).toBe('warn');
  });

  it('已经过期 → critical，措辞改成「已经到期」', () => {
    const past = new Date(NOW.getTime() - 86_400_000).toISOString();
    const v = evaluateDailyHealth(input({
      infra: [{ id: 'legacy-mongo', publiclyPublished: false, authenticated: true, authExemptionExpiresAt: past }],
    }));
    expect(v.severity).toBe('critical');
    expect(v.findings[0].message).toContain('已经到期');
  });

  it('多个豁免只报最近的那个——先到的先炸', () => {
    const v = evaluateDailyHealth(input({
      infra: [
        { id: 'far', publiclyPublished: false, authenticated: true, authExemptionExpiresAt: new Date(NOW.getTime() + 60 * 86_400_000).toISOString() },
        { id: 'near', publiclyPublished: false, authenticated: true, authExemptionExpiresAt: new Date(NOW.getTime() + 3 * 86_400_000).toISOString() },
      ],
    }));
    const deadline = v.findings.find((f) => f.id === 'infra.auth-exemption-deadline')!;
    expect(deadline.message).toContain('near');
    expect(deadline.message).toContain('2 个数据库');
  });
});

describe('备份新鲜度与恢复演练', () => {
  it('读不到上一轮备份 → critical，按「没有」处理而不是「没问题」', () => {
    const v = evaluateDailyHealth(input({ backup: { lastCompletedAt: null, coverageGaps: [] } }));
    expect(v.severity).toBe('critical');
    expect(v.findings.some((f) => f.id === 'backup.unknown')).toBe(true);
  });

  it('备份过期 → critical', () => {
    const stale = new Date(NOW.getTime() - BACKUP_STALE_AFTER_MS - 60_000).toISOString();
    const v = evaluateDailyHealth(input({ backup: { lastCompletedAt: stale, coverageGaps: [] } }));
    expect(v.findings.some((f) => f.id === 'backup.stale')).toBe(true);
  });

  it('有覆盖缺口 → warn，并点名是哪几个', () => {
    const v = evaluateDailyHealth(input({
      backup: { lastCompletedAt: new Date(NOW.getTime() - 3_600_000).toISOString(), coverageGaps: ['nacos', 'kafka'] },
    }));
    const gap = v.findings.find((f) => f.id === 'backup.coverage-gaps')!;
    expect(gap.message).toContain('nacos');
    expect(gap.message).toContain('kafka');
  });

  it('从来没做过恢复演练 → critical，不许算通过', () => {
    // 「没演练过的备份不算备份」。没有记录时的答案是「不知道能不能恢复」，
    // 而不是「没有异常」。
    const v = evaluateDailyHealth(input({ lastRestoreDrillAt: null }));
    expect(v.severity).toBe('critical');
    expect(v.findings.some((f) => f.id === 'restore-drill.never')).toBe(true);
  });

  it('演练过期 → warn', () => {
    const old = new Date(NOW.getTime() - RESTORE_DRILL_STALE_AFTER_MS - 86_400_000).toISOString();
    const v = evaluateDailyHealth(input({ lastRestoreDrillAt: old }));
    expect(v.findings.some((f) => f.id === 'restore-drill.stale')).toBe(true);
  });
});

describe('第一屏那句话', () => {
  it('全绿时说得干脆', () => {
    expect(evaluateDailyHealth(input()).headline).toBe('今天没有发现安全或备份问题');
  });

  it('是判断不是统计——「N 项异常」放到任何一天都成立，等于没说', () => {
    const v = evaluateDailyHealth(input({
      infra: [
        { id: 'old-mongo', publiclyPublished: true, authenticated: false },
        { id: 'inner-redis', publiclyPublished: false, authenticated: false },
      ],
      lastRestoreDrillAt: null,
    }));
    // 挑最要命的那条说出来，而不是只给个数字
    expect(v.headline).toContain('old-mongo');
    expect(v.headline).toContain('公网');
    // 其余的数量也要带上，别让人以为只有一条
    expect(v.headline).toContain('另有');
  });

  it('2026-08-23 那次审计的完整形状：一次全中', () => {
    // 这条用例是本模块存在的理由。把当天查出来的东西原样喂进去，
    // 体检必须自己把它们全说出来。
    const v = evaluateDailyHealth({
      now: NOW,
      infra: [
        { id: 'old-prod-mongo', publiclyPublished: true, authenticated: true },
        { id: 'new-prod-mongo', publiclyPublished: false, authenticated: false },
        { id: 'prod-redis', publiclyPublished: false, authenticated: false },
        {
          id: 'legacy-project-mongo',
          publiclyPublished: false,
          authenticated: false,
          authExemptionExpiresAt: '2026-09-17T00:00:00.000Z',
        },
      ],
      platformStores: [
        { label: 'CDS 主库', connectionUri: 'mongodb://cds-mongo:27017/cds' },
        { label: 'CDS 状态库', connectionUri: 'mongodb://cds-state:27017/state' },
      ],
      backup: { lastCompletedAt: new Date(NOW.getTime() - 3_600_000).toISOString(), coverageGaps: ['nacos', 'rabbitmq', 'minio', 'kafka'] },
      lastRestoreDrillAt: null,
    });

    expect(v.severity).toBe('critical');
    const ids = v.findings.map((f) => f.id);
    expect(ids).toContain('infra.naked-internal.new-prod-mongo');
    expect(ids).toContain('infra.naked-internal.prod-redis');
    expect(ids).toContain('platform-store.no-credentials.CDS 主库');
    expect(ids).toContain('platform-store.no-credentials.CDS 状态库');
    expect(ids).toContain('infra.auth-exemption-deadline');
    expect(ids).toContain('backup.coverage-gaps');
    expect(ids).toContain('restore-drill.never');
    // 旧库有口令，所以不该出现在无认证清单里——它的问题是端口，那一条由暴露面自检报。
    expect(ids.some((id) => id.includes('old-prod-mongo'))).toBe(false);
  });
});
