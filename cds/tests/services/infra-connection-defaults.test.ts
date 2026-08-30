import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MYSQL_MAX_CONNECTIONS,
  applyMysqlConnectionDefaults,
  canAppendMysqldFlag,
  declaresMaxConnections,
  isMysqlFamilyImage,
  parseDeclaredMaxConnections,
  resolveConfiguredMysqlMaxConnections,
} from '../../src/services/infra-connection-defaults.js';
import { expectGuardRedOnMutation, mutate } from '../helpers/guard-mutation.js';

/**
 * 事故（2026-08-29，mdimp）：项目的两台 MySQL 都跑在 mysql:8.0 出厂默认
 * max_connections=151 上。CDS 把 N 个分支预览复用到同一台库，五个分支全起来时
 * 实测 Max_used_connections=294——旧上限连一半都不够，Flyway 迁移撞
 * `Too many connections` 直接失败，分支被标 error。
 *
 * 难认的地方在于：抢输的服务死掉后连接就还回去了，事后再查 MySQL 又是空闲的，
 * 完全不像连接问题。
 */

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('isMysqlFamilyImage', () => {
  it('认得出官方镜像、带 registry 前缀与派生镜像', () => {
    for (const image of [
      'mysql:8.0',
      'mysql',
      'docker.io/library/mysql:8.0',
      'ghcr.io/acme/mysql:8.0',
      'mariadb:11',
      'percona:8.0',
      'mysql-custom:1',
      'acme-mysql:1',
      'registry.internal:5000/team/mysql:8.0.36',
    ]) {
      expect(isMysqlFamilyImage(image), image).toBe(true);
    }
  });

  it('不会误伤别的镜像', () => {
    for (const image of ['redis:7-alpine', 'postgres:16', 'mongo:8.0', 'rabbitmq:3', '']) {
      expect(isMysqlFamilyImage(image), image).toBe(false);
    }
  });

  it('带 tag 里含冒号或 digest 时仍能正确取仓库名', () => {
    expect(isMysqlFamilyImage('mysql@sha256:abc123')).toBe(true);
    expect(isMysqlFamilyImage('redis@sha256:abc123')).toBe(false);
  });
});

describe('declaresMaxConnections：三种等价写法都要认出来', () => {
  // MySQL 选项名横线与下划线等价，且允许 `--opt value` 与 `--opt=value`。
  // 少认一种，就会出现「项目明明配了、CDS 又追加一个」，后写的静默生效。
  it('认出等号形式', () => {
    expect(declaresMaxConnections(['--max-connections=300'])).toBe(true);
  });
  it('认出下划线形式', () => {
    expect(declaresMaxConnections(['--max_connections=300'])).toBe(true);
  });
  it('认出空格分隔形式', () => {
    expect(declaresMaxConnections(['--max-connections', '300'])).toBe(true);
    expect(declaresMaxConnections(['mysqld', '--max_connections', '300'])).toBe(true);
  });
  it('字符串形态的 command 也要扫到', () => {
    expect(declaresMaxConnections('mysqld --max-connections=300')).toBe(true);
  });
  it('没声明就是没声明', () => {
    expect(declaresMaxConnections(undefined)).toBe(false);
    expect(declaresMaxConnections([])).toBe(false);
    expect(declaresMaxConnections(['--character-set-server=utf8mb4'])).toBe(false);
    // 不能被形近选项骗到
    expect(declaresMaxConnections(['--max-connect-errors=100000'])).toBe(false);
    expect(declaresMaxConnections(['--max-user-connections=50'])).toBe(false);
  });
});

/**
 * Codex 在 PR #1454 的 P2：复用容器的审计原本用 declaresMaxConnections（只判有没有
 * 声明），于是「容器创建时带着 --max-connections=300、而现在 CDS 想要 1000」这种
 * 欠配被静默放过——把「有一份声明」当成了「想要的值已生效」（形状 8）。
 *
 * 两个函数分工不同，不能互相顶替：
 *   declaresMaxConnections → 要不要注入（项目显式配过就尊重，不问大小）
 *   parseDeclaredMaxConnections → 正在跑的这个上限够不够（必须拿到数值）
 */
