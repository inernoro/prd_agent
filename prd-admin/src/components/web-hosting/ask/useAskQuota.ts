import { useCallback, useEffect, useState } from 'react';
import { api } from '@/services/api';
import { buildApiUrl } from '@/services/real/webPages';
import { useAuthStore } from '@/stores/authStore';
import type { AskSource } from './askTypes';

/**
 * 「还能问几次」。
 *
 * 为什么单独拉一个端点而不是等提问失败：配额用完是**问之前**就该知道的事。
 * 等到点了发送、吃一个 429 再告诉他「今天问完了」，那句话已经晚了一步——
 * 他为此写了一段话（expectation-management：任何时刻都该知道现在什么情况）。
 *
 * 为什么不复用 apiRequest：这条路径匿名可用，而 apiRequest 的 401 会触发
 * refresh / 跳登录。访客读不到额度就该安静地什么都不显示，不该被弹去登录页。
 */
export interface AskQuota {
  siteRemaining: number;
  siteLimit: number;
  visitorRemaining: number;
  visitorLimit: number;
}

interface QuotaPayload {
  available?: boolean;
  siteRemaining?: number;
  siteLimit?: number;
  visitorRemaining?: number;
  visitorLimit?: number;
}

export function useAskQuota(source: AskSource, enabled: boolean, blockedUntil?: number | null) {
  const [quota, setQuota] = useState<AskQuota | null>(null);

  // 依赖必须是**原始值**，不能是 source 对象本身：调用方每次渲染都新建一个对象字面量，
  // 拿对象当依赖会让 refresh 每渲染换一次身份，useEffect 随之每渲染重拉一次——
  // 一个安静的死循环，页面看着正常，网络面板在刷屏。
  const token = source.mode === 'share' ? source.token : null;
  const siteId = source.mode === 'share' ? source.siteId : undefined;
  const password = source.mode === 'share' ? source.password : undefined;

  const refresh = useCallback(async () => {
    // 站内预览（mode: 'site'）没有这条旁路：owner 看自己的页面不占访客额度桶，
    // 端点只挂在分享域。读不到就不显示，而不是显示一个别的桶的数（no-rootless-tree）。
    if (!enabled || !token) {
      setQuota(null);
      return;
    }
    const params = new URLSearchParams();
    if (siteId) params.set('siteId', siteId);
    if (password) params.set('password', password);
    const q = params.toString();
    const url = buildApiUrl(
      `${api.webPages.askQuotaByShare(encodeURIComponent(token))}${q ? `?${q}` : ''}`,
    );
    try {
      const authToken = useAuthStore.getState().token;
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
      });
      if (!res.ok) { setQuota(null); return; }
      const json = await res.json() as { success?: boolean; data?: QuotaPayload };
      const d = json?.data;
      if (!json?.success || !d?.available
        || typeof d.siteRemaining !== 'number' || typeof d.visitorRemaining !== 'number') {
        setQuota(null);
        return;
      }
      setQuota({
        siteRemaining: d.siteRemaining,
        siteLimit: d.siteLimit ?? 0,
        visitorRemaining: d.visitorRemaining,
        visitorLimit: d.visitorLimit ?? 0,
      });
    } catch {
      setQuota(null);
    }
  }, [enabled, token, siteId, password]);

  useEffect(() => { void refresh(); }, [refresh]);

  // 配额窗口到点之后自己重拉一次。
  //
  // 少了这一步会卡死：面板开着时吃到按小时/按天的配额拒绝，提交被 gateError 禁用、
  // 额度快照是 0；而上面那个 effect 只在 refresh 身份变化时跑，光是「等到窗口过期」
  // 永远不会去取那份新的正数快照——于是窗口早就过了，面板还锁着，用户只能折叠重开
  // 或者刷新页面才发现其实又能问了。他等的那段时间是白等的。
  //
  // blockedUntil 由调用方从 Retry-After 算出（毫秒时间戳）；没有拒绝时传空，不装定时器。
  useEffect(() => {
    if (!enabled || !blockedUntil) return;
    const delay = blockedUntil - Date.now();
    // 已经过点就立刻拉；还没到就等到点。上限一小时，防止后端给个离谱的值把定时器挂死。
    const timer = window.setTimeout(() => { void refresh(); }, Math.min(Math.max(delay, 0), 3_600_000) + 500);
    return () => window.clearTimeout(timer);
  }, [enabled, blockedUntil, refresh]);

  return { quota, refresh };
}
