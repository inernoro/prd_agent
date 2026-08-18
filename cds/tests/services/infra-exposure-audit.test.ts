import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  auditInfraExposure,
  detectInfraAuth,
  detectInfraKind,
  isFirewallBlocked,
  parseFirewallGuard,
  parsePublishedHosts,
  renderExposureReport,
  resolveRuntimeFirewallGuard,
  type InfraExposureInput,
} from '../../src/services/infra-exposure-audit.js';

/**
 * 基础设施暴露面自检。
 *
 * 这一层存在的理由：`infra-publish` 那套单测只管「新建容器时怎么拼发布参数」，
 * 管不到已经在跑的容器（绑定地址创建时就固化了），也管不到不经 CDS 起的容器。
 * 所以判据取 `docker ps` 的运行态真值，下面每个用例的端口串都用 docker 的**真实
 * 输出格式**，不是编的。
 */

const svc = (o: Partial<InfraExposureInput> & { id: string }): InfraExposureInput => ({
  projectId: 'proj-a',
  containerName: `cds-infra-${o.id}`,
  dockerImage: 'mongo:8.0',
  running: true,
  ...o,
});

describe('端口串解析（docker 的真实输出格式）', () => {
  it('抠出绑定地址，IPv4 与 IPv6 两条算同一个发布', () => {
    expect(parsePublishedHosts('0.0.0.0:10001->27017/tcp, [::]:10001->27017/tcp'))
      .toEqual(['0.0.0.0', '::']);
  });

  it('收窄之后的双绑读得出来', () => {
    expect(parsePublishedHosts('172.17.0.1:10001->27017/tcp, 127.0.0.1:10001->27017/tcp'))
      .toEqual(['172.17.0.1', '127.0.0.1']);
  });

  /** 只 EXPOSE 没 publish 不算暴露面——它压根没占宿主端口。 */
  it('没有 -> 的裸端口不算发布', () => {
    expect(parsePublishedHosts('27017/tcp')).toEqual([]);
    expect(parsePublishedHosts('')).toEqual([]);
    expect(parsePublishedHosts(null)).toEqual([]);
  });

  /** 老 docker 省略地址的写法，语义就是全部网卡，不能当成「没绑」。 */
  it('省略地址的写法按全部网卡处理', () => {
    expect(parsePublishedHosts(':10001->27017/tcp')).toEqual(['0.0.0.0']);
  });
});

