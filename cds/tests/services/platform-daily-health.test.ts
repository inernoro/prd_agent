import { describe, it, expect } from 'vitest';
import {
  connectionUriHasCredentials,
  evaluateDailyHealth,
  platformStoreFacts,
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
    infraExemptions: [],
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
      infraExemptions: [{ id: 'legacy-mongo', expiresAt: soon }],
    }));
    expect(v.severity).toBe('critical');
    expect(v.findings[0].message).toContain('起不来');
  });

  it('还早 → warn', () => {
    const later = new Date(NOW.getTime() + 60 * 86_400_000).toISOString();
    const v = evaluateDailyHealth(input({
      infraExemptions: [{ id: 'legacy-mongo', expiresAt: later }],
    }));
    expect(v.severity).toBe('warn');
  });

  it('已经过期 → critical，措辞改成「已经到期」', () => {
    const past = new Date(NOW.getTime() - 86_400_000).toISOString();
    const v = evaluateDailyHealth(input({
      infraExemptions: [{ id: 'legacy-mongo', expiresAt: past }],
    }));
    expect(v.severity).toBe('critical');
    expect(v.findings[0].message).toContain('已经到期');
  });

  it('多个豁免只报最近的那个——先到的先炸', () => {
    const v = evaluateDailyHealth(input({
      infraExemptions: [
        { id: 'far', expiresAt: new Date(NOW.getTime() + 60 * 86_400_000).toISOString() },
        { id: 'near', expiresAt: new Date(NOW.getTime() + 3 * 86_400_000).toISOString() },
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

  /**
   * 真机事故（2026-08-28）：备份每 6 小时跑一轮、每轮 14 成功 2 失败，体检却天天报
   * 「读不到上一轮周期备份的结果」。根因在落盘那一行——只要有目标没成，完成时间就被
   * 抹成 null，于是「跑没跑」被「备没备全」绑架（形状 1）。
   *
   * 下面两条把修好之后的契约钉死：**有失败不影响新鲜度判定**，失败自己有一条判据。
   */
  it('有目标失败也不影响「跑没跑」的判定——不许再报读不到', () => {
    const v = evaluateDailyHealth(input({
      backup: {
        lastCompletedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
        coverageGaps: [],
        failedTargets: ['redis', 'cds-state-mongo'],
      },
    }));
    expect(
      v.findings.some((f) => f.id === 'backup.unknown'),
      '一轮跑完了、只是有目标失败，就不该说「读不到结果、不确定备份有没有在跑」',
    ).toBe(false);
    expect(v.findings.some((f) => f.id === 'backup.stale')).toBe(false);
  });

  it('有目标失败 → critical 并点名，不许因为拆开两个事实就变成沉默', () => {
    const v = evaluateDailyHealth(input({
      backup: {
        lastCompletedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
        coverageGaps: [],
        failedTargets: ['redis', 'cds-state-mongo'],
      },
    }));
    const failed = v.findings.find((f) => f.id === 'backup.failed-targets');
    expect(
      failed,
      '拆开「跑没跑」和「备全没备全」之后，长期失败的目标原来是被那条假 critical 顺带'
      + '遮着的。这里没有一条真判据接住它，就是把假警报换成了沉默',
    ).toBeTruthy();
    expect(failed!.severity).toBe('critical');
    expect(failed!.message).toContain('redis');
    expect(failed!.message).toContain('cds-state-mongo');
    expect(v.severity).toBe('critical');
  });

  it('失败目标和覆盖缺口是两件事，各报各的', () => {
    const v = evaluateDailyHealth(input({
      backup: {
        lastCompletedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
        coverageGaps: ['minio', 'kafka'],
        failedTargets: ['redis'],
      },
    }));
    const ids = v.findings.map((f) => f.id);
    // 「本该能备但没备成」和「按类型压根备不了」需要的动作完全不同：前者去查为什么失败，
    // 后者去补一种导出手段。合成一条就等于把两种行动指引揉成一句谁也照做不了的话。
    expect(ids).toContain('backup.failed-targets');
    expect(ids).toContain('backup.coverage-gaps');
    expect(v.findings.find((f) => f.id === 'backup.failed-targets')!.message).not.toContain('minio');
    expect(v.findings.find((f) => f.id === 'backup.coverage-gaps')!.message).not.toContain('redis');
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
        { id: 'legacy-project-mongo', publiclyPublished: false, authenticated: false },
      ],
      infraExemptions: [{ id: 'legacy-project-mongo', expiresAt: '2026-09-17T00:00:00.000Z' }],
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

/**
 * 下面两组是 2026-08-25 Codex review 的两条 P2。两条都是我自己写的新代码里的
 * 缺陷，而且**都是「一盏永远亮着的灯」这个病的复发**——这个体检本来就是为治它而生的。
 */
describe('豁免倒计时的覆盖面不受运行态筛选影响', () => {
  // 2026-08-25 Codex review P1。第一版把到期日挂在 HealthInfraFact 上，于是倒计时
  // 只覆盖得到「暴露面自检认下来的那批」——不发布端口的、当前停着的都不在里面。
  // 而这条倒计时存在的全部意义，就是在这些库起不来之前先说一句。
  it('一台压根不在运行态清单里的服务，照样能报出它的倒计时', () => {
    const v = evaluateDailyHealth(input({
      infra: [],   // 运行态一台都没有：它停着，或者纯内网没发布端口
      infraExemptions: [{ id: 'legacy-mongo', projectId: 'proj-a', expiresAt: new Date(NOW.getTime() + 3 * 86_400_000).toISOString() }],
    }));
    const deadline = v.findings.find((f) => f.id === 'infra.auth-exemption-deadline');
    expect(deadline, '豁免是配置层的事实，不该被运行态清单卡住').toBeTruthy();
    expect(deadline!.message).toContain('proj-a 项目的 legacy-mongo');
  });

  it('反面对照：台账为空时不报——判据不是恒真的', () => {
    const v = evaluateDailyHealth(input({
      infra: [{ id: 'legacy-mongo', publiclyPublished: false, authenticated: true }],
      infraExemptions: [],
    }));
    expect(v.findings.some((f) => f.id === 'infra.auth-exemption-deadline')).toBe(false);
  });
});

describe('内网但无口令：不发布端口的服务也要被看见', () => {
  // 同一条 P1 的另一半。「内网但无口令」这一整档，判的正是没有对外端口的服务；
  // 如果喂进来的事实只有「有对外端口的」，这一档永远不会响。
  it('publiclyPublished=false + 无认证 → 报出来', () => {
    const v = evaluateDailyHealth(input({
      infra: [{ id: 'legacy-mongo', projectId: 'proj-a', publiclyPublished: false, authenticated: false }],
    }));
    const f = v.findings.find((x) => x.id === 'infra.naked-internal.proj-a::legacy-mongo');
    expect(f, '纯内网、没口令的库必须报').toBeTruthy();
    expect(f!.severity).toBe('warn');
  });

  it('反面对照：配了口令就不报', () => {
    const v = evaluateDailyHealth(input({
      infra: [{ id: 'legacy-mongo', projectId: 'proj-a', publiclyPublished: false, authenticated: true }],
    }));
    expect(v.findings.some((x) => x.id.startsWith('infra.naked-internal.'))).toBe(false);
  });
});

describe('平台存储事实：没有 Mongo 就别报', () => {
  it('json 后端不报——那种部署压根没有 CDS 自己的 Mongo', () => {
    // 无条件塞一条 connectionUri: null 会被判成「没有凭据」，
    // 于是天天为一个不存在的库报警。这个体检不能自己先犯这个病。
    expect(platformStoreFacts({ CDS_STORAGE_MODE: 'json', CDS_MONGO_URI: 'mongodb://x' })).toEqual([]);
    expect(platformStoreFacts({})).toEqual([]);
  });

  it('显式 mongo 模式即使没连接串也要报——那才是真的少配了', () => {
    const facts = platformStoreFacts({ CDS_STORAGE_MODE: 'mongo-split' });
    expect(facts).toHaveLength(1);
    expect(facts[0].connectionUri).toBeNull();
  });

  it('缺省模式看有没有连接串', () => {
    expect(platformStoreFacts({ CDS_MONGO_URI: 'mongodb://cds:pw@h:27017/db' })).toHaveLength(1);
    expect(platformStoreFacts({ CDS_STORAGE_MODE: 'auto' })).toEqual([]);
  });

  it('json 状态后端 + mongo 鉴权后端：那台 Mongo 照样要报', () => {
    // 这是**受支持的组合**（index.ts 的 initAuthStore 明写 CDS_AUTH_BACKEND=mongo
    // 需要 CDS_MONGO_URI，且与 CDS_STORAGE_MODE 无关）。第一版只看存储模式，
    // 于是一个正在存账号口令的 Mongo 从体检里彻底消失——漏报比误报更糟，
    // 误报至少还看得见（Codex review P2 第四轮）。
    const facts = platformStoreFacts({
      CDS_STORAGE_MODE: 'json',
      CDS_AUTH_BACKEND: 'mongo',
      CDS_MONGO_URI: 'mongodb://h:27017/cds_auth_db',
    });
    expect(facts).toHaveLength(1);
    expect(facts[0].label).toBe('CDS 鉴权库');
    // 端到端：没凭据就得真的变红，不是只出现在数组里。
    expect(evaluateDailyHealth(input({ platformStores: facts })).severity).toBe('warn');
  });

  it('两个后端都用 mongo 时报一条，标签说清是谁在用', () => {
    // 标准安装（exec_cds.sh init）就是这个组合，指的还是同一个 Mongo。
    const facts = platformStoreFacts({
      CDS_STORAGE_MODE: 'mongo-split',
      CDS_AUTH_BACKEND: 'mongo',
      CDS_MONGO_URI: 'mongodb://cds:pw@h:27017/db',
    });
    expect(facts).toHaveLength(1);
    expect(facts[0].label).toBe('CDS 状态库与鉴权库');
  });

  it('鉴权后端不是 mongo 就不算——认不出的值在 index.ts 里退回 memory', () => {
    expect(platformStoreFacts({ CDS_STORAGE_MODE: 'json', CDS_AUTH_BACKEND: 'memory' })).toEqual([]);
    expect(platformStoreFacts({ CDS_STORAGE_MODE: 'json', CDS_AUTH_BACKEND: 'mongodb' })).toEqual([]);
    expect(platformStoreFacts({ CDS_STORAGE_MODE: 'json', CDS_AUTH_BACKEND: '' })).toEqual([]);
    // 大小写与空格不该改变判定。
    expect(platformStoreFacts({ CDS_STORAGE_MODE: 'json', CDS_AUTH_BACKEND: ' Mongo ' })).toHaveLength(1);
  });

  it('接上体检之后：json 部署不会因为这条变红', () => {
    // 端到端断言，而不是只看数组长度——判据与体检各自漂移的话这条会红。
    const v = evaluateDailyHealth({
      now: NOW,
      infra: [],
      infraExemptions: [],
      platformStores: platformStoreFacts({ CDS_STORAGE_MODE: 'json' }),
      backup: { lastCompletedAt: new Date(NOW.getTime() - 3_600_000).toISOString(), coverageGaps: [] },
      lastRestoreDrillAt: new Date(NOW.getTime() - 86_400_000).toISOString(),
    });
    expect(v.severity).toBe('ok');
  });
});

/**
 * 2026-08-25 Codex review 第三轮 P2：防火墙状态在事实映射里被丢掉了。
 *
 * 暴露面自检对「绑在全网卡、但宿主防火墙挡着」这一类是**特意**降到 warn 的，
 * 因为说「任何人扫到就能直接读写」当场就能被验伪。体检拿到的事实里少了这一位，
 * 于是同一台库在这边又被判回 critical，并把那句假话原样说了出去。
 *
 * 这是形状 6：判据读到的值不是真正生效的那个（原始绑定 ≠ 有效可达性）。
 */
describe('结论必须分得清是哪个项目的那台服务', () => {
  it('两个项目各有一个 redis：出两条结论，id 不撞、话里说得清是谁', () => {
    // 豁免台账早就按项目记，但结论的 id 与话术还只用 svc.id 的话，
    // 两个项目会生成一模一样的 finding id——按 id 去重就少一条，运维也看不出该去修
    // 哪个项目的那台（Codex review P2）。
    const v = evaluateDailyHealth(input({
      infra: [
        { id: 'redis', projectId: 'proj-a', publiclyPublished: true, authenticated: false },
        { id: 'redis', projectId: 'proj-b', publiclyPublished: true, authenticated: false },
      ],
    }));
    const ids = v.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toEqual(['infra.naked-public.proj-a::redis', 'infra.naked-public.proj-b::redis']);
    expect(v.findings[0].message).toContain('proj-a');
    expect(v.findings[1].message).toContain('proj-b');
  });

  it('项目未知时退回裸 id，不编一个假的作用域', () => {
    const v = evaluateDailyHealth(input({
      infra: [{ id: 'lonely-redis', publiclyPublished: false, authenticated: false }],
    }));
    expect(v.findings[0].id).toBe('infra.naked-internal.lonely-redis');
    expect(v.findings[0].message).toContain('lonely-redis');
    expect(v.findings[0].message).not.toContain('::');
  });

  it('四类结论都带项目，不是只修了最显眼的那一条', () => {
    // 只改「公网裸奔」那一条最容易漏掉其余三条，而它们同样会撞 id。
    const v = evaluateDailyHealth(input({
      infra: [
        { id: 'a', projectId: 'p1', publiclyPublished: true, authenticated: null },
        { id: 'a', projectId: 'p1', publiclyPublished: true, firewallBlocked: true, authenticated: false },
        { id: 'b', projectId: 'p1', publiclyPublished: false, authenticated: false },
      ],
    }));
    for (const f of v.findings) expect(f.id).toContain('p1::');
  });
});

describe('防火墙挡着的端口：不许报成公网裸奔，也不许当成没事', () => {
  it('绑全网卡 + 无认证 + 防火墙挡着 → warn，且不说「任何人扫到就能读写」', () => {
    const v = evaluateDailyHealth(input({
      infra: [{ id: 'shielded-mongo', publiclyPublished: true, firewallBlocked: true, authenticated: false }],
    }));
    expect(v.severity).toBe('warn');
    expect(v.findings.map((f) => f.id)).toEqual(['infra.firewall-shielded.shielded-mongo']);
    // 那句会被当场验伪的话不许出现。
    expect(v.findings[0].message).not.toContain('任何人扫到');
    // 但也必须说清这层保护是易失的，否则会被读成「已经解决了」。
    expect(v.findings[0].message).toContain('重启就丢');
  });

  it('同一台库，防火墙没了就立刻升回 critical（红绿两端都钉住）', () => {
    // 没有这一条，把 reachableFromInternet 写成恒 false 也能让上面那条绿。
    const v = evaluateDailyHealth(input({
      infra: [{ id: 'shielded-mongo', publiclyPublished: true, firewallBlocked: false, authenticated: false }],
    }));
    expect(v.severity).toBe('critical');
    expect(v.findings.map((f) => f.id)).toEqual(['infra.naked-public.shielded-mongo']);
    expect(v.findings[0].message).toContain('任何人扫到');
  });

  it('字段缺失按「没挡着」算——安全自检里不确定就从严', () => {
    const v = evaluateDailyHealth(input({
      infra: [{ id: 'legacy-fact', publiclyPublished: true, authenticated: false }],
    }));
    expect(v.severity).toBe('critical');
    expect(v.findings[0].id).toBe('infra.naked-public.legacy-fact');
  });

  it('防火墙挡着 + 认不出认证 → 也只到 warn，且说明是「认不出」', () => {
    const v = evaluateDailyHealth(input({
      infra: [{ id: 'mystery', publiclyPublished: true, firewallBlocked: true, authenticated: null }],
    }));
    expect(v.severity).toBe('warn');
    expect(v.findings.map((f) => f.id)).toEqual(['infra.firewall-shielded.mystery']);
    expect(v.findings[0].message).toContain('认不出');
  });

  it('防火墙挡着 + 认证配好了 → 体检这边不报（那层易失保护由暴露面自检说）', () => {
    const v = evaluateDailyHealth(input({
      infra: [{ id: 'fine', publiclyPublished: true, firewallBlocked: true, authenticated: true }],
    }));
    expect(v.severity).toBe('ok');
    expect(v.findings).toEqual([]);
  });

  it('每台库只落进一个桶，不会既报公网又报内网', () => {
    // 加了新分档最容易出的错是漏改另外两处过滤，让同一台库出现两次。
    const v = evaluateDailyHealth(input({
      infra: [
        { id: 'a', publiclyPublished: true, firewallBlocked: true, authenticated: false },
        { id: 'b', publiclyPublished: true, firewallBlocked: false, authenticated: false },
        { id: 'c', publiclyPublished: false, authenticated: false },
      ],
    }));
    expect(v.findings).toHaveLength(3);
    expect(v.findings.map((f) => f.id).sort()).toEqual([
      'infra.firewall-shielded.a',
      'infra.naked-internal.c',
      'infra.naked-public.b',
    ]);
  });
});
