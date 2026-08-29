import { describe, expect, it } from 'vitest';
import {
  buildBackupPanel,
  isProjectOwnedBackupFile,
  parseAutoBackupStamp,
  relativeAge,
  type BackupHealthRecord,
} from '../../src/services/backup-panel.js';
import { backupFailureReason, backupFileName } from '../../src/services/infra-backup-schedule.js';
import { BACKUP_STALE_AFTER_MS } from '../../src/services/platform-daily-health.js';

const NOW = new Date('2026-08-28T12:00:00.000Z');

/** 真机上的形状：同一轮里多个项目各有一个叫 redis 的目标。 */
function health(overrides: Partial<BackupHealthRecord> = {}): BackupHealthRecord {
  return {
    completedAt: '2026-08-28T09:00:00.000Z',
    localVerifiedAt: '2026-08-25T09:00:00.000Z',
    remoteVerifiedAt: '2026-08-25T09:00:00.000Z',
    coverageGaps: [],
    failedTargets: [],
    offsiteOnlyTargets: [],
    objects: [],
    ...overrides,
  };
}

describe('周期备份面板：文件名时间戳', () => {
  it('认得出写入端**真正生成**的文件名', () => {
    // 断言求值结果，不是源码字面量：写入端换个格式，这里要当场红（形状 6）。
    const name = backupFileName('web', 'redis', 'redis', '2026-08-28T09:00:00.000Z');
    expect(parseAutoBackupStamp(name)).toBe('2026-08-28T09:00:00.000Z');
  });

  it('恢复前快照不算一次周期备份成功', () => {
    expect(parseAutoBackupStamp('web--redis-pre-restore-2026-08-28T09-00-00.rdb')).toBeNull();
  });
});

describe('周期备份面板：项目归属', () => {
  it('前缀相近的两个项目不会互相把对方的备份算进来', () => {
    // 项目 `a` 的前缀是 `a--`，项目 `a-` 的文件名以 `a---` 开头。裸前缀匹配会串。
    expect(isProjectOwnedBackupFile('a--redis-auto-20260828T090000Z.rdb', 'a')).toBe(true);
    expect(isProjectOwnedBackupFile('a---redis-auto-20260828T090000Z.rdb', 'a')).toBe(false);
    expect(isProjectOwnedBackupFile('a---redis-auto-20260828T090000Z.rdb', 'a-')).toBe(true);
  });

  it('别的项目的同名 redis 不许出现在这个项目的清单里', () => {
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({
        objects: [
          { id: 'redis', projectId: 'web', bytes: 100, remoteObjectKey: 'k' },
          { id: 'redis', projectId: 'crm', bytes: 200, remoteObjectKey: 'k' },
          { id: 'mongo', projectId: 'crm', bytes: 300 },
        ],
      }),
      files: [],
    });
    expect(view.targets.map((t) => t.id)).toEqual(['redis']);
    expect(view.targets[0].bytes).toBe(100);
  });

  it('没有项目段的存量记录不许被猜成本项目的', () => {
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({ objects: [{ id: 'redis', bytes: 100 }] }),
      files: [],
    });
    expect(view.targets).toHaveLength(0);
  });
});

