/**
 * 控制面入口可达性自检（2026-07-30）。
 *
 * 起因：生产 cds.miduo.org 的 `POST /api/self-update` 被 Cloudflare 一条规则
 * 拦在应用之外，返回 503 + 英文 `self-update temporarily disabled by operations`。
 * 这条规则只打普通更新一条路径，强制同步反而放行。造成的后果是三重的：
 *
 *   1. 用户每次点「更新」都失败，看到的还是英文；
 *   2. 请求没进应用，**更新历史里查不到任何记录**——从账本看风平浪静，
 *      与用户体感完全相反，于是没人能定位；
 *   3. 这个状态持续了很久都没被发现，因为系统没有任何机制去检查
 *      「我自己的入口，从公网还进得来吗」。
 *
 * 本模块补第 3 条。判别法来自那次排查的决定性证据：
 * **应用产生的响应带 CDS 指纹头（x-cds-request-id / x-powered-by: Express），
 * 被前置层挡回的响应一个都没有。** 所以只要发一个无鉴权探测请求，
 * 看回应里有没有指纹，就能区分「应用拒绝了我」和「我根本没到应用」。
 *
 * 关键点：探测必须走**公网域名**，不能走 127.0.0.1——只有完整链路才看得见
 * CDN / 反向代理这一层。内网自测永远是绿的，那正是这次没被发现的原因。
 */

/** 一次探测的原始观测值。 */
export interface EntrypointProbeObservation {
  /** 被探测的路径，如 /api/self-update */
  path: string;
  /** HTTP 状态码；0 表示连握手都没成功 */
  status: number;
  /** 响应头（小写 key） */
  headers: Record<string, string>;
  /** 响应体前若干字节，用于把服务端说明带给用户 */
  bodySnippet?: string;
  /** 网络层错误描述（超时/连接失败等） */
  networkError?: string;
}

export type EntrypointVerdict =
  /** 请求到达了应用（哪怕被应用拒绝，比如 401）——这是健康状态 */
  | 'reachable'
  /** 请求没到应用，被前置层（CDN / 反向代理 / WAF）挡回 */
  | 'blocked_at_edge'
  /** 连不上，无法判断是被挡还是服务挂了 */
  | 'unreachable'

export interface EntrypointReachability {
  path: string;
  verdict: EntrypointVerdict;
  status: number;
  /** 中文结论，直接可展示 */
  summary: string;
  /** 前置层返回的原文（多为英文），折叠展示用 */
  edgeMessage?: string;
}

/**
 * CDS 应用响应的指纹头。
 *
 * 这些头由 Express 中间件写入，任何**到达应用**的响应都会带上其中至少一个。
 * 边缘层自己生成的响应不可能有——它压根没执行到应用代码。
 * 判据只认这一条，不去猜状态码语义（503 既可能是边缘拦截，也可能是
 * 应用自己的排空窗口，只有指纹能区分）。
 */
const APP_FINGERPRINT_HEADERS = ['x-cds-request-id', 'x-powered-by', 'server-timing'];