describe('认证判定', () => {
  it('认得出 CDS 目录中全部认证型服务的凭据 env', () => {
    expect(detectInfraAuth('mongo', {
      MONGO_INITDB_ROOT_USERNAME: 'app', MONGO_INITDB_ROOT_PASSWORD: 'x',
    })).toBe(true);
    expect(detectInfraAuth('mysql', { MYSQL_ROOT_PASSWORD: 'x' })).toBe(true);
    expect(detectInfraAuth('mysql', {
      MYSQL_RANDOM_ROOT_PASSWORD: 'yes', MYSQL_USER: 'app', MYSQL_PASSWORD: 'x',
    })).toBe(true);
    expect(detectInfraAuth('postgres', { POSTGRES_PASSWORD: 'x' })).toBe(true);
    expect(detectInfraAuth('redis', { REDIS_PASSWORD: 'x' })).toBe(true);
    expect(detectInfraAuth('sqlserver', { MSSQL_SA_PASSWORD: 'x' })).toBe(true);
    expect(detectInfraAuth('clickhouse', { CLICKHOUSE_PASSWORD: 'x' })).toBe(true);
    expect(detectInfraAuth('rabbitmq', {
      RABBITMQ_DEFAULT_USER: 'app', RABBITMQ_DEFAULT_PASS: 'x',
    })).toBe(true);
    expect(detectInfraAuth('elasticsearch', {
      'xpack.security.enabled': 'true', ELASTIC_PASSWORD: 'x',
    })).toBe(true);
    expect(detectInfraAuth('minio', {
      MINIO_ROOT_USER: 'app', MINIO_ROOT_PASSWORD: 'x',
    })).toBe(true);
  });

  it('空 env 判为无认证', () => {
    expect(detectInfraAuth('mongo', {})).toBe(false);
    expect(detectInfraAuth('redis', undefined)).toBe(false);
    expect(detectInfraAuth('mysql', { MYSQL_RANDOM_ROOT_PASSWORD: 'yes' })).toBe(false);
    expect(detectInfraAuth('mysql', { MYSQL_PASSWORD: 'x' })).toBe(false);
    expect(detectInfraAuth('sqlserver', {})).toBe(false);
    expect(detectInfraAuth('clickhouse', {})).toBe(false);
    expect(detectInfraAuth('rabbitmq', {})).toBe(false);
    expect(detectInfraAuth('elasticsearch', {})).toBe(false);
    expect(detectInfraAuth('minio', {})).toBe(false);
    expect(detectInfraAuth('memcached', {})).toBe(false);
    expect(detectInfraAuth('kafka', {})).toBe(false);
    expect(detectInfraAuth('nats', {})).toBe(false);
  });

  /**
   * 「我不知道」和「我确认没有」必须是两个值。混成一个，报表上就分不清
   * 该去查还是该去修。
   */
  it('认不出类型时返回 null 而不是 false', () => {
    expect(detectInfraAuth('other', {})).toBeNull();
    expect(detectInfraKind('some/unknown-image:1')).toBe('other');
  });

  it('不透明镜像按运行态容器名与目标端口识别数据库', () => {
    expect(detectInfraKind('sha256:opaque', { containerName: 'cds-infra-orders-mysql' }))
      .toBe('mysql');
    expect(detectInfraKind('private/image@sha256:opaque', {
      runtimePorts: '0.0.0.0:10001->27017/tcp',
    })).toBe('mongo');

    const report = auditInfraExposure([svc({
      id: 'opaque-db',
      containerName: 'custom-service',
      dockerImage: 'sha256:opaque',
      runtimePorts: '0.0.0.0:10442->3306/tcp',
      env: {},
    })]);
    expect(report.findings[0].kind).toBe('mysql');
    expect(report.findings[0].severity).toBe('critical');
  });

  it('不透明镜像仍按端口识别其他有状态服务', () => {
    const matrix = [
      [1433, 'sqlserver'],
      [8123, 'clickhouse'],
      [5672, 'rabbitmq'],
      [9200, 'elasticsearch'],
      [9001, 'minio'],
      [11211, 'memcached'],
      [9092, 'kafka'],
      [4222, 'nats'],
    ] as const;
    for (const [port, kind] of matrix) {
      expect(detectInfraKind('sha256:opaque', { containerPort: port })).toBe(kind);
    }
    expect(detectInfraKind('sha256:opaque', { containerPort: 9000 })).toBe('other');
    expect(detectInfraKind('sha256:opaque', {
      basePresetId: 'minio', containerPort: 9000,
    })).toBe('minio');
  });

  /**
   * 真实假阳性（2026-08-16）：某 redis 台账 env 为空、被判成「无认证 critical」，
   * 实际连上去是 `NOAUTH Authentication required`——密码写在启动参数里。
   * 一条说「这个库没密码」的假警报比不报警更糟：它让人开始怀疑整张表。
   */
  it('密码写在启动参数里也要认出来（曾经的假阳性）', () => {
    expect(detectInfraAuth('redis', {}, ['redis-server', '--requirepass', 'xxx'])).toBe(true);
    expect(detectInfraAuth('redis', {}, ['sh', '-c', 'redis-server --requirepass xxx'])).toBe(true);
    expect(detectInfraAuth('redis', {}, ['redis-server', '--appendonly', 'yes'])).toBe(false);
    expect(detectInfraAuth('mongo', {}, ['mongod', '--auth'])).toBe(true);
    expect(detectInfraAuth('mongo', {}, ['mongod'])).toBe(false);
  });
});

