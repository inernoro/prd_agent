/**
 * 基础设施暴露面自检。
 *
 * ## 为什么单测不够
 *
 * `infra-publish.ts` 那套单测管的是「**新建**容器时怎么拼发布参数」。它管不到两件事：
 *
 * 1. **存量**。端口绑定在容器创建那一刻就固化了，改代码对已经在跑的容器一个都不生效。
 *    仓库全绿，宿主上照样可能有一批裸绑全网卡的库。
 * 2. **别的来路**。手工 `docker run`、compose 导入、别人从宿主直接起的容器，都不经过
 *    CDS 的发布路径，单测再严也扫不到。
 *
 * 所以判据必须取**运行态真值**：`docker ps` 里那串真实端口映射，而不是台账里记的
 * hostPort 数字（那只是个数字，说明不了绑在哪个地址上）。
 *
 * ## 判什么
 *
 * 两个维度的组合决定危险度：**端口对不对外** × **这个库要不要认证**。
 * 「对外 + 无认证」是唯一的 critical——那种库任何人扫到端口就能读能删。
 *
 * ## 未知一律从严
 *
 * 读不到端口映射、认不出镜像类型时，一律按「可能有问题」报，不按「大概没事」放过。
 * 把未知当安全是这类自检最常见的失效方式：它会一直绿，直到出事。
 */

import { isPubliclyPublished } from './infra-publish.js';

export type InfraKind = 'mongo' | 'redis' | 'mysql' | 'postgres' | 'other';

export type ExposureSeverity = 'critical' | 'warn' | 'ok';

export interface InfraExposureInput {
  id: string;
  projectId: string;
  containerName: string;
  dockerImage: string;
  /** 容器自己的环境变量（`.Config.Env`），不是 CDS 台账里那份。 */
  env?: Record<string, string> | null;
  /** 容器启动参数（`.Config.Cmd`）。redis 的 `--requirepass` 常在这里。 */
  args?: readonly string[] | null;
  /**
   * `docker ps --format '{{.Ports}}'` 的原文。读不到时给 undefined——
   * 那会被判成「对外」，因为无从证明它不是。
   */
  runtimePorts?: string | null;
  /** 容器当前是否在跑。停掉的容器不构成暴露面。 */
  running?: boolean;
}

export interface InfraExposureFinding {
  id: string;
  projectId: string;
  containerName: string;
  kind: InfraKind;
  /** 端口是否发布到了对外地址。 */
  publiclyPublished: boolean;
  /** 这个库当前是否配了认证；认不出类型时为 null（未知）。 */
  authenticated: boolean | null;
  severity: ExposureSeverity;
  /** 人话结论，直接进告警正文。 */
  reason: string;
  /** 实际读到的绑定地址，便于核对。 */
  boundHosts: string[];
}

export interface InfraExposureReport {
  findings: InfraExposureFinding[];
  criticalCount: number;
  warnCount: number;
  /** 一句话结论，进日志与站内告警标题。 */
  summary: string;
  /** 只含 critical + warn 的稳定签名，用于「状态没变就不重复告警」。 */
  signature: string;
}

/** 按镜像名判类型。判不出给 other——不猜。 */
export function detectInfraKind(dockerImage: string): InfraKind {
  const l = (dockerImage || '').toLowerCase();
  if (l.includes('mongo')) return 'mongo';
  if (l.includes('redis')) return 'redis';
  if (l.includes('mysql') || l.includes('mariadb')) return 'mysql';
  if (l.includes('postgres') || l.includes('timescale')) return 'postgres';
  return 'other';
}

/**
 * 从 `docker ps` 的端口串里抠出**绑定地址**。
 *
 * 形如 `0.0.0.0:10001->27017/tcp, [::]:10001->27017/tcp` 或
 * `127.0.0.1:10001->27017/tcp`。只有带 `->` 的才是真的发布到宿主了；
 * 裸的 `27017/tcp`（只 EXPOSE 没 publish）不算暴露面。
 */
export function parsePublishedHosts(ports: string | null | undefined): string[] {
  const raw = (ports || '').trim();
  if (!raw) return [];
  const hosts: string[] = [];
  // 捕获 `<host>:<port>->` 里的 host；host 可能是 IPv4、`[::]`、或空（老 docker 写法）
  const re = /(\[[^\]]*\]|[0-9a-fA-F.:]*):\d+->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const h = (m[1] || '').replace(/^\[|\]$/g, '');
    // host 为空等于 docker 省略写法，语义是全部网卡
    hosts.push(h || '0.0.0.0');
  }
  return [...new Set(hosts)];
}

/**
 * 这个库现在有没有认证。
 *
 * ## 判据必须取容器自己的配置，不能取 CDS 台账
 *
 * 台账里的 env 是「CDS 建这个容器时用了什么」，不是「这个容器现在跑成什么样」。
 * 两者会分叉：compose 导入的、手工起的、密码写在**启动参数**里的（redis 的
 * `--requirepass` 就是最常见的一种），台账里都看不到。
 *
 * 真实踩过：某个 redis 台账 env 为空、被判成「无认证 critical」，实际连上去
 * 是 `NOAUTH Authentication required`——它有密码。**一条说「这个库没密码」
 * 的假警报，比不报警更糟**：它会让人开始怀疑整张表，然后连真的那几条也一起忽略。
 *
 * 所以这里同时看两处：容器的 `.Config.Env` 与 `.Config.Cmd`。
 *
 * ## 未知不等于没有
 *
 * 认不出镜像类型时返回 null（未知），**不返回 false**——把「我不知道」和
 * 「我确认没有」混成一个值，报表上就分不清该去查还是该去修。
 */
