/**
 * CDS 自身的 HTTP 监听地址。
 *
 * ## 为什么需要这个模块
 *
 * `server.listen(port, cb)` 不给 host 参数时，Node 绑的是全部网卡——CDS 的控制面
 * API 直接挂在公网的裸端口上，绕过前面那层 nginx（以及 nginx 上的 TLS、限流、
 * 访问日志与任何 CDN 侧防护）。单机部署里没有任何人需要这个裸端口：nginx 走宿主
 * 网络、反代的 upstream 就是 `127.0.0.1:<port>`。
 *
 * 与 infra 端口那一层（services/infra-publish.ts）不同的是，这里是**宿主进程自己
 * 的监听**，走 `INPUT` 链，普通防火墙能覆盖到。但「能被防火墙覆盖」不等于「已经
 * 被覆盖」，默认值该是安全的那个。
 *
 * ## 为什么不能无条件绑回环
 *
 * 集群模式下这些端口是**要**被别的机器访问的：
 *
 * - executor 节点自己起的服务，master 要连过去派活
 * - master 节点，远端 executor 要连过来注册（`CDS_MASTER_URL` 指的就是它）
 *
 * 所以默认值必须**看部署形态**：单机绑回环，一旦出现集群角色就自动放开并说明
 * 原因。把「配置写了但在这套部署里根本不成立」当成保护，是最容易骗过自己的一种
 * 假安全。
 *
 * ## 逃生阀
 *
 * `CDS_BIND_HOST` 显式覆盖，优先级最高。直接用 IP:端口 访问面板（前面没有 nginx）
 * 的部署，把它设成 `0.0.0.0` 即可。
 */

/** 单机部署的默认监听地址。 */
export const DEFAULT_BIND_HOST = '127.0.0.1';

/** 全部网卡。 */
export const ALL_INTERFACES_HOST = '0.0.0.0';

/** 覆盖监听地址的环境变量名。 */
export const BIND_HOST_ENV = 'CDS_BIND_HOST';

export interface ListenHostInputs {
  /** `config.mode`：standalone / scheduler / executor。 */
  mode?: string;
  /** 已注册的远端 executor 数量（本机自己的不算）。 */
  remoteExecutorCount?: number;
  /** 已配置的 CDS 对等节点数量。 */
  peerCount?: number;
  /** 供测试注入。 */
  processEnv?: Record<string, string | undefined>;
}

export interface ListenHostDecision {
  host: string;
  /** 为什么是这个地址。启动日志原样打出来，免得下一个人对着 connection refused 猜。 */
  reason: string;
  /** 是否对外可达。守卫与启动日志用这个判，不要自己再比字符串。 */
  exposed: boolean;
}

/** 判定一个监听地址是不是「全部网卡」。空值按对外处理——未知不当安全。 */
export function isExposedHost(host: string | undefined | null): boolean {
  const h = (host || '').trim();
  if (!h) return true;
  return h === '0.0.0.0' || h === '::' || h === '*';
}

/**
 * 算出 CDS 自身该监听在哪个地址上。
 *
 * 优先级：显式 `CDS_BIND_HOST` > 集群角色自动放开 > 默认回环。
 */
export function resolveListenHost(inputs: ListenHostInputs = {}): ListenHostDecision {
  const env = inputs.processEnv ?? process.env;
  const explicit = (env[BIND_HOST_ENV] || '').trim();
  if (explicit) {
    return {
      host: explicit,
      reason: `${BIND_HOST_ENV} 显式指定`,
      exposed: isExposedHost(explicit),
    };
  }

  // 集群角色必须被别的机器访问到。这里放开不是妥协，是这套部署的真实需要；
  // 真正该收的是那种「单机 + nginx 在前，却把控制面裸端口挂在公网」的默认。
  if (inputs.mode === 'executor') {
    return {
      host: ALL_INTERFACES_HOST,
      reason: 'executor 模式：master 需要从网络连到本节点派活',
      exposed: true,
    };
  }
  const remote = inputs.remoteExecutorCount ?? 0;
  const peers = inputs.peerCount ?? 0;
  if (remote > 0 || peers > 0) {
    return {
      host: ALL_INTERFACES_HOST,
      reason: `已配置集群成员（远端 executor ${remote} 个 / 对等节点 ${peers} 个），它们需要连到本节点`,
      exposed: true,
    };
  }

  return {
    host: DEFAULT_BIND_HOST,
    reason: `单机部署：只监听回环，对外访问走前置 nginx（需要裸端口直连请设 ${BIND_HOST_ENV}=${ALL_INTERFACES_HOST}）`,
    exposed: false,
  };
}

/** 启动日志用的一行说明。监听地址永远不该靠猜。 */
export function describeListenDecision(d: ListenHostDecision): string {
  return `监听地址 ${d.host}（${d.reason}）`;
}