describe('危险度判定', () => {
  /** 对外 + 无认证 = 任何人扫到端口就能读能删。只有这一种是 critical。 */
  it('对外且无认证判 critical', () => {
    const r = auditInfraExposure([svc({
      id: 'mongodb', runtimePorts: '0.0.0.0:10001->27017/tcp', env: {},
    })]);
    expect(r.criticalCount).toBe(1);
    expect(r.findings[0].severity).toBe('critical');
    expect(r.findings[0].reason).toContain('没有配置认证');
  });

  it('对外但有认证降为 warn（不是 ok）', () => {
    const r = auditInfraExposure([svc({
      id: 'mysql', dockerImage: 'mysql:8', runtimePorts: '0.0.0.0:10442->3306/tcp',
      env: { MYSQL_ROOT_PASSWORD: 'x' },
    })]);
    expect(r.criticalCount).toBe(0);
    expect(r.warnCount).toBe(1);
  });

  it('收窄到网桥 + 回环判 ok', () => {
    const r = auditInfraExposure([svc({
      id: 'mongodb', runtimePorts: '172.17.0.1:10001->27017/tcp, 127.0.0.1:10001->27017/tcp', env: {},
    })]);
    expect(r.criticalCount).toBe(0);
    expect(r.warnCount).toBe(0);
    expect(r.findings[0].severity).toBe('ok');
  });

  /** 读不到映射时不许判成安全——那正是这类自检最常见的失效方式。 */
  it('读不到端口映射按对外处理', () => {
    const r = auditInfraExposure([svc({ id: 'mongodb', runtimePorts: undefined, env: {} })]);
    expect(r.findings[0].publiclyPublished).toBe(true);
    expect(r.criticalCount).toBe(1);
  });

  /** 明确读到「没发布任何端口」与「读不到」是两回事，前者直接不成立。 */
  it('明确没有发布端口的容器不进报告', () => {
    expect(auditInfraExposure([svc({ id: 'mongodb', runtimePorts: '27017/tcp', env: {} })]).findings)
      .toHaveLength(0);
  });

  it('停掉的容器不构成暴露面', () => {
    const r = auditInfraExposure([svc({
      id: 'mongodb', running: false, runtimePorts: '0.0.0.0:10001->27017/tcp', env: {},
    })]);
    expect(r.findings).toHaveLength(0);
  });

  it('IPv6 全网卡与 IPv4 一样算对外', () => {
    const r = auditInfraExposure([svc({ id: 'redis', dockerImage: 'redis:7-alpine', runtimePorts: '[::]:10002->6379/tcp', env: {} })]);
    expect(r.criticalCount).toBe(1);
  });
});

describe('报告可读性', () => {
  const report = auditInfraExposure([
    svc({ id: 'mongodb', runtimePorts: '0.0.0.0:10001->27017/tcp', env: {} }),
    svc({ id: 'redis', dockerImage: 'redis:7-alpine', runtimePorts: '0.0.0.0:10002->6379/tcp', env: {} }),
    svc({ id: 'safe', runtimePorts: '127.0.0.1:10003->27017/tcp', env: {} }),
  ]);

  it('结论点名到具体服务，不给「有若干问题」这种查不下去的话', () => {
    expect(report.summary).toContain('mongodb');
    expect(report.summary).toContain('redis');
    const body = renderExposureReport(report);
    expect(body).toContain('cds-infra-mongodb');
    // 干净的那个不该出现在告警正文里，避免淹掉真问题
    expect(body).not.toContain('cds-infra-safe');
  });

  it('正文写明存量容器要重建才生效，以及重建前先确认备份', () => {
    const body = renderExposureReport(report);
    expect(body).toContain('重建');
    expect(body).toContain('备份');
  });

  /** 签名只含有问题的项：ok 项变动不该把同一条告警重复推一遍。 */
  it('签名对 ok 项的变化不敏感，对危险项的变化敏感', () => {
    const a = auditInfraExposure([
      svc({ id: 'mongodb', runtimePorts: '0.0.0.0:10001->27017/tcp', env: {} }),
      svc({ id: 'safe', runtimePorts: '127.0.0.1:1->2/tcp', env: {} }),
    ]);
    const b = auditInfraExposure([
      svc({ id: 'mongodb', runtimePorts: '0.0.0.0:10001->27017/tcp', env: {} }),
    ]);
    expect(a.signature).toBe(b.signature);

    const c = auditInfraExposure([
      svc({ id: 'mongodb', runtimePorts: '172.17.0.1:10001->27017/tcp', env: {} }),
    ]);
    expect(c.signature).not.toBe(b.signature);
  });

  it('全部干净时给出正面结论而不是空字符串', () => {
    const clean = auditInfraExposure([svc({ id: 'mongodb', runtimePorts: '127.0.0.1:10001->27017/tcp', env: {} })]);
    expect(clean.summary).toContain('没有对外暴露');
    expect(renderExposureReport(clean)).toBe(clean.summary);
  });
});

