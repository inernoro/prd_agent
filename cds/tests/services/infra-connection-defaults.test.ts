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
  resolveConfiguredMysqlMaxConnections,
} from '../../src/services/infra-connection-defaults.js';

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
    const source = fs.readFileSync(path.join(CDS_ROOT, 'src/services/container.ts'), 'utf8');
    const at = source.indexOf('const resolvedCommandRaw = resolveCommandTemplate(service.command');
    const stripped = source.slice(at, at + 1200).replace(/applyMysqlConnectionDefaults\(/g, 'noop(');
    expect(stripped).not.toContain('applyMysqlConnectionDefaults(');
  });
});