describe('周期备份面板：每个目标的处境', () => {
  it('各档分开，且「本地没成」优先于「只备到一部分」', () => {
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({
        objects: [
          { id: 'ok-one', projectId: 'web', bytes: 10, remoteObjectKey: 'k' },
          { id: 'partial-one', projectId: 'web', bytes: 20, remoteObjectKey: 'k' },
          { id: 'offsite-one', projectId: 'web', bytes: 30 },
        ],
        failedTargets: [{ id: 'failed-one', projectId: 'web', reason: 'NOAUTH Authentication required' }],
        offsiteOnlyTargets: [{ id: 'offsite-one', projectId: 'web', reason: '离机副本缺失：连接超时' }],
        coverageGaps: [
          { id: 'partial-one', projectId: 'web', reason: '只导了 POSTGRES_DB 那一个库' },
          { id: 'minio-one', projectId: 'web', reason: '需要桶到桶复制，不是一份 dump' },
          // 同时进了「失败」和「缺口」两栏。优先级反过来的话它会被说成
          // 「这个类型还备不了」——而它明明是本该能备、这次没备成。
          { id: 'failed-one', projectId: 'web', reason: '这一轮没跑到，覆盖不全' },
        ],
      }),
      files: [],
    });
    const byId = new Map(view.targets.map((t) => [t.id, t]));
    expect(byId.get('ok-one')!.status).toBe('ok');
    expect(byId.get('failed-one')!.status).toBe('failed');
    expect(byId.get('offsite-one')!.status).toBe('offsite-only');
    // 备成功了、只是范围有限 → partial；这一轮压根没有产物、又记了缺口 → 有数据没被保护。
    expect(byId.get('partial-one')!.status).toBe('partial');
    expect(byId.get('minio-one')!.status).toBe('unprotected');
  });

  it('失败原因要留给用户点开看，不用他自己去翻容器日志', () => {
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({
        failedTargets: [{ id: 'redis', projectId: 'web', reason: 'NOAUTH Authentication required' }],
      }),
      files: [],
    });
    expect(view.targets[0].reason).toContain('NOAUTH');
  });

  it('正常的目标不需要解释', () => {
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({ objects: [{ id: 'redis', projectId: 'web', bytes: 10 }] }),
      files: [],
    });
    expect(view.targets[0].reason).toBeNull();
    // 这一轮没有 remoteObjectKey = 离机那一程没走通/没配，别显示成有离机副本。
    expect(view.targets[0].offsite).toBe(false);
  });

  it('这一轮没有产物时，「最近一次成功」仍从盘上的文件推出来', () => {
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({
        failedTargets: [{ id: 'redis', projectId: 'web', reason: '拿不到口令' }],
      }),
      files: [
        { name: backupFileName('web', 'redis', 'redis', '2026-08-25T09:00:00.000Z'), bytes: 11 },
        { name: backupFileName('web', 'redis', 'redis', '2026-08-24T09:00:00.000Z'), bytes: 12 },
        // 别的项目的同名服务，不能算进来。
        { name: backupFileName('crm', 'redis', 'redis', '2026-08-28T09:00:00.000Z'), bytes: 13 },
      ],
    });
    const target = view.targets[0];
    // 「三天前」可行动；「未知」只会让人怀疑面板本身。
    expect(target.lastSuccessAt).toBe('2026-08-25T09:00:00.000Z');
    expect(target.fileCount).toBe(2);
    expect(view.files.count).toBe(2);
    expect(view.files.bytes).toBe(23);
  });
});

describe('周期备份面板：第一屏那句话', () => {
  it('读不到结果时说「读不到」，不说「没问题」', () => {
    const view = buildBackupPanel({ projectId: 'web', now: NOW, health: null, files: [] });
    expect(view.verdict.tone).toBe('bad');
    expect(view.verdict.headline).toContain('读不到');
  });

  it('有目标本地没备成时，第一句先说这件事', () => {
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({
        objects: [{ id: 'a', projectId: 'web', bytes: 1, remoteObjectKey: 'k' }],
        failedTargets: [{ id: 'b', projectId: 'web', reason: 'x' }],
        offsiteOnlyTargets: [{ id: 'c', projectId: 'web', reason: 'y' }],
      }),
      files: [],
    });
    expect(view.verdict.tone).toBe('bad');
    expect(view.verdict.headline).toContain('1 个目标本地就没备出来');
    // 其余目标的处境退到第二行，不跟第一句抢。
    expect(view.verdict.subline).toContain('正常 1 个');
  });

  it('只是离机没上去时降一档，且不许说成「没有新副本」', () => {
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({
        objects: [{ id: 'c', projectId: 'web', bytes: 1 }],
        offsiteOnlyTargets: [{ id: 'c', projectId: 'web', reason: 'y' }],
      }),
      files: [],
    });
    expect(view.verdict.tone).toBe('warn');
    expect(view.verdict.headline).toContain('只备在本机');
    expect(view.verdict.headline).not.toContain('没有');
  });

  it('平安无事的那天，一句话说清「几个目标、多新的副本」', () => {
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({
        objects: [
          { id: 'a', projectId: 'web', bytes: 1, remoteObjectKey: 'k' },
          { id: 'b', projectId: 'web', bytes: 2, remoteObjectKey: 'k' },
        ],
      }),
      files: [],
    });
    expect(view.verdict.tone).toBe('ok');
    expect(view.verdict.headline).toBe('2 个能备的目标都有 3 小时前的副本');
  });

  it('一条记录都没有时不假装正常', () => {
    const view = buildBackupPanel({ projectId: 'web', now: NOW, health: health(), files: [] });
    expect(view.verdict.tone).toBe('warn');
    expect(view.verdict.headline).toContain('还没有一条周期备份记录');
  });
});

