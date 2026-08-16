/**
 * 基础设施容器的宿主端口该发布在哪几个地址上。
 *
 * ## 为什么需要这个模块
 *
 * `docker run -p <hostPort>:<containerPort>` 省略绑定地址时，Docker 绑的是
 * `0.0.0.0`——**宿主机的每一张网卡，包括公网网卡**。CDS 给每个 infra 服务分配一个
 * 宿主端口本来只是为了让容器之间能通过网桥地址互访，却顺带把 MongoDB / Redis /
 * MySQL 这些数据面直接挂到了公网上。
 *
 * 更麻烦的是这一层**普通防火墙挡不住**：Docker 发布的端口经 nat PREROUTING 的
 * DNAT 改写后走 `FORWARD` 链，根本不经过 `INPUT`。所以宿主上配了默认拒绝的
 * iptables / ufw 规则，这些端口照样对全网开着——运维看着「防火墙已开」，实际一个
 * 数据库都没挡住。这是 Docker + iptables 的经典坑，也是本模块存在的理由：
 * **不依赖宿主防火墙，在发布这一步就把地址收窄。**
 *
 * ## 为什么默认不是 127.0.0.1
 *
 * 直觉上「只绑回环」最安全，但那会把 CDS 整个打死：应用容器拿到的连接串是
 * `mongodb://${CDS_HOST}:${port}`，而 `CDS_HOST` 是 **docker 网桥地址**
 * （默认 172.17.0.1）。容器访问不到宿主的 loopback，绑上去等于全线断库。
 *
 * 正确的解是绑在「消费方实际使用的那个地址」上：
 *
 * - `<网桥地址>`：宿主上任意 docker 网络里的容器都能经网桥 IP 连到
 * - `127.0.0.1`：宿主本机的 CLI 与数据工作台走这条
 *
 * 两个都不是对外地址，宿主之外够不着。同样的论证与取舍在
 * `replica-db-clone.ts` 的专用隔离实例上已经落过一次，这里是把它推广到全部
 * infra 服务，并收敛成唯一一份判定。
 *
 * ## 逃生阀
 *
 * `CDS_INFRA_PUBLISH_HOST` 可覆盖，逗号分隔多个地址；填 `0.0.0.0`（或 `*`）
 * 恢复「发布到全部网卡」的旧行为。**这个值等于把数据面挂上公网，只应在确知
 * 宿主处于受控内网时使用。**
 *
 * ## 不在本模块管辖范围内的东西
 *
 * 「资源公网 TCP 访问」那条路径是**有意**的对外暴露，且已经强制要求非空 IP
 * allowlist + iptables 兜底（见 `routes/branches.ts` 的
 * `applyResourceExternalFirewall`）。它自己拼 `-p 0.0.0.0:<port>`，不走这里，
 * 也不该被这里收窄——那会破坏功能而不提升安全。
 */

/** Docker 默认网桥地址。CDS 各处「宿主在容器里长什么样」的兜底值。 */
export const DEFAULT_DOCKER_BRIDGE_HOST = '172.17.0.1';

/** 覆盖 infra 端口发布地址的系统级环境变量名。 */
export const INFRA_PUBLISH_HOST_ENV = 'CDS_INFRA_PUBLISH_HOST';

/** 表示「发布到全部网卡」的两种写法。 */
const ALL_INTERFACES = new Set(['0.0.0.0', '*', '::']);

/** 保序去重。同一地址绑两次 docker 会报端口占用。 */
function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export interface DockerBridgeHostSources {
  /** CDS 全局作用域的 customEnv（`_global`）。优先级最高。 */
  globalEnv?: Record<string, string | undefined> | null;
  /** 进程环境变量。 */
  processEnv?: Record<string, string | undefined>;
}

/**
 * 解析 docker 网桥地址（即容器眼里的「宿主」）。
 *
 * 优先级：全局 customEnv.CDS_DOCKER_HOST > process.env.CDS_DOCKER_HOST > 默认。
 * 这份判定此前散落在 StateService 与 ReplicaSetService 两处，各写各的；收敛到
 * 这里，避免「改一处漏一处」导致注入的连接串与实际绑定地址对不上——那种错法
 * 编译过、测试绿，只有真连库时才炸。
 */
export function resolveDockerBridgeHost(sources: DockerBridgeHostSources = {}): string {
  const fromGlobal = sources.globalEnv?.['CDS_DOCKER_HOST'];
  const fromProcess = (sources.processEnv ?? process.env)['CDS_DOCKER_HOST'];
  const picked = (fromGlobal || fromProcess || '').trim();
  return picked || DEFAULT_DOCKER_BRIDGE_HOST;
}