export function detectInfraAuth(
  kind: InfraKind,
  env?: Record<string, string> | null,
  /** 容器启动参数（`.Config.Cmd`）。密码经常藏在这里而不是 env 里。 */
  args?: readonly string[] | null,
): boolean | null {
  const e = env || {};
  const has = (...keys: string[]): boolean => keys.some((k) => !!(e[k] || '').trim());
  const argLine = (args || []).join(' ').toLowerCase();
  const argHas = (...flags: string[]): boolean => flags.some((f) => argLine.includes(f));
  switch (kind) {
    case 'mongo':
      return has('MONGO_INITDB_ROOT_USERNAME', 'MONGO_USERNAME', 'MONGODB_USERNAME')
        || argHas('--auth', '--keyfile');
    case 'redis':
      // redis 默认不设密码。`--requirepass` 写在启动命令里是最常见的配法，
      // 只看 env 会把它误判成裸奔。
      return has('REDIS_PASSWORD', 'REDIS_PASS', 'REDISCLI_AUTH', 'REDIS_ARGS')
        || argHas('--requirepass', '--user ', 'aclfile');
    case 'mysql':
      return has('MYSQL_ROOT_PASSWORD', 'MYSQL_PASSWORD', 'MARIADB_ROOT_PASSWORD');
    case 'postgres':
      return has('POSTGRES_PASSWORD', 'PGPASSWORD');
    default:
      return null;
  }
}

function describe(f: Omit<InfraExposureFinding, 'reason' | 'severity'>): { severity: ExposureSeverity; reason: string } {
  const where = f.boundHosts.length ? f.boundHosts.join(' / ') : '读不到端口映射';
  if (!f.publiclyPublished) {
    return { severity: 'ok', reason: `端口只绑在 ${where}，宿主之外够不着` };
  }
  if (f.authenticated === false) {
    return {
      severity: 'critical',
      reason: `端口发布在 ${where}（对外可达）且没有配置认证：任何人扫到这个端口就能直接读写这个库`,
    };
  }
  if (f.authenticated === null) {
    return {
      severity: 'warn',
      reason: `端口发布在 ${where}（对外可达），且认不出镜像类型、无法判断有没有认证，需要人工确认`,
    };
  }
  return {
    severity: 'warn',
    reason: `端口发布在 ${where}（对外可达）。已配认证，但没有理由让数据面直接对公网`,
  };
}

/**
 * 跑一遍判定。纯函数——输入是快照，输出是结论，不碰 docker 也不碰网络，
 * 方便用真实事故值写回归。
 */
export function auditInfraExposure(inputs: readonly InfraExposureInput[]): InfraExposureReport {
  const findings: InfraExposureFinding[] = [];
  for (const svc of inputs) {
    // 停掉的容器不占端口，不构成暴露面
    if (svc.running === false) continue;
    const kind = detectInfraKind(svc.dockerImage);
    const boundHosts = parsePublishedHosts(svc.runtimePorts);
    // 没发布任何端口 = 完全不对外，直接跳过（区别于「读不到」）
    if (svc.runtimePorts != null && boundHosts.length === 0) continue;
    const base = {
      id: svc.id,
      projectId: svc.projectId,
      containerName: svc.containerName,
      kind,
      // 读不到映射时 boundHosts 为空 → isPubliclyPublished 判真，从严
      publiclyPublished: isPubliclyPublished(boundHosts),
      authenticated: detectInfraAuth(kind, svc.env, svc.args),
      boundHosts,
    };
    findings.push({ ...base, ...describe(base) });
  }

  const critical = findings.filter((f) => f.severity === 'critical');
  const warn = findings.filter((f) => f.severity === 'warn');
  const summary = critical.length > 0
    ? `${critical.length} 个数据库对外可达且无认证：${critical.map((f) => f.id).join('、')}`
    : warn.length > 0
      ? `${warn.length} 个数据库端口对外可达（已配认证或类型未知）`
      : `全部 ${findings.length} 个基础设施端口都没有对外暴露`;

  return {
    findings,
    criticalCount: critical.length,
    warnCount: warn.length,
    summary,
    // 只把有问题的进签名：ok 项变动不该触发重复告警
    signature: [...critical, ...warn]
      .map((f) => `${f.severity}:${f.projectId}/${f.id}:${f.boundHosts.join(',')}`)
      .sort()
      .join('|'),
  };
}

/** 告警正文。列到具体服务，不给「有若干问题」这种查不下去的话。 */
export function renderExposureReport(report: InfraExposureReport): string {
  const bad = report.findings.filter((f) => f.severity !== 'ok');
  if (bad.length === 0) return report.summary;
  const lines = bad.map((f) => `- [${f.severity}] ${f.projectId}/${f.id}（${f.containerName}）：${f.reason}`);
  return [
    report.summary,
    '',
    ...lines,
    '',
    '端口绑定在容器创建时固化，改配置对存量容器不生效，需要重建对应容器才会落地；',
    '重建有状态服务之前先确认有可用备份。',
  ].join('\n');
}