/**
 * 接线守卫。判据写好没人调用，是本仓库反复栽的形状——尤其这种「不报警就等于没事」
 * 的后台自检，没接上线时的表现和一切正常一模一样。
 */
describe('自检真的被启动了', () => {
  const SRC = fs.readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');
  /**
   * 按**行**剥注释，不用 `/\*[\s\S]*?\*\/` 这种跨行正则。
   *
   * 后者会被源码里带 `/*` 或 `*​/` 的字符串与正则字面量带偏，一旦错位就会连真代码
   * 一起吞掉——判据于是读着一份残缺的源码做断言，报出来的红是假的、绿也是假的。
   * 按行只丢「整行都是注释」的行，永远不会误删代码行。
   */
  const CODE = SRC.split('\n')
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'));
    })
    .join('\n');

  it('index.ts 启动了周期自检', () => {
    expect(CODE).toContain('startInfraExposureAudit(');
    expect(CODE).toMatch(/const\s+infraExposureAudit\s*=\s*startInfraExposureAudit\(/);
  });

  it('判据取 docker ps 的运行态真值，不是读台账里的 hostPort', () => {
    expect(CODE).toMatch(/docker ps -a --format/);
    expect(CODE).toContain('auditInfraExposure(');
    // 台账不能拿来当端口来源
    expect(CODE).not.toMatch(/runtimePorts:\s*String\(svc\.hostPort\)/);
  });

  /**
   * 认证判据同样必须取容器自己的配置。照台账判会把密码写在启动参数里的库
   * 误报成裸奔——这条守卫钉住「台账只用来补 id/projectId，不用来判认证」。
   */
  it('认证判据取容器自己的 env 与启动参数，不取台账', () => {
    expect(CODE).toMatch(/docker inspect --format[\s\S]{0,120}Config\.Env/);
    expect(CODE).toMatch(/Config\.Cmd/);
    // 台账那张表只留 id 与 projectId，不再带 env
    expect(CODE).toMatch(/byContainer\.set\(svc\.containerName,\s*\{\s*id:[^}]*projectId:[^}]*\}\)/);
    expect(CODE).not.toMatch(/byContainer\.set\([^)]*env:\s*svc\.env/);
  });

  it('发现问题时按 error 级记事件，不是只 console 一下', () => {
    expect(CODE).toContain("action: 'infra.exposure.detected'");
    expect(CODE).toContain('renderExposureReport(');
  });
});

/**
 * 宿主防火墙纳入判据。
 *
 * 两个方向都要守：
 * 1. 绑在全网卡但被防火墙挡住的，不该报成 critical——报多了就没人看了。
 * 2. **规则一旦丢失（iptables 重启即丢）必须立刻升回 critical**。只看容器绑定的
 *    自检对「防火墙没了」完全无感，那正是这台机器最现实的退化路径。
 */