export interface InfraPublishHostOptions {
  /** 网桥地址；不传则按 `resolveDockerBridgeHost` 解析。 */
  bridgeHost?: string;
  /** `CDS_INFRA_PUBLISH_HOST` 的原始值；不传则读 process.env。 */
  override?: string | null;
  /** 供测试注入。 */
  processEnv?: Record<string, string | undefined>;
}

/**
 * 算出 infra 端口该绑在哪几个地址上。
 *
 * 默认 `[<网桥地址>, '127.0.0.1']`；两者相同时去重（有人把 CDS_DOCKER_HOST
 * 直接设成 127.0.0.1 的话，重复绑同一地址 docker 会报端口占用）。
 */
export function resolveInfraPublishHosts(opts: InfraPublishHostOptions = {}): string[] {
  const env = opts.processEnv ?? process.env;
  const raw = (opts.override ?? env[INFRA_PUBLISH_HOST_ENV] ?? '').trim();
  if (raw) {
    const parsed = raw.split(',').map((h) => h.trim()).filter(Boolean);
    if (parsed.length > 0) return dedupe(parsed);
  }
  const bridge = opts.bridgeHost?.trim() || resolveDockerBridgeHost({ processEnv: env });
  return dedupe([bridge, '127.0.0.1']);
}

/**
 * 这组绑定地址是不是「对外可达」。
 *
 * 守卫用的判据：只要含 `0.0.0.0` / `*` / `::` 就是发布到全部网卡。空数组同样
 * 判真——`-p <port>:<port>` 不带地址正是 Docker 绑全网卡的写法，把「没算出地址」
 * 当成安全是最危险的默认。
 */
export function isPubliclyPublished(hosts: readonly string[]): boolean {
  if (hosts.length === 0) return true;
  return hosts.some((h) => ALL_INTERFACES.has(h.trim()));
}

/**
 * 拼出 `docker run` 的 `-p` 参数。
 *
 * 返回**已拼好的字符串数组**（形如 `-p 172.17.0.1:10001:27017`），调用方直接
 * 塞进命令数组即可。多个地址就是多条 `-p`，Docker 支持同一宿主端口绑在不同
 * 地址上。
 *
 * `hosts` 里出现全网卡地址时退化成不带地址的 `-p <host>:<container>`——保持与
 * 逃生阀语义一致（用户显式要全网卡就给他全网卡），而不是拼出
 * `-p 0.0.0.0:x:y` 这种同义但不同形状的写法，让守卫只需要认一种形状。
 */
export function buildInfraPublishFlags(
  hostPort: number | string,
  containerPort: number | string,
  hosts: readonly string[],
): string[] {
  if (isPubliclyPublished(hosts)) {
    return [`-p ${hostPort}:${containerPort}`];
  }
  return hosts.map((h) => `-p ${h}:${hostPort}:${containerPort}`);
}

/** docker 报「地址分配不出来」时的特征串。不同 docker 版本措辞不同，都收进来。 */
const BIND_FAILURE_MARKERS = [
  'cannot assign requested address',
  'bind: address not available',
  'error while creating mount source path',
  'invalid ip address',
];

/**
 * 绑定地址不存在导致 docker run 失败时，补一条能照着做的中文归因。
 *
 * 这类失败的报错原文只有一句英文的 "cannot assign requested address"，看不出
 * 是绑定地址收窄引起的，更看不出该往哪改。宿主没有 docker0（自定义网桥、
 * 或 CDS 跑在非 Docker 宿主上）就会撞上。
 *
 * 判据只看**错误原文**，不看 hosts 本身——hosts 合法但地址在这台机上不存在，
 * 才是这条提示要覆盖的场景。
 */
export function infraPublishBindHint(output: string, hosts: readonly string[]): string {
  const lower = (output || '').toLowerCase();
  if (!BIND_FAILURE_MARKERS.some((m) => lower.includes(m))) return '';
  if (isPubliclyPublished(hosts)) return '';
  return `

提示：本次把端口绑在 ${hosts.join(' / ')} 上，这台宿主可能没有其中某个地址。
排查：\`ip -o -4 addr show\` 看 docker 网桥的真实地址；若网桥不是默认的
${DEFAULT_DOCKER_BRIDGE_HOST}，把全局变量 CDS_DOCKER_HOST 设成实际地址即可。
临时放开可设 ${INFRA_PUBLISH_HOST_ENV}=0.0.0.0 恢复绑全部网卡，但那会把数据面
挂到宿主的每一张网卡上（含公网），只应在确知宿主处于受控内网时使用。`;
}