describe('parseDeclaredMaxConnections：取出实际生效的数值', () => {
  it('三种等价写法都取得到', () => {
    expect(parseDeclaredMaxConnections(['--max-connections=300'])).toBe(300);
    expect(parseDeclaredMaxConnections(['--max_connections=300'])).toBe(300);
    expect(parseDeclaredMaxConnections(['--max-connections', '300'])).toBe(300);
    expect(parseDeclaredMaxConnections(['mysqld', '--max_connections', '300'])).toBe(300);
    expect(parseDeclaredMaxConnections('mysqld --max-connections=300')).toBe(300);
  });

  it('声明多次时取最后一次（mysqld 同名选项后写的赢，形状 6）', () => {
    expect(parseDeclaredMaxConnections(['--max-connections=300', '--max-connections=1000'])).toBe(1000);
    expect(parseDeclaredMaxConnections('mysqld --max-connections=1000 --max_connections=200')).toBe(200);
  });

  it('同一串里混用两种写法时按出现顺序取，不许优先某一种', () => {
    // 先扫完 `=N` 再扫 `空格 N` 会因为先命中 300 就跳过后面的 1000。
    expect(parseDeclaredMaxConnections('mysqld --max-connections=300 --max-connections 1000')).toBe(1000);
    expect(parseDeclaredMaxConnections('mysqld --max_connections 1000 --max-connections=300')).toBe(300);
  });

  it('没声明返回 null，且不被形近选项骗到', () => {
    expect(parseDeclaredMaxConnections(undefined)).toBeNull();
    expect(parseDeclaredMaxConnections([])).toBeNull();
    expect(parseDeclaredMaxConnections(['--character-set-server=utf8mb4'])).toBeNull();
    expect(parseDeclaredMaxConnections(['--max-connect-errors=100000'])).toBeNull();
    expect(parseDeclaredMaxConnections(['--max-user-connections=50'])).toBeNull();
    // 只有选项名、后面不是数字
    expect(parseDeclaredMaxConnections(['--max-connections', '--foo'])).toBeNull();
  });
});

describe('canAppendMysqldFlag：只在参数确实会交给 mysqld 时才追加', () => {
  it('没有 command 时安全（镜像入口默认起 mysqld）', () => {
    expect(canAppendMysqldFlag(undefined, undefined)).toBe(true);
    expect(canAppendMysqldFlag([], undefined)).toBe(true);
  });
  it('全是 flag 时安全（官方 entrypoint 见首参为 - 会自动补 mysqld）', () => {
    expect(canAppendMysqldFlag(['--character-set-server=utf8mb4'], undefined)).toBe(true);
  });
  it('显式 mysqld 时安全', () => {
    expect(canAppendMysqldFlag(['mysqld', '--slow-query-log'], undefined)).toBe(true);
    expect(canAppendMysqldFlag(['/usr/sbin/mysqld'], undefined)).toBe(true);
  });
  it('包成 shell 的一律不碰——追加会变成 sh 的参数而不是 mysqld 的', () => {
    expect(canAppendMysqldFlag(['sh', '-c', 'exec mysqld'], undefined)).toBe(false);
    expect(canAppendMysqldFlag(['bash', '-lc', 'something'], undefined)).toBe(false);
  });
  it('字符串形态的 command 一律不碰（yaml 里通常是整段 shell 语法）', () => {
    expect(canAppendMysqldFlag('mysqld --foo && echo done', undefined)).toBe(false);
  });
  it('自定义 entrypoint 时一律不碰（无从判断参数交给谁）', () => {
    expect(canAppendMysqldFlag(undefined, ['/custom-init.sh'])).toBe(false);
    expect(canAppendMysqldFlag(['--foo'], '/custom-init.sh')).toBe(false);
  });
});

describe('resolveConfiguredMysqlMaxConnections', () => {
  it('未设置时给默认值', () => {
    expect(resolveConfiguredMysqlMaxConnections(undefined)).toBe(DEFAULT_MYSQL_MAX_CONNECTIONS);
    expect(resolveConfiguredMysqlMaxConnections('')).toBe(DEFAULT_MYSQL_MAX_CONNECTIONS);
  });
  it('逃生阀：0 / off / false / no 一律关闭注入', () => {
    for (const raw of ['0', 'off', 'false', 'no', 'OFF']) {
      expect(resolveConfiguredMysqlMaxConnections(raw), raw).toBeNull();
    }
  });
  it('显式数值生效；非法值回落默认而不是注入垃圾', () => {
    expect(resolveConfiguredMysqlMaxConnections('2000')).toBe(2000);
    expect(resolveConfiguredMysqlMaxConnections('abc')).toBe(DEFAULT_MYSQL_MAX_CONNECTIONS);
    expect(resolveConfiguredMysqlMaxConnections('-5')).toBe(DEFAULT_MYSQL_MAX_CONNECTIONS);
  });
});

