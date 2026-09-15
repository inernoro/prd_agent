/**
 * map-notifier — 把存活监控的状态翻转送进 MAP 站内通知。
 *
 * 为什么要有它：uptime-monitor 的 onAlert 目前只 publish 到 cdsEventsBus，
 * 也就是「告警躺在 CDS 自己的台账里，没人打开状态页就等于没发生」。
 * 铃要响在人会看的地方——MAP 的站内通知（规则 degradation-must-alarm 层 4）。
 *
 * 为什么不自己造一套鉴权：MAP 早就有一条给外部系统用的签名通道，
 * stable-smoke 正在用它（POST /api/dashboard/notifications/events，
 * StableSmokeAuthenticationHandler：RSA-PSS 签名 + nonce 防重放 + 认证后自动开号，
 * 且强制发给配置好的固定账号、禁止全局通知）。这里接同一条路，只换一个 source。
 * 好处是「配对关系永久，过期的只是单次签名」——不需要隔三差五重新配一次。
 *
 * 纯函数（canonical 构造 / 载荷映射 / 配置解析）与副作用（真发 HTTP）分开放，
 * 前者全部有单测，后者只在告警发生时被调用。
 */

import crypto from 'node:crypto';

/** 与 MAP 的 StableSmokeAuthenticationHandler 对齐的请求头名。 */
export const HEADER_KEY_ID = 'X-Stable-Smoke-Key-Id';
export const HEADER_TIMESTAMP = 'X-Stable-Smoke-Timestamp';
export const HEADER_NONCE = 'X-Stable-Smoke-Nonce';
export const HEADER_SIGNATURE = 'X-Stable-Smoke-Signature';

/** MAP 侧允许的时钟偏移是 ±120s，这里留足余量但不放宽判据。 */
export const DEFAULT_TIMEOUT_MS = 10_000;

export interface MapNotifierConfig {
  /** 完整端点，例如 https://map.example.com/api/dashboard/notifications/events */
  endpoint: string;
  keyId: string;
  /** 必须与 MAP 配置里该 keyId 条目的 Username 一致——它进签名载荷。 */
  username: string;
  /** PKCS#8 私钥 PEM。公钥在 MAP 配置里，私钥只留在 CDS，不过网络。 */
  privateKeyPem: string;
  timeoutMs?: number;
}

export interface MapNotifierAlert {
  type: 'uptime.target.down' | 'uptime.target.recovered';
  targetId: string;
  targetName: string;
  projectId?: string;
  branchId?: string;
  probeUrl?: string;
  message: string;
  consecutiveFailures: number;
  detectedAt: string;
}

export interface MapNotificationPayload {
  source: string;
  title: string;
  message: string;
  level: string;
  section: string;
  dedupKey: string;
  actionLabel?: string;
  actionUrl?: string;
}

/**
 * 与 MAP 的 BuildCanonicalRequest **逐字节对齐**：
 *   METHOD \n path \n timestamp \n nonce \n username \n sha256hex(body)
 *
 * SSOT 是 C# 那一份（StableSmokeAuthenticationHandler.BuildCanonicalRequest）。
 * 这里是它在 Node 侧的第二实现——判据分裂的典型温床，所以两侧都有测试钉住格式，
 * 任一侧改了格式，另一侧的用例必须同步改（predicate-and-wiring-discipline 形状 3）。
 */
export function buildCanonicalRequest(
  method: string,
  path: string,
  timestamp: number,
  nonce: string,
  username: string,
  body: string,
): string {
  const bodyHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  return [method.toUpperCase(), path, String(timestamp), nonce, username, bodyHash].join('\n');
}

/**
 * RSA-PSS + SHA256，salt 长度取摘要长度——对应 .NET 的 RSASignaturePadding.Pss 默认值。
 * 用 PKCS#1 v1.5 或别的 salt 长度都会在 MAP 侧静默判成 invalid_signature。
 */