describe('防火墙纳入判据', () => {
  const RULES_BLANKET = [
    '-N DOCKER-USER',
    '-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN',
    '-A DOCKER-USER -i eth0 -j DROP',
  ].join('\n');
  const RULES_PERPORT = [
    '-N DOCKER-USER',
    '-A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 10001 -j DROP',
    '-A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 10002 -j DROP',
  ].join('\n');

  it('认得出兜底拦截与逐端口拦截', () => {
    expect(parseFirewallGuard(RULES_BLANKET, 'eth0').blanket).toBe(true);
    const g = parseFirewallGuard(RULES_PERPORT, 'eth0');
    expect(g.blanket).toBe(false);
    expect([...g.ports].sort()).toEqual([10001, 10002]);
  });

  it('认得出 INPUT/FORWARD 按公网接口挂载的自有保护链', () => {
    const legacyRules = [
      '-A INPUT -i eth0 -j CDS-PUBLIC-INPUT',
      '-A CDS-PUBLIC-INPUT -p tcp -m conntrack --ctstate NEW -j DROP',
      '-A FORWARD -i eth0 -j CDS-PUBLIC-FORWARD',
      '-A CDS-PUBLIC-FORWARD -p tcp -m conntrack --ctstate NEW -j DROP',
    ].join('\n');
    expect(parseFirewallGuard(legacyRules, 'eth0').blanket).toBe(true);
  });

  it('Docker 活跃后端有一个未保护时从严，不被另一套后端的绿灯掩盖', () => {
    const firewall = resolveRuntimeFirewallGuard([
      { name: 'iptables-nft', available: true, dockerNatActive: true, rulesReadable: true, rules: RULES_BLANKET },
      { name: 'iptables-legacy', available: true, dockerNatActive: true, rulesReadable: true, rules: '-P INPUT ACCEPT' },
    ], 'eth0');
    expect(isFirewallBlocked([10001], firewall)).toBe(false);
  });

  it('所有活跃 Docker 后端都保护时才认定端口已拦截', () => {
    const firewall = resolveRuntimeFirewallGuard([
      { name: 'iptables-nft', available: true, dockerNatActive: true, rulesReadable: true, rules: RULES_BLANKET },
      { name: 'iptables-legacy', available: true, dockerNatActive: true, rulesReadable: true, rules: RULES_PERPORT },
    ], 'eth0');
    expect(isFirewallBlocked([10001], firewall)).toBe(true);
    expect(isFirewallBlocked([10002], firewall)).toBe(true);
    expect(isFirewallBlocked([10003], firewall)).toBe(false);
  });

  it('活跃后端读取失败时返回未知，不把未知当安全', () => {
    expect(resolveRuntimeFirewallGuard([
      { name: 'iptables-legacy', available: true, dockerNatActive: true, rulesReadable: false, rules: '' },
    ], 'eth0')).toBeNull();
  });

  /** RETURN 是放行已建立连接，不是拦截。混进来会把「没防护」读成「有防护」。 */
  it('RETURN 不算拦截', () => {
    expect(parseFirewallGuard('-A DOCKER-USER -i eth0 -j RETURN', 'eth0').blanket).toBe(false);
  });

  it('网卡对不上的规则不算数', () => {
    expect(parseFirewallGuard(RULES_BLANKET, 'ens3').blanket).toBe(false);
  });

  it('端口读不出来时不敢认作已挡住', () => {
    expect(isFirewallBlocked([], parseFirewallGuard(RULES_PERPORT, 'eth0'))).toBe(false);
    expect(isFirewallBlocked([10001], null)).toBe(false);
  });

  it('挡住了就从 critical 降到 warn，但绝不降到 ok', () => {
    const input = [svc({ id: 'mongodb', runtimePorts: '0.0.0.0:10001->27017/tcp', env: {} })];
    const guarded = auditInfraExposure(input, { firewall: parseFirewallGuard(RULES_PERPORT, 'eth0') });
    expect(guarded.criticalCount).toBe(0);
    expect(guarded.findings[0].severity).toBe('warn');
    expect(guarded.findings[0].firewallBlocked).toBe(true);
    expect(guarded.summary).toContain('防火墙');
    // 结论不能读成「已解决」：这份保护是易失的
    expect(guarded.summary).toContain('易失');
  });

  /** 这条是本次事故最现实的退化路径：服务器重启 → 规则没了 → 无声回到裸奔。 */
  it('规则消失后立刻升回 critical，且签名变化会触发新告警', () => {
    const input = [svc({ id: 'mongodb', runtimePorts: '0.0.0.0:10001->27017/tcp', env: {} })];
    const guarded = auditInfraExposure(input, { firewall: parseFirewallGuard(RULES_PERPORT, 'eth0') });
    const lost = auditInfraExposure(input, { firewall: parseFirewallGuard('-N DOCKER-USER', 'eth0') });
    expect(lost.criticalCount).toBe(1);
    expect(lost.signature).not.toBe(guarded.signature);
  });

  it('兜底拦截覆盖所有端口', () => {
    const input = [
      svc({ id: 'mongodb', runtimePorts: '0.0.0.0:10001->27017/tcp', env: {} }),
      svc({ id: 'redis', dockerImage: 'redis:7-alpine', runtimePorts: '0.0.0.0:59999->6379/tcp', env: {} }),
    ];
    const r = auditInfraExposure(input, { firewall: parseFirewallGuard(RULES_BLANKET, 'eth0') });
    expect(r.criticalCount).toBe(0);
    expect(r.findings.every((f) => f.firewallBlocked)).toBe(true);
  });

  it('自检真的去读了防火墙，不是只看容器绑定', () => {
    const SRC = fs.readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');
    const CODE = SRC.split('\n')
      .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')); })
      .join('\n');
    expect(CODE).toContain("['iptables-nft', 'iptables-legacy']");
    expect(CODE).toContain('resolveRuntimeFirewallGuard(');
    expect(CODE).toMatch(/auditInfraExposure\(inputs,\s*\{\s*firewall\s*\}\)/);
  });
});