describe('下一轮什么时候', () => {
  it('按上一轮 + 备份周期推，且只当预估用', () => {
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({ objects: [{ id: 'a', projectId: 'web', bytes: 1 }] }),
      files: [],
      intervalMs: 6 * 60 * 60_000,
    });
    expect(view.nextRoundEstimatedAt).toBe('2026-08-28T15:00:00.000Z');
  });

  it('连上一轮都读不到时，不编一个下一轮出来', () => {
    const view = buildBackupPanel({ projectId: 'web', now: NOW, health: null, files: [] });
    expect(view.nextRoundEstimatedAt).toBeNull();
  });
});

describe('产物不在盘上（健康记录说成功，文件却没了）', () => {
  /**
   * Codex review P1。这一档防的正是这批改动要治的病：落盘记录只能证明
   * 「那一轮产出过」，证明不了「此刻还在」。只读记录就会把一个产物已经被删掉的
   * 目标报成「正常」，等到真要恢复那天才发现手上什么都没有。
   */
  const NAME = backupFileName('web', 'mongo', 'mongo', '2026-08-28T09:00:00.000Z');

  it('记录说成功、盘上却没有这个文件时，不许报「正常」', () => {
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({
        objects: [{ id: 'mongo', projectId: 'web', fileName: NAME, bytes: 4096, remoteObjectKey: 'k' }],
      }),
      files: [],
    });
    expect(view.targets[0].status).toBe('artifact-missing');
    expect(view.targets[0].reason).toContain(NAME);
    // 结果和「没备出来」一样严重：真要恢复时手上没有那份文件。
    expect(view.verdict.tone).toBe('bad');
    expect(view.verdict.headline).toContain('现在不在盘上了');
  });

  it('文件在盘上就照常算正常', () => {
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({
        objects: [{ id: 'mongo', projectId: 'web', fileName: NAME, bytes: 4096, remoteObjectKey: 'k' }],
      }),
      files: [{ name: NAME, bytes: 4096 }],
    });
    expect(view.targets[0].status).toBe('ok');
    expect(view.verdict.tone).toBe('ok');
  });

  it('「本地就没备成」优先于「产物不在了」——它本来就没有产物', () => {
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({
        objects: [{ id: 'redis', projectId: 'web', fileName: NAME, bytes: 1 }],
        failedTargets: [{ id: 'redis', projectId: 'web', reason: 'NOAUTH' }],
      }),
      files: [],
    });
    expect(view.targets[0].status).toBe('failed');
  });

  it('离机没上去的那份，本地文件也没了 → 先说产物不在了', () => {
    // 「仅本机」这句话的全部价值就在于「本机那份还在」。它不在了，这句话就是假的。
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({
        objects: [{ id: 'mysql', projectId: 'web', fileName: NAME, bytes: 2048 }],
        offsiteOnlyTargets: [{ id: 'mysql', projectId: 'web', reason: '离机超时' }],
      }),
      files: [],
    });
    expect(view.targets[0].status).toBe('artifact-missing');
  });

  it('存量记录没有 fileName 时不下这个结论——证明不了它不在', () => {
    // 一响就响一片的告警没人会看。宁可这一档漏报，也不误报一整批存量数据。
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({ objects: [{ id: 'mongo', projectId: 'web', bytes: 4096 }] }),
      files: [],
    });
    expect(view.targets[0].status).toBe('ok');
  });
});