function hasAppFingerprint(headers: Record<string, string>): boolean {
  return APP_FINGERPRINT_HEADERS.some((h) => {
    const value = headers[h];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

/**
 * 判定一次探测结果。纯函数，不发请求，可直接单测。
 */
export function classifyEntrypointProbe(obs: EntrypointProbeObservation): EntrypointReachability {
  if (obs.networkError || obs.status === 0) {
    return {
      path: obs.path,
      verdict: 'unreachable',
      status: obs.status,
      summary: `无法探测 ${obs.path}：${obs.networkError || '连接未建立'}。可能是 CDS 正在重启，也可能是出网受限。`,
    };
  }

  if (hasAppFingerprint(obs.headers)) {
    // 到达应用即为健康：401/403 说明鉴权层正常工作，正是我们期望看到的。
    return {
      path: obs.path,
      verdict: 'reachable',
      status: obs.status,
      summary: `${obs.path} 可达（HTTP ${obs.status}，响应来自 CDS 应用）。`,
    };
  }

  const edgeMessage = (obs.bodySnippet || '').trim().slice(0, 300) || undefined;
  return {
    path: obs.path,
    verdict: 'blocked_at_edge',
    status: obs.status,
    summary:
      `${obs.path} 被前置层拦截（HTTP ${obs.status}），请求没有进到 CDS 应用——`
      + '响应里没有任何 CDS 指纹头。这类拦截不会写进 CDS 的任何账本，'
      + '所以查历史也查不到，只能靠本自检发现。',
    edgeMessage,
  };
}

export interface EntrypointReachabilityReport {
  /** 整体是否健康（没有任何入口被边缘层挡住） */
  healthy: boolean;
  /** 被挡住的入口，供告警文案直接用 */
  blocked: EntrypointReachability[];
  results: EntrypointReachability[];
  /** 一句话结论 */
  summary: string;
  /** 被挡住时给运维的下一步 */
  nextAction?: string;
}

/** 汇总多条探测，产出可直接展示的报告。 */
export function buildReachabilityReport(results: EntrypointReachability[]): EntrypointReachabilityReport {
  const blocked = results.filter((r) => r.verdict === 'blocked_at_edge');
  if (blocked.length === 0) {
    const unreachable = results.filter((r) => r.verdict === 'unreachable');
    return {
      healthy: unreachable.length === 0,
      blocked: [],
      results,
      summary: unreachable.length === 0
        ? `控制面入口自检通过：${results.length} 个入口都能到达 CDS 应用。`
        : `${unreachable.length} 个入口暂时探测不到（可能正在重启），其余正常。`,
    };
  }
  const paths = blocked.map((b) => b.path).join('、');
  return {
    healthy: false,
    blocked,
    results,
    summary:
      `控制面入口被前置层拦截：${paths}。这些请求根本没有进到 CDS 应用，`
      + '因此点击对应功能会失败，但 CDS 的日志与历史里不会留下任何记录。',
    nextAction:
      `到 CDN / 反向代理（本站为 Cloudflare）检查针对 ${paths} 的拦截规则并解除。`
      + '若该规则是某次事故期间临时加的，确认事故结束后应当撤除——'
      + '只挡住带闸门保护的路径、却放行能力更强的路径，并不会让系统更安全。',
  };
}

/**
 * 需要自检的控制面入口。
 *
 * 只放**无副作用的探测方式**：一律发不带鉴权的请求，期望被应用的鉴权层拒绝
 * （401/403）。绝不能因为自检而真的触发一次更新或发布。
 */
export const MONITORED_ENTRYPOINTS: ReadonlyArray<{ path: string; method: 'POST' | 'GET'; label: string }> = [
  { path: '/api/self-update', method: 'POST', label: 'CDS 更新' },
  { path: '/api/self-force-sync', method: 'POST', label: 'CDS 强制同步' },
  { path: '/api/self-status', method: 'POST', label: 'CDS 自身状态' },
];

/**
 * 真发探测请求。
 *
 * 刻意走**公网域名**而不是 127.0.0.1：这次事故的拦截发生在 Cloudflare，
 * 内网自测永远绿灯，正是它没被发现的原因。探测只发不带鉴权的请求，
 * 期望换回 401——绝不会真的触发一次更新。
 */
export async function probeEntrypoint(
  baseUrl: string,
  entry: { path: string; method: 'POST' | 'GET' },
  timeoutMs = 10_000,
): Promise<EntrypointReachability> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}${entry.path}`, {
      method: entry.method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: entry.method === 'POST' ? '{}' : undefined,
      signal: controller.signal,
      redirect: 'manual',
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    let bodySnippet = '';
    try { bodySnippet = (await res.text()).slice(0, 300); } catch { /* 空体可接受 */ }
    return classifyEntrypointProbe({ path: entry.path, status: res.status, headers, bodySnippet });
  } catch (err) {
    const reason = (err as Error).name === 'AbortError'
      ? `探测超时(${timeoutMs}ms)`
      : (err as Error).message;
    return classifyEntrypointProbe({ path: entry.path, status: 0, headers: {}, networkError: reason });
  } finally {
    clearTimeout(timer);
  }
}

/** 跑一轮完整自检。 */
export async function runEntrypointSelfCheck(baseUrl: string): Promise<EntrypointReachabilityReport> {
  const results: EntrypointReachability[] = [];
  for (const entry of MONITORED_ENTRYPOINTS) {
    results.push(await probeEntrypoint(baseUrl, entry));
  }
  return buildReachabilityReport(results);
}

/**
 * 从配置的根域名推出自检用的公网 base URL。
 *
 * 没有配置根域名时返回 null —— 此时**不做**自检，也不报健康：
 * 拿 localhost 探测等于自欺欺人（no-rootless-tree：不假装有不存在的能力）。
 */
export function resolveSelfCheckBaseUrl(rootDomains: string[] | undefined): string | null {
  const first = (rootDomains || []).map((d) => d.trim()).filter(Boolean)[0];
  if (!first) return null;
  if (/^https?:\/\//i.test(first)) return first;
  return `https://${first}`;
}
