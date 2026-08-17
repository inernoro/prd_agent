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

export type InfraKind =
  | 'mongo'
  | 'redis'
  | 'mysql'
  | 'postgres'
  | 'sqlserver'
  | 'clickhouse'
  | 'rabbitmq'
  | 'elasticsearch'
  | 'minio'
  | 'memcached'
  | 'kafka'
  | 'nats'
  | 'other';

export interface InfraKindHints {
  id?: string;
  name?: string;
  basePresetId?: string;
  containerName?: string;
  containerPort?: number;
  runtimePorts?: string | null;
}

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
  /** 端口虽然绑在全网卡，但宿主防火墙挡住了。 */
  firewallBlocked: boolean;
  severity: ExposureSeverity;
  /** 人话结论，直接进告警正文。 */
  reason: string;
  /** 实际读到的绑定地址，便于核对。 */
  boundHosts: string[];
  /** 实际读到的宿主端口。 */
  hostPorts: number[];
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

/**
 * 按实际服务元数据识别数据服务。
 *
 * 私有仓库与摘要镜像的名字可能完全不含产品名，不能只看 image。端口和 CDS 服务
 * 元数据同样是容器创建时真正生效的配置，因此作为有限、可解释的后备判据。
 */
export function detectInfraKind(dockerImage: string, hints: InfraKindHints = {}): InfraKind {
  const labels = [dockerImage, hints.id, hints.name, hints.basePresetId, hints.containerName]
    .map((value) => String(value || '').toLowerCase());
  const includes = (...needles: string[]): boolean => labels.some((label) => (
    needles.some((needle) => label.includes(needle))
  ));
  if (includes('mongo')) return 'mongo';
  if (includes('redis')) return 'redis';
  if (includes('mysql', 'mariadb')) return 'mysql';
  if (includes('postgres', 'timescale')) return 'postgres';
  if (includes('sqlserver', 'mssql')) return 'sqlserver';
  if (includes('clickhouse')) return 'clickhouse';
  if (includes('rabbitmq')) return 'rabbitmq';
  if (includes('elasticsearch', 'opensearch')) return 'elasticsearch';
  if (includes('minio')) return 'minio';
  if (includes('memcached')) return 'memcached';
  if (includes('kafka')) return 'kafka';
  if (includes('nats')) return 'nats';

  const publishedContainerPorts = [...String(hints.runtimePorts || '').matchAll(/->(\d+)\//g)]
    .map((match) => Number(match[1]));
  const ports = new Set([hints.containerPort, ...publishedContainerPorts].filter(Number.isFinite));
  if (ports.has(27017)) return 'mongo';
  if (ports.has(6379)) return 'redis';
  if (ports.has(3306)) return 'mysql';
  if (ports.has(5432)) return 'postgres';
  if (ports.has(1433)) return 'sqlserver';
  if (ports.has(8123) || ports.has(9009)) return 'clickhouse';
  if (ports.has(5672) || ports.has(15672)) return 'rabbitmq';
  if (ports.has(9200)) return 'elasticsearch';
  // 9000 同时被 ClickHouse 原生协议与 MinIO 使用，不能只凭该端口猜类型。
  // MinIO 控制台 9001 没有这个歧义；主端口场景由 image/服务元数据识别。
  if (ports.has(9001)) return 'minio';
  if (ports.has(11211)) return 'memcached';
  if (ports.has(9092)) return 'kafka';
  if (ports.has(4222)) return 'nats';
  return 'other';
}

/**
 * 宿主防火墙对 docker 发布端口的拦截情况。
 *
 * 为什么自检必须看这一层：端口绑在全网卡、但被防火墙挡住，和端口绑在全网卡、
 * 完全裸奔，是**两种危险度**。只看绑定会把前者也报成 critical，报多了就没人看了。
 *
 * 更要紧的是反过来那一半：iptables 规则重启会丢。**规则丢了而绑定没变，
 * 这台机器会在无人知晓的情况下重新变成裸奔**——只看绑定的自检对此完全无感。
 * 把防火墙纳入判据之后，这条自检同时成了「规则还在不在」的哨兵。
 */
export interface FirewallGuard {
  /** 是否存在「公网网卡进来的一律拒绝」的兜底规则。 */
  blanket: boolean;
  /** 被逐个点名拦掉的宿主端口。 */
  ports: Set<number>;
}

export interface FirewallBackendSnapshot {
  name: string;
  /** 该后端工具是否存在。不存在不等于读取失败。 */
  available: boolean;
  /** null 表示连 NAT 运行态都读不到，必须从严。 */
  dockerNatActive: boolean | null;
  /** filter 表是否读取成功。 */
  rulesReadable: boolean;
  rules: string;
}

/**
 * 解析 `iptables -S DOCKER-USER` 的输出。
 *
 * 只认真正生效的形状：入接口是公网网卡且动作是 DROP/REJECT。
 * `-j RETURN`（放行已建立连接那条）不算拦截，混进来会把「没防护」读成「有防护」。
 */
export function parseFirewallGuard(rules: string, publicIface: string): FirewallGuard {
  const guard: FirewallGuard = { blanket: false, ports: new Set() };
  const iface = (publicIface || '').trim();
  if (!iface) return guard;
  const lines = (rules || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const ifacePattern = new RegExp(`-i\\s+${iface}(\\s|$)`);
  const attachedChains = new Set<string>();

  // INPUT/FORWARD 直接按公网接口挂自有链时，链内规则可以不重复写 -i。
  // 迭代展开有限跳转，兼容 DOCKER-USER -> 自有链和多层自有链。
  let changed = true;
  while (changed) {
    changed = false;
    for (const line of lines) {
      const source = line.match(/^-A\s+(\S+)/)?.[1];
      const target = line.match(/-j\s+(\S+)(?:\s|$)/)?.[1];
      if (!source || !target || ['ACCEPT', 'DROP', 'REJECT', 'RETURN'].includes(target)) continue;
      const sourceScoped = ['INPUT', 'FORWARD', 'DOCKER-USER'].includes(source)
        ? ifacePattern.test(line)
        : attachedChains.has(source);
      if (sourceScoped && !attachedChains.has(target)) {
        attachedChains.add(target);
        changed = true;
      }
    }
  }

  for (const l of lines) {
    const chain = l.match(/^-A\s+(\S+)/)?.[1];
    if (!chain) continue;
    const scoped = ifacePattern.test(l) || attachedChains.has(chain);
    if (!scoped) continue;
    if (!/-j\s+(DROP|REJECT)(\s|$)/.test(l)) continue;
    // 数据服务是 TCP。仅有 UDP 的拒绝规则不能冒充数据库端口保护。
    if (/-p\s+udp(?:\s|$)/.test(l)) continue;
    const m = l.match(/--(?:ctorigdstport|dport)\s+(\d+)/);
    if (m) guard.ports.add(Number(m[1]));
    else if (!/--ctorigdstport|--dport/.test(l)) guard.blanket = true;
  }
  return guard;
}

/**
 * 从宿主实际存在的 iptables 后端中选择防护结论。
 * Docker NAT 可能由 nft 或 legacy 承载；任何活跃后端缺少防护都不能判为已拦截。
 */
export function resolveRuntimeFirewallGuard(
  snapshots: readonly FirewallBackendSnapshot[],
  publicIface: string,
): FirewallGuard | null {
  const available = snapshots.filter((snapshot) => snapshot.available);
  if (available.some((snapshot) => snapshot.dockerNatActive === null || !snapshot.rulesReadable)) return null;
  const active = available.filter((snapshot) => snapshot.dockerNatActive === true);
  if (active.length === 0) return null;

  const guards = active.map((snapshot) => parseFirewallGuard(snapshot.rules, publicIface));
  const blanket = guards.every((guard) => guard.blanket);
  const candidates = new Set(guards.flatMap((guard) => [...guard.ports]));
  const ports = new Set([...candidates].filter((port) => (
    guards.every((guard) => guard.blanket || guard.ports.has(port))
  )));
  return { blanket, ports };
}

/** 这些宿主端口是不是都被防火墙挡住了。端口读不出来时按「没挡住」处理。 */
export function isFirewallBlocked(hostPorts: readonly number[], guard?: FirewallGuard | null): boolean {
  if (!guard) return false;
  if (guard.blanket) return true;
  if (hostPorts.length === 0) return false;
  return hostPorts.every((p) => guard.ports.has(p));
}

/** 从 `docker ps` 的端口串里抠出**宿主端口号**（防火墙判据要按端口对） */
export function parsePublishedPorts(ports: string | null | undefined): number[] {
  const out: number[] = [];
  const re = /(?:\[[^\]]*\]|[0-9a-fA-F.:]*):(\d+)->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ports || '')) !== null) out.push(Number(m[1]));
  return [...new Set(out)];
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
 * ## 「有这个 key」不等于「配了认证」
 *
 * 反过来的假阴性同样要防：`REDIS_ARGS` 是 redis-stack 用来塞启动参数的口子，
 * 里面完全可能只有 `--appendonly yes`。把「这个 env 存在」当成认证证据，
 * 一个真裸奔的公网库就会被从 critical 降级，还配上一句「已配置认证」——
 * 比不报警更糟的那种假消息，方向只是反过来（Codex review P1，2026-08-16）。
 *
 * 所以 arg 型 env 只贡献**内容**（并进有效命令行一起扫），不贡献**存在性**；
 * 认证判据一律落到「真的出现了某个生效的认证参数」上。
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
  // 有效命令行 = 容器启动参数 + 那些「本身就是一串启动参数」的 env 的值。
  // 后者只当参数看，不当布尔看。
  const argCarryingEnv = ['REDIS_ARGS', 'REDIS_EXTRA_FLAGS', 'MONGO_EXTRA_FLAGS'];
  const tokens = [
    ...(args || []),
    ...argCarryingEnv.flatMap((k) => (e[k] || '').split(/\s+/)),
  ]
    .map((t) => String(t || '').trim().toLowerCase())
    .filter(Boolean);
  /** 开关型参数：出现即生效（`--auth`）。整 token 比对，避免 `--authenticationdatabase` 撞上。 */
  const hasFlag = (...flags: string[]): boolean => flags.some((f) => tokens.includes(f));
  /**
   * 取值型参数：`--requirepass x` / `--requirepass=x`，**值为空就不算数**。
   * `--requirepass ""` 在 redis 里等于没有密码，它不该把库判成已认证。
   */
  const hasFlagValue = (...flags: string[]): boolean => flags.some((flag) => {
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i];
      if (t === flag) {
        const next = tokens[i + 1];
        if (next && !next.startsWith('--')) return true;
        continue;
      }
      if (t.startsWith(`${flag}=`) && t.slice(flag.length + 1).length > 0) return true;
    }
    return false;
  });
  switch (kind) {
    case 'mongo':
      return (has('MONGO_INITDB_ROOT_USERNAME', 'MONGO_USERNAME', 'MONGODB_USERNAME')
          && has('MONGO_INITDB_ROOT_PASSWORD', 'MONGO_PASSWORD', 'MONGODB_PASSWORD'))
        || hasFlag('--auth')
        || hasFlagValue('--keyfile');
    case 'redis':
      // redis 默认不设密码。`--requirepass` 写在启动命令里是最常见的配法，
      // 只看 env 会把它误判成裸奔。
      return has('REDIS_PASSWORD', 'REDIS_PASS', 'REDISCLI_AUTH')
        || hasFlagValue('--requirepass', '--user', '--aclfile');
    case 'mysql':
      return has('MYSQL_ROOT_PASSWORD', 'MYSQL_PASSWORD', 'MARIADB_ROOT_PASSWORD');
    case 'postgres':
      return has('POSTGRES_PASSWORD', 'PGPASSWORD');
    case 'sqlserver':
      return has('MSSQL_SA_PASSWORD', 'SA_PASSWORD');
    case 'clickhouse':
      return has('CLICKHOUSE_PASSWORD');
    case 'rabbitmq':
      return has('RABBITMQ_DEFAULT_USER') && has('RABBITMQ_DEFAULT_PASS');
    case 'elasticsearch': {
      const security = String(e['xpack.security.enabled'] || e.XPACK_SECURITY_ENABLED || '')
        .trim()
        .toLowerCase();
      return security !== 'false' && has('ELASTIC_PASSWORD');
    }
    case 'minio':
      return has('MINIO_ROOT_USER', 'MINIO_ACCESS_KEY')
        && has('MINIO_ROOT_PASSWORD', 'MINIO_SECRET_KEY');
    case 'memcached':
    case 'kafka':
    case 'nats':
      // CDS 目录尚未给这三类服务启用认证。运行态必须把它们识别为明确无认证，
      // 一旦发布到公网就升为最高级别告警，不能落入 unknown 后降级。
      return false;
    default:
      return null;
  }
}