describe('清单要并上台账里此刻真实跑着的服务', () => {
  /**
   * Codex review 第二轮 P1。清单只从上一轮记录来的话，上一轮之后才建的库、以及
   * 当时容器停着的服务，在这一屏上压根不存在——而第一屏还在宣布一切正常。
   * 一台从没备过的库看不见，比看见它红着更危险。
   */
  it('上一轮之后才建的库要出现，且不许被算进「正常」', () => {
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({ objects: [{ id: 'mongo', projectId: 'web', bytes: 1 }] }),
      files: [],
      infra: [
        { id: 'mongo', dockerImage: 'mongo:7' },
        { id: 'brand-new-pg', dockerImage: 'postgres:16' },
      ],
    });
    const byId = new Map(view.targets.map((t) => [t.id, t]));
    expect(byId.get('brand-new-pg')!.status).toBe('not-in-last-round');
    expect(byId.get('brand-new-pg')!.reason).toContain('盘上也没有任何副本');
    // 第一屏不许再说「都有副本」。
    expect(view.verdict.tone).toBe('warn');
    expect(view.verdict.headline).toContain('上一轮备份里没有它们');
    expect(view.verdict.subline).toContain('正常 1 个');
  });

  it('容器停着但盘上有旧副本时，说得出「还留着更早的副本」', () => {
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health(),
      files: [{ name: backupFileName('web', 'redis', 'redis', '2026-08-25T09:00:00.000Z'), bytes: 11 }],
      infra: [{ id: 'redis', dockerImage: 'redis:7-alpine' }],
    });
    expect(view.targets[0].status).toBe('not-in-last-round');
    expect(view.targets[0].lastSuccessAt).toBe('2026-08-25T09:00:00.000Z');
    expect(view.targets[0].reason).toContain('更早的副本');
  });

  it('台账里那台没有持久状态的，归「没有需要备份的状态」，不惊动人', () => {
    // 能不能备走 backupKindOf 这一份判据，有没有数据走 classifyBackupCoverage 那一份，
    // 都不在面板里另猜一套。memcached 重启即空，是真的不需要人管。
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({ objects: [{ id: 'mongo', projectId: 'web', bytes: 1 }] }),
      files: [],
      infra: [{ id: 'mongo', dockerImage: 'mongo:7' }, { id: 'cache', dockerImage: 'memcached:1.6' }],
    });
    const byId = new Map(view.targets.map((t) => [t.id, t]));
    expect(byId.get('cache')!.status).toBe('unsupported');
    expect(byId.get('cache')!.reason).toContain('没有持久化');
    expect(view.verdict.tone).toBe('ok');
  });

  it('台账里那台有数据却备不了的，要说「没有备份保护」而不是不出声', () => {
    // 上一轮之后才建的 MinIO：它还没进过任何一轮，所以只能现算——现算也必须
    // 得出「有数据没被保护」，不能因为「这一轮没记它」就当没有。
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({ objects: [{ id: 'mongo', projectId: 'web', bytes: 1 }] }),
      files: [],
      infra: [{ id: 'mongo', dockerImage: 'mongo:7' }, { id: 'oss', dockerImage: 'minio/minio:latest' }],
    });
    const byId = new Map(view.targets.map((t) => [t.id, t]));
    expect(byId.get('oss')!.status).toBe('unprotected');
    expect(byId.get('oss')!.reason).toContain('桶到桶');
    expect(view.verdict.tone).toBe('warn');
  });

  it('上一轮记录里有、台账里已经没有的，照样列出来', () => {
    // 取并集才不会把它弄丢：服务删了，但上一轮跑的时候它还在，那一轮的结论仍然要说得出。
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({ failedTargets: [{ id: 'gone', projectId: 'web', reason: 'x' }] }),
      files: [],
      infra: [],
    });
    expect(view.targets.map((t) => t.id)).toEqual(['gone']);
  });

  /**
   * 这条钉的是**现状**，不是期望（Codex review 第四轮 P2）。
   *
   * 上面那条原先叫「台账里没有、但盘上还留着备份的服务，照样列出来」，可它喂的是一条
   * `failedTargets` 记录——id 是从健康记录来的，跟盘上的文件没有关系。名字说的是一件事，
   * 断言证明的是另一件事：一个只以「盘上还留着文件」形式存在的目标（服务删了，之后又跑过
   * 一轮，记录被重写、里面已经没有它），并集的三个来源一个都命中不了。
   *
   * 所以把真实现状写成断言：那种目标**没有行**，而它的文件**照样进页脚的份数**。
   * 真去做「从文件名反推历史目标」的时候，这条会红——那正是它的用途：逼人回来一起把
   * 「哪些目标该出现在这一屏」重新想一遍（台账 E86），而不是再补第四块补丁。
   */
  it('只以盘上文件形式存在的目标，此刻没有行——但文件算进了页脚（已知边界 E86）', () => {
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({ objects: [{ id: 'mongo', projectId: 'web', bytes: 1 }] }),
      files: [
        { name: backupFileName('web', 'mongo', 'mongo', '2026-08-28T09:00:00.000Z'), bytes: 7 },
        // 这台服务已经被删了，上一轮的记录里没有它，台账里也没有——只剩这份文件。
        { name: backupFileName('web', 'removed-pg', 'postgres', '2026-08-25T09:00:00.000Z'), bytes: 9 },
      ],
      infra: [{ id: 'mongo', dockerImage: 'mongo:7' }],
    });
    expect(view.targets.map((t) => t.id)).toEqual(['mongo']);
    // 文件在、行不在：页脚数得出两份，用户却对不上其中一份是谁的。
    expect(view.files.count).toBe(2);
  });
});