describe('applyMysqlConnectionDefaults：只兜底，不覆盖', () => {
  it('复现事故配置：mysql:8.0 且无 command，注入上限', () => {
    const result = applyMysqlConnectionDefaults({ dockerImage: 'mysql:8.0', command: undefined });
    expect(result.injected).toBe(DEFAULT_MYSQL_MAX_CONNECTIONS);
    expect(result.command).toEqual([`--max-connections=${DEFAULT_MYSQL_MAX_CONNECTIONS}`]);
  });

  it('保留项目原有 flag，只追加', () => {
    const result = applyMysqlConnectionDefaults({
      dockerImage: 'mysql:8.0',
      command: ['--character-set-server=utf8mb4'],
    });
    expect(result.command).toEqual([
      '--character-set-server=utf8mb4',
      `--max-connections=${DEFAULT_MYSQL_MAX_CONNECTIONS}`,
    ]);
  });

  it('项目显式声明过就一律尊重，绝不追加第二个（否则后写的静默生效）', () => {
    for (const command of [
      ['--max-connections=300'],
      ['--max_connections=300'],
      ['mysqld', '--max-connections', '300'],
    ]) {
      const result = applyMysqlConnectionDefaults({ dockerImage: 'mysql:8.0', command });
      expect(result.injected, JSON.stringify(command)).toBeNull();
      expect(result.skippedReason).toBe('already-declared');
      expect(result.command).toEqual(command);
    }
  });

  it('非 MySQL 镜像原样返回', () => {
    const result = applyMysqlConnectionDefaults({ dockerImage: 'redis:7-alpine', command: ['redis-server'] });
    expect(result.injected).toBeNull();
    expect(result.skippedReason).toBe('not-mysql');
    expect(result.command).toEqual(['redis-server']);
  });

  it('逃生阀关闭时不注入', () => {
    const result = applyMysqlConnectionDefaults({
      dockerImage: 'mysql:8.0',
      command: undefined,
      configuredMax: null,
    });
    expect(result.injected).toBeNull();
    expect(result.skippedReason).toBe('disabled');
  });

  it('command 形态不安全时不注入（宁可不兜底，也不改写别人的启动命令）', () => {
    const result = applyMysqlConnectionDefaults({
      dockerImage: 'mysql:8.0',
      command: ['sh', '-c', 'exec mysqld --foo'],
    });
    expect(result.injected).toBeNull();
    expect(result.skippedReason).toBe('unsafe-command-shape');
    expect(result.command).toEqual(['sh', '-c', 'exec mysqld --foo']);
  });
});

/**
 * 接线守卫：这个模块删掉不会红，只会静默回到 151
 * （predicate-and-wiring-discipline 形状 2）。
 */
describe('接线守卫：infra 启动路径真的在用这条兜底', () => {
  it('container.ts 的 infra 启动把 command 过了一遍兜底再拼 docker 参数', () => {
    const source = fs.readFileSync(path.join(CDS_ROOT, 'src/services/container.ts'), 'utf8');
    const at = source.indexOf('const resolvedCommandRaw = resolveCommandTemplate(service.command');
    expect(at, '找不到 infra 启动的 command 解析锚点').toBeGreaterThan(-1);
    const slice = source.slice(at, at + 1200);
    expect(slice).toContain('applyMysqlConnectionDefaults(');
    expect(slice).toContain('const resolvedCommand = mysqlDefaults.command');
  });

  it('红用例：把兜底摘掉，守卫必须变红', () => {
    const guard = (source: string) => {
      const at = source.indexOf('const resolvedCommandRaw = resolveCommandTemplate(service.command');
      expect(at).toBeGreaterThan(-1);
      expect(source.slice(at, at + 1200)).toContain('applyMysqlConnectionDefaults(');
    };
    const real = fs.readFileSync(path.join(CDS_ROOT, 'src/services/container.ts'), 'utf8');
    expectGuardRedOnMutation(guard, real, mutate(real, 'applyMysqlConnectionDefaults({', 'noopDefaults({'));
  });
});