function describe(f: Omit<InfraExposureFinding, 'reason' | 'severity'>): { severity: ExposureSeverity; reason: string } {
  const where = f.boundHosts.length ? f.boundHosts.join(' / ') : '读不到端口映射';
  if (!f.publiclyPublished) {
    return { severity: 'ok', reason: `端口只绑在 ${where}，宿主之外够不着` };
  }
  // 绑在全网卡但防火墙挡住了：真实可达性等于零，但这份保护是**易失的**——
  // iptables 规则重启就丢，丢了立刻回到裸奔。所以降级到 warn 而不是 ok，
  // 让它一直留在视野里，直到绑定本身被改掉（重建容器）为止。
  if (f.firewallBlocked) {
    const authNote = f.authenticated === false ? '且该库无认证' : '';
    return {
      severity: 'warn',
      reason: `端口绑在 ${where}（全网卡）${authNote}，当前由宿主防火墙挡着。`
        + '防火墙规则重启会丢，丢了立刻恢复暴露；根治要重建容器让绑定地址收窄',
    };
  }
  if (f.authenticated === false) {
    return {
      severity: 'critical',
      reason: `端口发布在 ${where}（对外可达）且没有配置认证：任何人扫到这个端口就能直接读写该服务`,
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
export function auditInfraExposure(
  inputs: readonly InfraExposureInput[],
  opts: { firewall?: FirewallGuard | null } = {},
): InfraExposureReport {
  const findings: InfraExposureFinding[] = [];
  for (const svc of inputs) {
    // 停掉的容器不占端口，不构成暴露面
    if (svc.running === false) continue;
    const kind = detectInfraKind(svc.dockerImage, {
      id: svc.id,
      containerName: svc.containerName,
      runtimePorts: svc.runtimePorts,
    });
    const boundHosts = parsePublishedHosts(svc.runtimePorts);
    // 没发布任何端口 = 完全不对外，直接跳过（区别于「读不到」）
    if (svc.runtimePorts != null && boundHosts.length === 0) continue;
    const hostPorts = parsePublishedPorts(svc.runtimePorts);
    const base = {
      id: svc.id,
      projectId: svc.projectId,
      containerName: svc.containerName,
      kind,
      // 读不到映射时 boundHosts 为空 → isPubliclyPublished 判真，从严
      publiclyPublished: isPubliclyPublished(boundHosts),
      authenticated: detectInfraAuth(kind, svc.env, svc.args),
      firewallBlocked: isFirewallBlocked(hostPorts, opts.firewall),
      boundHosts,
      hostPorts,
    };
    findings.push({ ...base, ...describe(base) });
  }

  const critical = findings.filter((f) => f.severity === 'critical');
  const warn = findings.filter((f) => f.severity === 'warn');
  const shielded = warn.filter((f) => f.firewallBlocked).length;
  const summary = critical.length > 0
    ? `${critical.length} 个基础设施服务对外可达且无认证：${critical.map((f) => f.id).join('、')}`
    : shielded > 0 && shielded === warn.length
      // 说清「靠防火墙挡着」而不是「安全了」：这份保护重启就没，不该读成已解决
      ? `${shielded} 个基础设施端口仍绑在全网卡，当前由宿主防火墙挡着（易失，重建容器才根治）`
      : warn.length > 0
        ? `${warn.length} 个基础设施端口对外可达（其中 ${shielded} 个有防火墙挡着）`
        : `全部 ${findings.length} 个基础设施端口都没有对外暴露`;

  return {
    findings,
    criticalCount: critical.length,
    warnCount: warn.length,
    summary,
    // 只把有问题的进签名：ok 项变动不该触发重复告警
    signature: [...critical, ...warn]
      .map((f) => `${f.severity}:${f.projectId}/${f.id}:${f.boundHosts.join(',')}:${f.hostPorts.join(',')}:firewall=${f.firewallBlocked}`)
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