describe('排程停摆要在第一屏说', () => {
  /**
   * Codex review 第三轮 P1。上一轮里每个目标都成了，但「那一轮」是几天前——
   * 调度器死了、机器关了都会这样。只看目标状态就给绿色大字，而页脚的每日体检
   * 同时在喊「已经陈旧」：同一屏自己打自己，而面板要回答的正是「要不要你管」。
   */
  it('上一轮是好几天前时，第一屏不许是绿的', () => {
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({
        completedAt: '2026-08-24T09:00:00.000Z', // 4 天前，远超 13 小时阈值
        objects: [{ id: 'a', projectId: 'web', bytes: 1, remoteObjectKey: 'k' }],
      }),
      files: [],
    });
    expect(view.verdict.tone).toBe('bad');
    expect(view.verdict.headline).toContain('没跑了');
    expect(view.verdict.headline).toContain('99 小时');
  });

  it('刚跑过的那一轮照旧是绿的', () => {
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({ objects: [{ id: 'a', projectId: 'web', bytes: 1, remoteObjectKey: 'k' }] }),
      files: [],
    });
    expect(view.verdict.tone).toBe('ok');
  });

  it('阈值与每日体检共用一个数，不在面板里另定', () => {
    // 两处各写一个数字，页脚说「已经陈旧」而第一屏还是绿的——同一屏自相矛盾。
    const justUnder = new Date(NOW.getTime() - BACKUP_STALE_AFTER_MS + 60_000).toISOString();
    const justOver = new Date(NOW.getTime() - BACKUP_STALE_AFTER_MS - 60_000).toISOString();
    const of = (completedAt: string): string => buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({ completedAt, objects: [{ id: 'a', projectId: 'web', bytes: 1 }] }),
      files: [],
    }).verdict.tone;
    expect(of(justUnder)).toBe('ok');
    expect(of(justOver)).toBe('bad');
  });
});