/**
 * Codex 在 PR #1453 的 P1，属实且是四条里最该认下的一条。
 *
 * 兜底只写得进 `docker run` 那一档。infra 启动是幂等三档：
 *   running → 直接 return；stopped → docker start（沿用**创建时**的命令）；不存在 → docker run。
 * 升级和事故恢复恰恰走前两档，注入一个字都没生效——**而第一版在 inspect 之前就
 * 无条件发了「已注入」事件**。那是把一份不生效的声明当成生效的证据
 * （predicate-and-wiring-discipline 形状 8）：日志说修好了，MySQL 还是 151。
 */
describe('连接上限：事件只在真生效时说「已注入」，复用路径如实报「尚未生效」', () => {
  function containerSource(): string {
    return fs.readFileSync(path.join(CDS_ROOT, 'src/services/container.ts'), 'utf8');
  }

  it('「已注入」事件发在 docker run 真的执行之后，不在算出命令的地方', () => {
    const source = containerSource();
    const computedAt = source.indexOf('const resolvedCommand = mysqlDefaults.command;');
    const dockerRunAt = source.indexOf('const result = await this.shell.exec(cmd);');
    const appliedAt = source.indexOf("action: 'infra.mysql.max-connections-defaulted'");
    const runStartedAt = source.indexOf("action: 'infra.run.started'");
    expect(computedAt, '找不到命令计算处').toBeGreaterThan(-1);
    expect(dockerRunAt, '找不到 docker run 执行处').toBeGreaterThan(-1);
    expect(appliedAt, '找不到已注入事件').toBeGreaterThan(-1);
    expect(runStartedAt).toBeGreaterThan(-1);
    // 判据用语义位置而不是字符距离：注入只有走到 docker run 才真的写进容器，
    // 所以事件必须排在那次 exec 之后、并在 infra.run.started 之前那一段里。
    expect(appliedAt).toBeGreaterThan(dockerRunAt);
    expect(runStartedAt).toBeGreaterThan(appliedAt);
  });

  /**
   * Codex 在 PR #1454 的 P2：传给审计的原本是 mysqlDefaults.injected（「这次注没注入」），
   * 而不是「想要多少」。service 命令已显式声明 1000 时 injected 为 null，审计整个跳过，
   * 复用的旧容器可能还停在 300——数值解析器根本到不了。
   */
  it('审计拿到的是「想要的上限」，不是「这次注没注入」', () => {
    const source = containerSource();
    expect(source).toContain('const desiredMysqlMaxConnections = isMysqlFamilyImage(service.dockerImage)');
    expect(source).toContain('parseDeclaredMaxConnections(resolvedCommand) ?? mysqlDefaults.injected');
    // 两条复用路径都传目标值，不再传注入标记
    expect(source).not.toContain('auditMysqlConnectionLimit(service, mysqlDefaults.injected)');
  });

  it('红用例：把目标值换回注入标记，守卫必须变红', () => {
    const guard = (source: string) => {
      expect(source).not.toContain('auditMysqlConnectionLimit(service, mysqlDefaults.injected)');
    };
    const real = containerSource();
    expectGuardRedOnMutation(
      guard,
      real,
      mutate(real, 'auditMysqlConnectionLimit(service, desiredMysqlMaxConnections)', 'auditMysqlConnectionLimit(service, mysqlDefaults.injected)'),
    );
  });

  it('两条复用路径都接了「尚未生效」审计', () => {
    const source = containerSource();
    const reuseAt = source.indexOf("action: 'infra.reuse-running'");
    const wakeAt = source.indexOf("action: 'infra.start-existing.completed'");
    expect(reuseAt).toBeGreaterThan(-1);
    expect(wakeAt).toBeGreaterThan(-1);
    // 每条路径在发自己的复用事件之前，先跑一次连接上限审计
    const beforeReuse = source.slice(Math.max(0, reuseAt - 900), reuseAt);
    const beforeWake = source.slice(Math.max(0, wakeAt - 900), wakeAt);
    expect(beforeReuse, 'running 复用路径没接审计').toContain('auditMysqlConnectionLimit(service, desiredMysqlMaxConnections)');
    expect(beforeWake, 'stopped 唤醒路径没接审计').toContain('auditMysqlConnectionLimit(service, desiredMysqlMaxConnections)');
  });

  it('审计判的是「值够不够」，不是「有没有声明」', () => {
    const source = containerSource();
    const at = source.indexOf('private async auditMysqlConnectionLimit(');
    const fn = source.slice(at, at + 2600);
    // 必须取数值来比较，不能只判存在
    expect(fn).toContain('parseDeclaredMaxConnections(cmd)');
    expect(fn).toContain('declared >= pendingMax');
    // 只判存在的老写法不许回来
    expect(fn).not.toContain('if (declaresMaxConnections(cmd)) return;');
    // 告警要说清当前值，否则运维不知道差多少
    expect(fn).toContain('currentDesc');
  });

  it('红用例：把值比较改回「只判有没有声明」，守卫必须变红', () => {
    const guard = (source: string) => {
      const at = source.indexOf('private async auditMysqlConnectionLimit(');
      expect(at).toBeGreaterThan(-1);
      const fn = source.slice(at, at + 2600);
      expect(fn).toContain('declared >= pendingMax');
    };
    const real = containerSource();
    expectGuardRedOnMutation(
      guard,
      real,
      mutate(real, 'if (declared !== null && declared >= pendingMax) return;', 'if (declared !== null) return;'),
    );
  });

  it('审计读的是容器自己的 Config.Cmd，不是 service 定义（形状 6）', () => {
    const source = containerSource();
    const at = source.indexOf('private async auditMysqlConnectionLimit(');
    expect(at, '找不到 auditMysqlConnectionLimit').toBeGreaterThan(-1);
    const fn = source.slice(at, at + 2200);
    // 真正生效的值只能从运行中的容器读
    expect(fn).toContain('.Config.Cmd');
    expect(fn).toContain('parseDeclaredMaxConnections(cmd)');
    // 判定为未生效时给得出可执行的下一步，而不是只喊一声
    expect(fn).toContain("action: 'infra.mysql.max-connections-pending'");
    expect(fn).toContain('/restart');
    // 不许自动重建：共享 MySQL 重建会掐断所有分支的连接，那是停机不是修复
    expect(fn).not.toContain('docker rm');
    expect(fn).not.toContain('stopInfraService');
  });

  it('红用例：把「已注入」事件挪回计算处，守卫必须变红', () => {
    // 守卫谓词与上面那条绿用例同一个，分别跑真源码与变异源码。
    const guard = (source: string) => {
      const dockerRunAt = source.indexOf('const result = await this.shell.exec(cmd);');
      const appliedAt = source.indexOf("action: 'infra.mysql.max-connections-defaulted'");
      expect(dockerRunAt).toBeGreaterThan(-1);
      expect(appliedAt).toBeGreaterThan(-1);
      expect(appliedAt).toBeGreaterThan(dockerRunAt);
    };
    const real = containerSource();
    // 真做一次搬移：把整个事件块挪回「算出命令」那一行之后。
    const eventStart = real.lastIndexOf('if (mysqlDefaults.injected !== null) {', real.indexOf("action: 'infra.mysql.max-connections-defaulted'"));
    expect(eventStart, '找不到事件块起点').toBeGreaterThan(-1);
    const eventEnd = real.indexOf('\n    }\n', eventStart) + '\n    }\n'.length;
    const eventBlock = real.slice(eventStart, eventEnd);
    expect(eventBlock).toContain("action: 'infra.mysql.max-connections-defaulted'");
    const anchor = 'const resolvedCommand = mysqlDefaults.command;';
    const withoutEvent = real.slice(0, eventStart) + real.slice(eventEnd);
    const insertAt = withoutEvent.indexOf(anchor) + anchor.length + 1;
    const moved = withoutEvent.slice(0, insertAt) + eventBlock + withoutEvent.slice(insertAt);
    expectGuardRedOnMutation(guard, real, moved);
  });

  it('红用例：摘掉复用路径的审计，守卫必须变红', () => {
    const guard = (source: string) => {
      const reuseAt = source.indexOf("action: 'infra.reuse-running'");
      expect(reuseAt).toBeGreaterThan(-1);
      expect(source.slice(Math.max(0, reuseAt - 900), reuseAt))
        .toContain('auditMysqlConnectionLimit(service, desiredMysqlMaxConnections)');
    };
    const real = containerSource();
    expectGuardRedOnMutation(
      guard,
      real,
      mutate(real, 'auditMysqlConnectionLimit(service, desiredMysqlMaxConnections)', 'noopAudit()'),
    );
  });
});