/**
 * 假阴性方向的判据（Codex review P1，2026-08-16）。
 *
 * 上一轮补的是假阳性：密码写在启动参数里，被判成裸奔。补的时候顺手把
 * `REDIS_ARGS` 当成了「有这个 key 就等于配了认证」——而它只是 redis-stack 用来塞
 * 启动参数的口子，里面完全可能只有 `--appendonly yes`。于是方向反过来的假消息出现了：
 * 一个真裸奔的公网库被从 critical 降级，报表上还写着「已配置认证」。
 */
describe('认证判定：有这个 key 不等于配了认证', () => {
  it('REDIS_ARGS 里没有认证参数时，判为无认证', () => {
    expect(detectInfraAuth('redis', { REDIS_ARGS: '--appendonly yes' })).toBe(false);
    expect(detectInfraAuth('redis', { REDIS_ARGS: '' })).toBe(false);
  });

  it('REDIS_ARGS 里真有 --requirepass 时，判为已认证', () => {
    expect(detectInfraAuth('redis', { REDIS_ARGS: '--appendonly yes --requirepass s3cret' })).toBe(true);
    expect(detectInfraAuth('redis', { REDIS_ARGS: '--requirepass=s3cret' })).toBe(true);
    expect(detectInfraAuth('redis', { REDIS_ARGS: '--aclfile /etc/redis/users.acl' })).toBe(true);
  });

  /** `--requirepass ""` 在 redis 里等于没有密码，不能把它算成认证。 */
  it('取值型参数的值为空时不算认证', () => {
    expect(detectInfraAuth('redis', {}, ['redis-server', '--requirepass'])).toBe(false);
    expect(detectInfraAuth('redis', {}, ['redis-server', '--requirepass', ''])).toBe(false);
    expect(detectInfraAuth('redis', {}, ['redis-server', '--requirepass', '--appendonly'])).toBe(false);
    expect(detectInfraAuth('redis', {}, ['redis-server', '--requirepass', 'x'])).toBe(true);
  });

  /** 子串匹配会让 `--authenticationDatabase` 冒充 `--auth`。整 token 比对才不会。 */
  it('mongo 的 --auth 按整个 token 比，不吃子串', () => {
    expect(detectInfraAuth('mongo', {}, ['mongosh', '--authenticationDatabase', 'admin'])).toBe(false);
    expect(detectInfraAuth('mongo', {}, ['mongod', '--auth'])).toBe(true);
    expect(detectInfraAuth('mongo', {}, ['mongod', '--keyfile', '/etc/key'])).toBe(true);
    expect(detectInfraAuth('mongo', {}, ['mongod', '--keyfile'])).toBe(false);
  });
});