describe('相对时间', () => {
  it('按「隔了多久」说，不按日历说', () => {
    expect(relativeAge(NOW, '2026-08-28T11:59:30.000Z')).toBe('刚刚');
    expect(relativeAge(NOW, '2026-08-28T11:30:00.000Z')).toBe('30 分钟前');
    expect(relativeAge(NOW, '2026-08-28T09:00:00.000Z')).toBe('3 小时前');
    expect(relativeAge(NOW, '2026-08-25T09:00:00.000Z')).toBe('3 天前');
    expect(relativeAge(NOW, null)).toBeNull();
    expect(relativeAge(NOW, '不是时间')).toBeNull();
  });
});

describe('落进健康文件的失败原因', () => {
  it('容器输出里的口令不许原样落盘（它会经面板端点回到浏览器）', () => {
    const reason = backupFailureReason("导出失败: MYSQL_ROOT_PASSWORD=hunter2 not accepted");
    expect(reason).toBeTruthy();
    expect(reason).not.toContain('hunter2');
  });

  it('长输出截尾不截头——失败原因永远在末尾', () => {
    const reason = backupFailureReason(`${'启动噪音 '.repeat(200)}最后一行才是真正的失败原因`)!;
    expect(reason).toContain('最后一行才是真正的失败原因');
    expect(reason.startsWith('…（前文截断）')).toBe(true);
  });

  it('没有原因就是没有，不要一个空字符串', () => {
    expect(backupFailureReason(undefined)).toBeUndefined();
    expect(backupFailureReason('   ')).toBeUndefined();
  });
});

/**
 * Codex review 第五轮 P1 两条，都是同一种病的不同长相：**第一屏报绿，页脚同时在报红**。
 * 这一整批改动就是为治这个病写的，不能自己先犯。
 */
describe('第一屏不许在这两种情况下报绿', () => {
  it('有数据却没被保护的服务，不能被算进「都有副本」', () => {
    // 一台跑着的 MinIO：满桶对象，这套 dump 式备份接不了它，落盘时记的是一条
    // blocksHealthy 的缺口——页脚的每日体检据此喊「覆盖不全」。原来它和 memcached
    // 归成一句「这类还备不了」，第一屏照样报绿。
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({
        objects: [{ id: 'mongo', projectId: 'web', bytes: 1, remoteObjectKey: 'k' }],
        coverageGaps: [{ id: 'oss', projectId: 'web', reason: 'MinIO 里是对象文件，要的是桶到桶复制' }],
      }),
      files: [],
    });
    expect(view.verdict.tone).toBe('warn');
    expect(view.verdict.headline).toContain('这套周期备份接不了');
    // 正常那一个仍然要在副标题里说得出来，别把好消息一起吞掉。
    expect(view.verdict.subline).toContain('正常 1 个');
  });

  it('一个能备的目标都没有时，不说「0 个目标都有副本」', () => {
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health(),
      files: [],
      infra: [{ id: 'cache', dockerImage: 'memcached:1.6' }],
    });
    expect(view.verdict.headline).toBe('这个项目没有需要周期备份的服务');
    expect(view.verdict.headline).not.toContain('0 个');
  });

  it('上一轮没记下完成时间时，说不出年龄就不许说「最近一轮」', () => {
    // 字段缺了或写坏了，Date.parse 得到 NaN。原来的陈旧判据只在时间有效时才生效，
    // 无效就直接落到绿色分支——而绿的那句话恰恰在说「都拿到了最近一轮的副本」。
    for (const completedAt of [undefined, '', 'not-a-date']) {
      const view = buildBackupPanel({
        projectId: 'web',
        now: NOW,
        health: health({ completedAt, objects: [{ id: 'a', projectId: 'web', bytes: 1, remoteObjectKey: 'k' }] }),
        files: [],
      });
      expect(view.verdict.tone).toBe('bad');
      expect(view.verdict.headline).toContain('没有记下完成时间');
    }
  });
});

