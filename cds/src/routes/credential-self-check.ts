/**
 * 凭据自检路由 —— 持有者自己就能查清「我这把凭据到底怎么了」。
 *
 * ## 为什么必须免鉴权
 *
 * 这条端点存在的全部意义，就是诊断一把**过不了鉴权**的凭据。挂在鉴权后面
 * 它永远也执行不到，只会再回一句「未授权」——也就是它要治的那个病。所以它
 * 必须在鉴权之前放行（见 server.ts 的公开路由表），改由判据本身控制它说什么。
 *
 * ## 它不会变成枚举预言机
 *
 * - 凭据是 24 字节随机串，靠猜命中的概率与直接猜密钥相同，端点没有让攻击面变大；
 * - 拿一把真凭据换来的「已吊销」，本来发一次普通请求也能推出来；
 * - `never-issued` 只回答「没见过」，不透露任何项目信息；
 * - 出参不含明文、不含哈希（判据模块有专门的不泄密用例守着）。
 *
 * 另加一道按来源 IP 的粗粒度节流：不是为了防猜（猜不动），是为了防有人拿它
 * 当免鉴权的压测入口。
 */

import { Router } from 'express';
import type { StateService } from '../services/state.js';
import { checkCredential, hashCredential, type CredentialFacts } from '../services/credential-self-check.js';

export interface CredentialSelfCheckRouterDeps {
  stateService: StateService;
}

/** 与 server.ts 的 resolveAiSession 同一组请求头，缺一个都会让自检答非所问。 */
export function extractPresentedCredential(req: import('express').Request): string {
  const direct = (req.headers['x-ai-access-key'] as string | undefined)
    || (req.headers['ai-access-key'] as string | undefined)
    || (req.headers['x-cds-token'] as string | undefined);
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const auth = req.headers['authorization'] as string | undefined;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return '';
}

/** 粗粒度节流窗口：同一来源每分钟至多这么多次自检。 */
const THROTTLE_WINDOW_MS = 60_000;
const THROTTLE_MAX_PER_WINDOW = 30;

interface ThrottleBucket { count: number; windowStartedAt: number }

export function createCredentialSelfCheckRouter(deps: CredentialSelfCheckRouterDeps): Router {
  const router = Router();
  const buckets = new Map<string, ThrottleBucket>();

  function throttled(sourceKey: string, now: number): boolean {
    const bucket = buckets.get(sourceKey);
    if (!bucket || now - bucket.windowStartedAt >= THROTTLE_WINDOW_MS) {
      buckets.set(sourceKey, { count: 1, windowStartedAt: now });
      // 顺手清掉过期桶，避免长期运行时 Map 无限长大。
      if (buckets.size > 1024) {
        for (const [key, value] of buckets) {
          if (now - value.windowStartedAt >= THROTTLE_WINDOW_MS) buckets.delete(key);
        }
      }
      return false;
    }
    bucket.count += 1;
    return bucket.count > THROTTLE_MAX_PER_WINDOW;
  }

  /**
   * 组装判据所需的事实快照。
   *
   * `agentKeys` **必须连已吊销的一起给**：少了它，「被吊销」与「从未签发」
   * 就会重新塌缩成同一个答案，正是本功能要拆开的那件事。
   */
  function collectFacts(): CredentialFacts {
    const state = deps.stateService.getState();
    const staticKeys = [
      process.env.CDS_AI_ACCESS_KEY,
      process.env.AI_ACCESS_KEY,
      deps.stateService.getCustomEnv()?.['AI_ACCESS_KEY'],
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    const connectionHashes = deps.stateService
      .getCdsConnections()
      .filter((connection) => connection.status === 'active' && connection.longTokenHash)
      .map((connection) => connection.longTokenHash as string);
    return {
      projects: (state.projects || []).map((project) => ({
        id: project.id,
        slug: project.slug,
        name: project.aliasName || project.name,
        agentKeys: project.agentKeys,
      })),
      globalAgentKeys: state.globalAgentKeys,
      // 身份层没启用时 state.userCredentials 是 undefined，自检据此报 not-checkable
      // 而不是 never-issued —— 「查不了」和「没签过」不是一回事。
      ...(state.userCredentials ? { userCredentials: state.userCredentials } : {}),
      ...(state.principals ? { principals: state.principals } : {}),
      ...(staticKeys.length > 0 ? { staticKeyHashes: staticKeys.map(hashCredential) } : {}),
      // 一条 active 连接都没有时也给空数组：那是「查过了，没有」，
      // 与「本次没法查」是两回事，不能都退化成 not-checkable。
      connectionTokenHashes: connectionHashes,
    };
  }

  router.get('/credentials/self-check', (req, res) => {
    const source = String(req.ip || req.socket?.remoteAddress || 'unknown');
    if (throttled(source, Date.now())) {
      res.status(429).json({
        error: 'too_many_requests',
        message: '凭据自检调用过于频繁，请稍后再试。',
      });
      return;
    }
    const presented = extractPresentedCredential(req);
    const result = checkCredential(presented, collectFacts());
    res.json({ ok: true, ...result });
  });

  return router;
}
