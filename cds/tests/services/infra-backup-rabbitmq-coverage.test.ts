import { describe, it, expect } from 'vitest';
import {
  backupKindOf,
  backupFileName,
  buildRabbitmqDumpScript,
  buildRabbitmqRestoreScript,
  buildRabbitmqQueueCountScript,
  classifyBackupCoverage,
  extractBackupGapNote,
  extractBackupScopeNote,
  planInfraBackups,
  backupCoverageGaps,
  type BackupCandidate,
} from '../../src/services/infra-backup-schedule.js';
import { scriptedDump } from '../../src/routes/infra-backup.js';

/**
 * 备份覆盖面：rabbitmq 接进来，其余的分类说清楚。
 *
 * ## 这里修的是两件事
 *
 * 一是 rabbitmq 此前掉在「暂不支持」里。它有标准的一致性导出手段
 * （`rabbitmqctl export_definitions`），只是没接——和 postgres 当初一样。
 *
 * 二是那句「暂不支持自动备份的类型」本身。它把三件完全不同的事说成了同一件：
 * memcached 没有持久化功能（没东西可丢）、MinIO 里有真实文件但需要桶到桶复制、
 * SQL Server 有标准 dump 只是还没接。更要命的是它们一律 `blocksHealthy`——
 * 任何项目只要跑着一个 memcached，备份健康位就**永远是红的**，
 * 红了几个月和绿了几个月对磁盘上的备份份数没有任何区别，于是没人当真。
 * 这正是 postgres 那条（E48）被埋三个月的形状：一个长期红着、没人看的灯。
 */

const NOW = new Date('2026-08-23T12:00:00.000Z');

function cand(patch: Partial<BackupCandidate> & { id: string }): BackupCandidate {
  return {
    projectId: 'proj',
    containerName: `proj-${patch.id}-1`,
    dockerImage: 'mongo:7',
    running: true,
    ...patch,
  };
}

describe('rabbitmq 进入备份范围', () => {
  it('判据认得它，不再落进「不认识的类型」', () => {
    expect(backupKindOf('rabbitmq:3-management-alpine')).toBe('rabbitmq');
    // 私有仓库 / 摘要镜像那种名字里一个产品名都没有的，靠 id 与容器名兜底。
    expect(backupKindOf('registry.internal/mq@sha256:abc', { id: 'rabbitmq' })).toBe('rabbitmq');
  });

  it('扩展名说实话：产物是 JSON 不是 SQL', () => {
    const name = backupFileName('proj', 'rabbitmq', 'rabbitmq', NOW.toISOString());
    expect(name.endsWith('.json.gz')).toBe(true);
    // 拿到一个 .sql.gz 的人会去找 psql，那是一条走不通的路。
    expect(name).not.toContain('.sql.gz');
  });

  it('下载与恢复走的是同一段脚本，不是 tar /data', () => {
    // rabbitmq 的数据在 /var/lib/rabbitmq，掉进兜底 tar 会拿到一个空壳配 HTTP 200
    // （mysql 那次 E41 的形状）。
    expect(scriptedDump('rabbitmq')?.dump()).toBe(buildRabbitmqDumpScript());
    expect(scriptedDump('rabbitmq')?.restore('/tmp/x.json.gz'))
      .toBe(buildRabbitmqRestoreScript('/tmp/x.json.gz'));
    expect(scriptedDump('rabbitmq')?.ext).toBe('json.gz');
    // 恢复前后数的是队列不是表，「表数 3 → 5」在这里是错的话。
    expect(scriptedDump('rabbitmq')?.unit).toBe('队列');
  });

  it('进得了备份计划，且不算覆盖缺口', () => {
    const plan = planInfraBackups([
      cand({ id: 'rabbitmq', dockerImage: 'rabbitmq:3-management-alpine' }),
    ], { now: NOW });
    expect(plan.targets.map((t) => t.kind)).toEqual(['rabbitmq']);
    expect(backupCoverageGaps(plan)).toEqual([]);
  });
});