/**
 * Codex review 第六轮 P2 两条。共同点：都是**升级/部署形态**引发的假警报——
 * 面板在没出事的时候喊出事，而这套体检最怕的就是没人再看它。
 */
describe('陈旧盖过轻档，且从不消失（第九轮 P2）', () => {
  const OLD = '2026-08-24T09:00:00.000Z'; // 4 天前，远超阈值

  it('三天没跑的轮次里，头条说的是「没跑」，不是「仅本机」', () => {
    // 原来陈旧排在所有 warn 之后：一个三天没跑的轮次只要有一个目标仅本机，
    // 头条就只说那句 warn，而页脚同时把调度器停摆报成 critical——轻的那半当了头条。
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({
        completedAt: OLD,
        objects: [{ id: 'c', projectId: 'web', bytes: 1 }],
        offsiteOnlyTargets: [{ id: 'c', projectId: 'web', reason: 'y' }],
      }),
      files: [],
    });
    expect(view.verdict.tone).toBe('bad');
    expect(view.verdict.headline).toContain('没跑了');
  });

  it('更重的那档当头条时，陈旧退到第二行，不许消失', () => {
    // 「本地没备出来」同为 bad、且说的是「手上现在没有那份文件」，该它当头条；
    // 但陈旧是「屏幕上这些状态有多旧」的注脚，丢了它整屏会被读成此刻的状态。
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({
        completedAt: OLD,
        objects: [{ id: 'a', projectId: 'web', bytes: 1, remoteObjectKey: 'k' }],
        failedTargets: [{ id: 'b', projectId: 'web', reason: 'x' }],
      }),
      files: [],
    });
    expect(view.verdict.headline).toContain('本地就没备出来');
    expect(view.verdict.subline).toContain('没跑了');
  });

  it('陈旧当了头条时，第二行不再重复它', () => {
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({
        completedAt: OLD,
        objects: [{ id: 'a', projectId: 'web', bytes: 1, remoteObjectKey: 'k' }],
      }),
      files: [],
    });
    expect(view.verdict.headline).toContain('没跑了');
    expect(view.verdict.subline ?? '').not.toContain('没跑了');
  });
});

describe('升级前写下的缺口不能被整批丢掉（第九轮 P2）', () => {
  it('旧格式缺口没有 projectId，靠「这个项目已确认拥有的 id」认领', () => {
    // 升级前写入端给缺口存的是 { id, reason, blocksHealthy }，连 projectId 都没有。
    // 丢掉它，一个「备成功但只覆盖一个库」的 postgres 会被判成 ok——第一屏宣布
    // 「都有最近的副本」，而那几个库一份备份都没有。
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({
        objects: [{
          id: 'postgres',
          projectId: 'web',
          fileName: backupFileName('web', 'postgres', 'postgres', '2026-08-28T09:00:00.000Z'),
          bytes: 10,
          remoteObjectKey: 'k',
        }],
        coverageGaps: [{ id: 'postgres', reason: '只导了 POSTGRES_DB 那一个库' }],
      }),
      files: [{ name: backupFileName('web', 'postgres', 'postgres', '2026-08-28T09:00:00.000Z'), bytes: 10 }],
    });
    expect(view.targets[0].status).toBe('partial');
    expect(view.verdict.tone).toBe('warn');
  });

  it('旧格式缺口不许凭自己新增一个目标', () => {
    // 只认领本项目已确认拥有的 id；一个本项目从没出现过的 id，不能靠一条无作用域的
    // 缺口凭空进清单——那等于把别的项目的服务摆进来。
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({ coverageGaps: [{ id: 'someone-else', reason: 'x' }] }),
      files: [],
    });
    expect(view.targets).toHaveLength(0);
  });
});