export function signCanonical(privateKeyPem: string, canonical: string): string {
  const signature = crypto.sign('sha256', Buffer.from(canonical, 'utf8'), {
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return signature.toString('base64');
}

/**
 * 告警 → 通知载荷。
 *
 * 正文写「症状 + 下一步」，不写堆栈：站内通知是给人看的，堆栈进容器日志。
 * dedupKey 用 targetId + 翻转方向 + 检测时刻，同一次翻转重复投递不会刷屏；
 * 不同次翻转（掉线→恢复→再掉线）是不同的键，不会被误合并。
 */
export function buildNotificationPayload(alert: MapNotifierAlert): MapNotificationPayload {
  const down = alert.type === 'uptime.target.down';
  const scope = [alert.projectId, alert.branchId].filter(Boolean).join(' / ');
  const title = down
    ? `监控告警：${alert.targetName} 不可用`
    : `已恢复：${alert.targetName}`;
  const lines = [
    alert.message,
    scope ? `范围：${scope}` : '',
    down ? `连续失败 ${alert.consecutiveFailures} 次` : '',
    down ? '下一步：打开监控中心看该目标的最近采样与故障时间线，确认是探测器问题还是服务真的挂了。' : '',
  ].filter(Boolean);

  return {
    source: 'uptime-alert',
    title,
    message: lines.join('\n'),
    level: down ? 'error' : 'info',
    section: 'admin',
    dedupKey: `uptime:${alert.targetId}:${down ? 'down' : 'recovered'}:${alert.detectedAt}`,
    ...(alert.probeUrl ? { actionLabel: '打开被监控地址', actionUrl: alert.probeUrl } : {}),
  };
}

/**
 * 从环境变量解析配置。缺任何一项都返回 null——**并且调用方必须把这件事说出来**，
 * 否则就成了「装了个永远不会响的铃」（这正是本模块要治的那类问题）。
 */
export function mapNotifierConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MapNotifierConfig | null {
  const endpoint = (env.CDS_MAP_NOTIFY_ENDPOINT || '').trim();
  const keyId = (env.CDS_MAP_NOTIFY_KEY_ID || '').trim();
  const username = (env.CDS_MAP_NOTIFY_USERNAME || '').trim();
  // PEM 里的换行在 env 里通常被写成字面 \n，这里还原，否则 crypto 直接抛。
  const privateKeyPem = (env.CDS_MAP_NOTIFY_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  if (!endpoint || !keyId || !username || !privateKeyPem) return null;
  const timeoutRaw = Number(env.CDS_MAP_NOTIFY_TIMEOUT_MS);
  return {
    endpoint,
    keyId,
    username,
    privateKeyPem,
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS,
  };
}

export interface MapNotifierSendResult {
  ok: boolean;
  status?: number;
  reason?: string;
}

/**
 * 真的发出去。
 *
 * 不重试：uptime-monitor 只在**状态翻转**时调它（去抖已经在上游做过），
 * 重试会把一次翻转变成多条通知；发失败宁可留在日志里，也不刷屏。
 * 任何异常都吞掉转成结果值——通知发不出去不该拖垮探测轮次。
 */
export class MapNotifier {
  constructor(
    private readonly config: MapNotifierConfig,
    private readonly logger?: { warn?: (m: string) => void; info?: (m: string) => void },
  ) {}

  async send(alert: MapNotifierAlert): Promise<MapNotifierSendResult> {
    const payload = buildNotificationPayload(alert);
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();
    const path = new URL(this.config.endpoint).pathname;

    let signature: string;
    try {
      signature = signCanonical(
        this.config.privateKeyPem,
        buildCanonicalRequest('POST', path, timestamp, nonce, this.config.username, body),
      );
    } catch (err) {
      const reason = `签名失败: ${(err as Error).message}`;
      this.logger?.warn?.(`[map-notifier] ${reason}`);
      return { ok: false, reason };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [HEADER_KEY_ID]: this.config.keyId,
          [HEADER_TIMESTAMP]: String(timestamp),
          [HEADER_NONCE]: nonce,
          [HEADER_SIGNATURE]: signature,
        },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        // 401/403 通常是公钥没配、keyId 写错或 AllowedHost 不匹配——
        // 这几种失败会让铃永远哑着，所以必须留下能直接照着修的原因。
        const detail = await res.text().catch(() => '');
        const reason = `MAP 返回 ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
        this.logger?.warn?.(`[map-notifier] 通知投递失败 ${reason}`);
        return { ok: false, status: res.status, reason };
      }
      this.logger?.info?.(`[map-notifier] 已投递告警通知: ${payload.title}`);
      return { ok: true, status: res.status };
    } catch (err) {
      const reason = `请求失败: ${(err as Error).message}`;
      this.logger?.warn?.(`[map-notifier] ${reason}`);
      return { ok: false, reason };
    } finally {
      clearTimeout(timer);
    }
  }
}
