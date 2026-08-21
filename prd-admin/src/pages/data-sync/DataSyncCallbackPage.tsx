import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';

import { MapSpinner } from '@/components/ui/VideoLoader';
import { apiRequest } from '@/services/real/apiClient';
import { applyDocumentThemeMode } from '@/lib/themeTransition';
import { useMobileThemeStore } from '@/stores/mobileThemeStore';

/** 发起跳转时把「这次是去哪台源站」记在这里，回调时凭 state 取回。 */
const DATA_SYNC_PENDING_PREFIX = 'data-sync:pending:';

/**
 * 待回跳的授权按 **state** 分开存。
 *
 * 原来是一个固定键：在两个标签页各发起一次同步，第二次的 prepare 会把第一次那条
 * 覆盖掉。之后无论谁先回来都失败——先回来的那个读到的是另一次的 state，判定
 * 「对不上」并顺手把这唯一一条删掉，另一个回来时连记录都没有了。两次都白跑，
 * 而错误文案说的是「这次回跳与本机发起的授权对不上」，看起来像被攻击。
 *
 * 按 state 分键之后，两次授权互不相干，各自认领自己那条。
 */
export function stashPendingAuthorization(
  state: string,
  value: { state: string; sourceOrigin: string; sourceLabel?: string },
): void {
  sessionStorage.setItem(DATA_SYNC_PENDING_PREFIX + state, JSON.stringify(value));
}

/**
 * 读，但**不删**。
 *
 * 原来是读完立刻删。删在换票**之前**，于是换票没成的时候这条记录也一起没了：
 * 网络抖一下、源站 500、本站会话恰好过期，管理员都只能回到源站从头再批准一遍——
 * 而这些失败里有一部分本来重试一次就好。和源站那边「换票不许挂在浏览器连接上」
 * 是同一条纪律：一次性的东西，要等这一步真的成了再消耗掉。
 */
function peekPendingAuthorization(state: string): { state: string; sourceOrigin: string } | null {
  if (!state) return null;
  try {
    const raw = sessionStorage.getItem(DATA_SYNC_PENDING_PREFIX + state);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // 解析不出来的坏记录留着也没用，删掉——只删自己这一条，别的标签页还在等它那条。
    sessionStorage.removeItem(DATA_SYNC_PENDING_PREFIX + state);
    return null;
  }
}

function dropPendingAuthorization(state: string): void {
  // 只删自己这一条：别的标签页还在等它那条。
  sessionStorage.removeItem(DATA_SYNC_PENDING_PREFIX + state);
}

/**
 * 授权回跳落地页。
 *
 * 授权码走 URL fragment（`#code=...`）而不是 query：fragment 不会被浏览器发给服务器、
 * 不会进 nginx 访问日志、不会进 Referer。拿到后立刻交给本站服务端换令牌，并把地址栏
 * 里的 fragment 抹掉，免得它留在历史记录里。
 */
export default function DataSyncCallbackPage() {
  // 同上：回跳落地页也在 AppShell 之外，主题要自己应用。
  const themeMode = useMobileThemeStore((s) => s.mode);
  useEffect(() => {
    applyDocumentThemeMode(themeMode, window.location.pathname);
  }, [themeMode]);

  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  // React 18 严格模式下 effect 会跑两次；授权码只能用一次，第二次必然失败并报错。
  const started = useRef(false);
  /**
   * 授权码只留在**内存**里，不进 sessionStorage。
   *
   * 地址栏那份一进来就抹掉（免得留在历史记录里），但抹掉不等于要立刻扔掉：
   * 换票失败而人还停在这一页时，手上有它才谈得上「重试」。放内存不放存储，
   * 是因为它是一枚还没用掉的凭据——页面一关就该跟着消失。
   */
  const oneTime = useRef<{ code: string; state: string; sourceOrigin: string } | null>(null);

  const exchange = useCallback(async () => {
    const held = oneTime.current;
    if (!held) return;
    setBusy(true);
    setError('');
    const res = await apiRequest<{ runId: string }>('/api/instance-sync/runs/callback', {
      method: 'POST',
      body: { sourceOrigin: held.sourceOrigin, code: held.code, state: held.state },
    });
    if (!res.success || !res.data?.runId) {
      // 失败时**不**消耗 pending 记录，也不丢掉手上的码：留着这次还能再试一下。
      setError(res.error?.message || '换取导出授权失败');
      setBusy(false);
      return;
    }
    dropPendingAuthorization(held.state);
    oneTime.current = null;
    navigate(`/data-sync?run=${encodeURIComponent(res.data.runId)}`, { replace: true });
  }, [navigate]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const code = hash.get('code') || '';
    const state = hash.get('state') || '';
    window.history.replaceState(null, '', window.location.pathname);

    const pending = peekPendingAuthorization(state);

    if (!code || !state || !pending || pending.state !== state) {
      // state 对不上说明这不是本浏览器发起的那次授权，直接拒绝，不去换票。
      setError('这次回跳与本机发起的授权对不上，请回到数据同步页重新发起。');
      setBusy(false);
      return;
    }

    oneTime.current = { code, state, sourceOrigin: pending.sourceOrigin };
    void exchange();
  }, [exchange]);

  return (
    <main className="flex min-h-screen w-full items-center justify-center px-5" style={{ background: 'var(--bg-base)' }}>
      <section
        className="w-full max-w-md rounded-2xl p-7 text-center"
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          boxShadow: 'var(--shadow-raised)',
        }}
        role={error ? 'alert' : 'status'}
        aria-live="polite"
      >
        <div
          className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl"
          style={{ background: 'rgba(var(--accent-primary-rgb), 0.14)', color: 'var(--accent-primary)' }}
        >
          {error ? <ShieldAlert size={22} /> : <MapSpinner size={22} />}
        </div>
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
          {error ? '授权没有完成' : '正在换取一次性导出授权'}
        </h1>
        <p className="mt-2 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
          {error || '源站已经同意，正在把授权换成本次同步的凭据，马上带你去确认同步范围。'}
        </p>
        {error ? (
          <div className="mt-5 flex items-center justify-center gap-2">
            {/* 手上还握着码才给重试——没有码的失败（state 对不上）重试多少次都是同一个结果。 */}
            {oneTime.current ? (
              <button
                type="button"
                disabled={busy}
                className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-60"
                style={{ background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)' }}
                onClick={() => void exchange()}
              >
                {busy ? '重试中' : '重试'}
              </button>
            ) : null}
            <button
              type="button"
              className="rounded-lg px-4 py-2 text-sm font-medium"
              style={{
                background: 'var(--bg-subtle)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-default)',
              }}
              onClick={() => navigate('/data-sync', { replace: true })}
            >
              回到数据同步
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}