describe('升级与无状态部署不许喊狼来了', () => {
  it('旧格式的成功记录按文件名认领，不被当成「上一轮没备到」', () => {
    // 升级后的第一次打开：盘上那份健康文件还是旧代码写的，objects 有 fileName、
    // 没有 projectId。整批丢掉的话，清单会从台账把这些库原样加回来，一屏
    // 「上一轮备份里没有它」——而备份明明好好地跑着。
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({
        objects: [{
          id: 'mongo',
          fileName: backupFileName('web', 'mongo', 'mongo', '2026-08-28T09:00:00.000Z'),
          bytes: 4096,
          remoteObjectKey: 'k',
        }],
      }),
      files: [{ name: backupFileName('web', 'mongo', 'mongo', '2026-08-28T09:00:00.000Z'), bytes: 4096 }],
      infra: [{ id: 'mongo', dockerImage: 'mongo:7' }],
    });
    expect(view.targets[0].status).toBe('ok');
    expect(view.verdict.tone).toBe('ok');
  });

  it('文件名说是别的项目的，就不是我的', () => {
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({
        objects: [{
          id: 'mongo',
          fileName: backupFileName('crm', 'mongo', 'mongo', '2026-08-28T09:00:00.000Z'),
          bytes: 4096,
        }],
      }),
      files: [],
    });
    expect(view.targets).toHaveLength(0);
  });

  it('projectId 写着别的项目时，文件名不许翻案', () => {
    // 显式作用域优先。两者打架时以 projectId 为准，否则文件名就成了绕过作用域的后门。
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: health({
        objects: [{
          id: 'mongo',
          projectId: 'crm',
          fileName: backupFileName('web', 'mongo', 'mongo', '2026-08-28T09:00:00.000Z'),
          bytes: 4096,
        }],
      }),
      files: [],
    });
    expect(view.targets).toHaveLength(0);
  });

  it('只跑无状态服务的部署，读不到结果文件是常态，不是故障', () => {
    // 排程对这种部署压根没有目标、也没有阻塞缺口，于是从来不写那份文件。
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: null,
      files: [],
      infra: [{ id: 'cache', dockerImage: 'memcached:1.6' }],
    });
    expect(view.verdict.tone).toBe('ok');
    expect(view.verdict.headline).toBe('这个项目没有需要周期备份的服务');
  });

  it('一台数据服务都没有的项目，也不该挂着「不确定备份过没有」', () => {
    // 全新项目、什么库都还没建：没有备份可言，读不到结果是常态（Codex review 第八轮 P2）。
    const view = buildBackupPanel({ projectId: 'web', now: NOW, health: null, files: [], infra: [] });
    expect(view.verdict.tone).toBe('ok');
    expect(view.verdict.headline).toBe('这个项目没有需要周期备份的服务');
    expect(view.nothingToBackUp).toBe(true);
  });

  it('库都停着 ≠ 没有库：不许说成「没有需要周期备份的服务」', () => {
    // 照字面「零目标就豁免」会踩这个坑：停着的库不进目标清单（第三轮：故意停掉的
    // 不该天天报警），于是目标为空——而它可能装着数据、且一次都没备过。
    // 说「没有需要备份的服务」就是假绿灯，正是这一整批改动要治的病。
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: null,
      files: [],
      infra: [{ id: 'mysql', dockerImage: 'mysql:8', running: false }],
    });
    expect(view.nothingToBackUp).toBe(false);
    expect(view.verdict.tone).toBe('bad');
    expect(view.verdict.headline).toContain('读不到');
  });

  it('只要有一个该备的目标，读不到结果就仍然是坏消息', () => {
    const view = buildBackupPanel({
      projectId: 'web',
      now: NOW,
      health: null,
      files: [],
      infra: [{ id: 'cache', dockerImage: 'memcached:1.6' }, { id: 'mongo', dockerImage: 'mongo:7' }],
    });
    expect(view.verdict.tone).toBe('bad');
    expect(view.verdict.headline).toContain('读不到');
  });
});