describe('rabbitmq 导出脚本', () => {
  const dump = buildRabbitmqDumpScript();

  it('带 -q：不加的话提示行会混进 JSON，产出一份解析不了的备份', () => {
    expect(dump).toContain('rabbitmqctl -q export_definitions - --format=json');
  });

  it('连不上节点当场退出，不产出一份空备份', () => {
    expect(dump).toContain('await_startup');
    expect(dump).toContain('exit 78');
  });

  it('两端退出码都检查，不只看管道最后一环', () => {
    // dash 没有 pipefail，裸管道只给最后一环的退出码：export_definitions 挂了
    // 而 gzip 成功，就会留下一份**空的 gz** 并报成功。
    expect(dump).toContain('dump=$?');
    expect(dump).toContain('gzip=$?');
    expect(dump).toMatch(/\[ "\$\{d:-1\}" = 0 \] \|\| exit/);
    expect(dump).toMatch(/\[ "\$\{g:-1\}" = 0 \] \|\| exit/);
  });

  it('无条件报出「消息不在这份备份里」，并带上条数', () => {
    // 光说「不含消息」谁都不会当回事；说「当前积压 N 条不会被带走」才是
    // 一个能让人做决定的事实。
    //
    // 两个标记都要在：有积压走 gap（算缺口、拉低健康位），0 条走 scope（纯说明）。
    // 行为层面的分档断言在 infra-backup-schedule.test.ts 里跑真脚本。
    expect(dump).toContain('cds-backup-gap:');
    expect(dump).toContain('cds-backup-scope:');
    expect(dump).toContain('definitions');
    expect(dump).toContain('$CDS_RMQ_MSGS');
  });

  it('数不出来时说数不出来，不拿 0 顶替', () => {
    // 一个真的空队列和一次失败的查询，在「输出为空」这件事上长得一模一样。
    // 所以退出码单独接一手，不靠输出是否为空来猜。
    expect(dump).toContain('CDS_RMQ_RC=$?');
    expect(dump).toContain('没数出来');
  });

  it('注记走 stderr，不污染产物', () => {
    // stdout 是 definitions JSON 本身，往里写一个字这份备份就废了。
    for (const line of dump.split('\n')) {
      // 两个标记都要走 stderr——只检查其中一个的话，另一个漏写 >&2 时
      // 这条守卫会静默放行，而那正好会把 definitions JSON 写坏。
      if (line.includes('cds-backup-scope:') || line.includes('cds-backup-gap:')) {
        expect(line, line).toContain('>&2');
      }
    }
  });

  it('从 stderr 里能把注记捞回来', () => {
    // 有积压那一档现在走 gap 标记：它是「本可以带走却没带走」，该算缺口。
    const note = extractBackupGapNote(
      'some noise\ncds-backup-gap: 这份备份只有 definitions；默认 vhost 当前积压 12 条消息\n',
    );
    expect(note).toContain('definitions');
    expect(note).toContain('12 条');
  });
});

describe('rabbitmq 恢复与取证脚本', () => {
  it('先验 gz 完整性再动节点', () => {
    const restore = buildRabbitmqRestoreScript('/tmp/a.json.gz');
    expect(restore).toContain('gunzip -t');
    expect(restore).toContain('exit 65');
    // 验完整性必须排在 import 之前，否则半截文件已经灌进去了。
    expect(restore.indexOf('gunzip -t')).toBeLessThan(restore.indexOf('import_definitions'));
  });

  it('路径里的单引号不会把脚本撑破', () => {
    const restore = buildRabbitmqRestoreScript("/tmp/it's.json.gz");
    expect(restore).toContain(`'/tmp/it'"'"'s.json.gz'`);
  });

  it('两端退出码都检查', () => {
    const restore = buildRabbitmqRestoreScript('/tmp/a.json.gz');
    expect(restore).toContain('import=$?');
    expect(restore).toMatch(/\[ "\$\{m:-1\}" = 0 \] \|\| exit/);
  });

  it('零个队列不算失败', () => {
    // `grep -c .` 在零匹配时退出码是 1，会把「一个队列都没有」这个完全正常的
    // 答案判成取证失败。所以用 awk。
    const count = buildRabbitmqQueueCountScript();
    expect(count).toContain('awk');
    expect(count).not.toContain('grep -c');
  });
});

describe('没备的那些，分类说清楚', () => {
  it('MinIO / Kafka / Elasticsearch：有数据，但要另一套手段', () => {
    const minio = classifyBackupCoverage('minio');
    expect(minio.bucket).toBe('different-mechanism');
    expect(minio.blocksHealthy).toBe(true);
    expect(minio.reason).toContain('桶到桶');

    expect(classifyBackupCoverage('kafka').reason).toContain('MirrorMaker');
    expect(classifyBackupCoverage('elasticsearch').reason).toContain('快照');
  });

  it('SQL Server / ClickHouse：有标准手段，只是欠着', () => {
    for (const kind of ['sqlserver', 'clickhouse']) {
      const v = classifyBackupCoverage(kind);
      expect(v.bucket).toBe('not-yet');
      expect(v.blocksHealthy).toBe(true);
      expect(v.reason).toContain('欠账');
    }
  });

  it('memcached：没有持久化功能，不该让健康位永远红着', () => {
    const v = classifyBackupCoverage('memcached');
    expect(v.bucket).toBe('no-durable-state');
    expect(v.blocksHealthy).toBe(false);
  });

  it('nats 默认没有持久状态，但开了 JetStream 就有', () => {
    expect(classifyBackupCoverage('nats').blocksHealthy).toBe(false);
    // 判据不能只认一种写法：命令行开关、配置块、环境变量都算。
    const withFlag = classifyBackupCoverage('nats', { command: ['-c', 'nats-server -js -c /tmp/x.conf'] });
    expect(withFlag.bucket).toBe('not-yet');
    expect(withFlag.blocksHealthy).toBe(true);
    expect(withFlag.reason).toContain('JetStream');

    expect(classifyBackupCoverage('nats', { command: 'nats-server --jetstream' }).blocksHealthy).toBe(true);
    expect(classifyBackupCoverage('nats', { command: 'sh -c "jetstream { store_dir: /data }"' }).blocksHealthy).toBe(true);
    expect(classifyBackupCoverage('nats', { env: { JS_ENABLED: 'true' } }).blocksHealthy).toBe(true);
  });

  it('JetStream 判据不是恒真：普通 nats 配置不许被误判', () => {
    // 没有这条，上面那组即使在「永远返回 true」时也会绿。
    const plain = { command: ['-c', 'printf "authorization { user: a }" > /tmp/n.conf; exec nats-server -c /tmp/n.conf'] };
    expect(classifyBackupCoverage('nats', plain).blocksHealthy).toBe(false);
    // 名字里带 justify / jsx 之类的东西不该命中 `-js`。
    expect(classifyBackupCoverage('nats', { command: 'nats-server --config /opt/js-config/n.conf' }).blocksHealthy).toBe(false);
  });

  it('认不出来的按「有数据」处理', () => {
    const v = classifyBackupCoverage('other');
    expect(v.bucket).toBe('unknown');
    expect(v.blocksHealthy).toBe(true);
  });

  it('已覆盖的类型不算缺口', () => {
    for (const kind of ['mongo', 'redis', 'mysql', 'postgres', 'rabbitmq']) {
      const v = classifyBackupCoverage(kind);
      expect(v.bucket).toBe('covered');
      expect(v.blocksHealthy).toBe(false);
    }
  });
});

describe('整轮健康：跑着 memcached 不再让它永远红着', () => {
  it('只有 memcached 没被备时，整轮没有缺口', () => {
    const plan = planInfraBackups([
      cand({ id: 'mongodb' }),
      cand({ id: 'cache', dockerImage: 'memcached:1.6-alpine' }),
    ], { now: NOW });
    expect(plan.targets.map((t) => t.id)).toEqual(['mongodb']);
    expect(plan.skipped.map((s) => s.id)).toEqual(['cache']);
    // 跳过了，但不是缺口——它本来就没有需要备份的东西。
    expect(backupCoverageGaps(plan)).toEqual([]);
  });

  it('MinIO 仍然是缺口——那里面是真实文件', () => {
    const plan = planInfraBackups([
      cand({ id: 'files', dockerImage: 'minio/minio:latest' }),
    ], { now: NOW });
    expect(backupCoverageGaps(plan).map((s) => s.id)).toEqual(['files']);
  });

  it('开了 JetStream 的 nats 是缺口，没开的不是', () => {
    const on = planInfraBackups([
      cand({ id: 'bus', dockerImage: 'nats:2-alpine', command: ['-c', 'exec nats-server -js'] }),
    ], { now: NOW });
    expect(backupCoverageGaps(on).map((s) => s.id)).toEqual(['bus']);

    const off = planInfraBackups([
      cand({ id: 'bus', dockerImage: 'nats:2-alpine', command: ['-c', 'exec nats-server -c /tmp/n.conf'] }),
    ], { now: NOW });
    expect(backupCoverageGaps(off)).toEqual([]);
  });
});
