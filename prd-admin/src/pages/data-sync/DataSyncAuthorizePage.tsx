import { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, ShieldAlert, ChevronDown, ChevronRight } from 'lucide-react';

import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { apiRequest } from '@/services/real/apiClient';

/**
 * 源站同意页：别的 MAP 实例来要数据，由本站管理员当场决定给什么。
 *
 * 这一屏是整条链路上唯一一次「人」参与的地方，所以它必须把三件事摆明白：
 * 谁要、要走哪些、哪些**绝对不会**走。第三件最容易被省掉，但它恰恰是让批准的人
 * 敢按下按钮的那一半信息。
 */

type ScopeCollection = { name: string; estimatedCount: number; redactFields: string[] };
type ScopeGroup = { key: string; label: string; collections: ScopeCollection[] };
type ScopeCatalog = {
  siteLabel: string;
  groups: ScopeGroup[];
  excluded: { collection: string; reason: string }[];
};

function readParams() {
  const p = new URLSearchParams(window.location.search);
  return {
    redirectUri: p.get('redirect_uri') || '',
    state: p.get('state') || '',
    codeChallenge: p.get('code_challenge') || '',
  };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function formatCount(n: number): string {
  if (n < 0) return '未知';
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
  return String(n);
}

export default function DataSyncAuthorizePage() {
  const params = useMemo(readParams, []);
  const [catalog, setCatalog] = useState<ScopeCatalog | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showExcluded, setShowExcluded] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    void apiRequest<ScopeCatalog>('/api/instance-sync/scope-catalog').then((res) => {
      if (!alive) return;
      if (!res.success || !res.data) {
        setError(res.error?.message || '读取可授权范围失败');
        return;
      }
      setCatalog(res.data);
      // 默认全选：用户明确要求「默认所有，未来要限制就在源站取消勾选」。
      setChecked(new Set(res.data.groups.map((g) => g.key)));
    });
    return () => {
      alive = false;
    };
  }, []);

  const totals = useMemo(() => {
    if (!catalog) return { collections: 0, documents: 0 };
    let collections = 0;
    let documents = 0;
    for (const group of catalog.groups) {
      if (!checked.has(group.key)) continue;
      for (const c of group.collections) {
        collections += 1;
        if (c.estimatedCount > 0) documents += c.estimatedCount;
      }
    }
    return { collections, documents };
  }, [catalog, checked]);

  const paramsValid = params.redirectUri && params.state && params.codeChallenge;

  async function approve() {
    setSubmitting(true);
    setError('');
    const res = await apiRequest<{ redirectUrl: string }>('/api/instance-sync/authorize', {
      method: 'POST',
      body: {
        redirectUri: params.redirectUri,
        state: params.state,
        codeChallenge: params.codeChallenge,
        groups: Array.from(checked),
      },
    });
    if (!res.success || !res.data?.redirectUrl) {
      setSubmitting(false);
      setError(res.error?.message || '授权失败');
      return;
    }
    window.location.replace(res.data.redirectUrl);
  }

  if (!paramsValid) {
    return (
      <Shell tone="alert" title="授权链接不完整">
        这个页面需要由目标站发起跳转才能使用。请回到目标站的「数据同步」页重新发起。
      </Shell>
    );
  }

  if (error && !catalog) return <Shell tone="alert" title="无法开始授权">{error}</Shell>;
  if (!catalog) return <Shell tone="normal" title="正在读取可授权范围"><MapSectionLoader text="正在清点本站数据…" /></Shell>;

  return (
    <main className="min-h-screen w-full px-4 py-8" style={{ background: 'var(--bg-base)' }}>
      <section
        className="mx-auto w-full max-w-3xl rounded-2xl p-6"
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          boxShadow: 'var(--shadow-raised)',
        }}
      >
        <header className="flex items-start gap-3">
          <div
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
            style={{ background: 'rgba(var(--accent-primary-rgb), 0.14)', color: 'var(--accent-primary)' }}
          >
            <ShieldCheck size={22} />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              一次性数据授权
            </h1>
            <p className="mt-1 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
              <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{originOf(params.redirectUri)}</span>
              {' '}正在向本站（{catalog.siteLabel}）申请一次数据导出。
              同意后它只能执行<span style={{ color: 'var(--text-primary)' }}>一次</span>，
              再要就得重新走一遍这个页面。
            </p>
          </div>
        </header>

        <div className="mt-5 space-y-2">
          {catalog.groups.map((group) => {
            const on = checked.has(group.key);
            const open = expanded.has(group.key);
            const groupDocs = group.collections.reduce((sum, c) => sum + Math.max(0, c.estimatedCount), 0);
            return (
              <div
                key={group.key}
                className="rounded-xl"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border-secondary)' }}
              >
                <div className="flex items-center gap-3 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => {
                      const next = new Set(checked);
                      if (on) next.delete(group.key);
                      else next.add(group.key);
                      setChecked(next);
                    }}
                    className="h-4 w-4 shrink-0"
                    aria-label={`授权 ${group.label}`}
                  />
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => {
                      const next = new Set(expanded);
                      if (open) next.delete(group.key);
                      else next.add(group.key);
                      setExpanded(next);
                    }}
                  >
                    {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    <span className="truncate text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      {group.label}
                    </span>
                    <span className="shrink-0 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {group.collections.length} 个集合 · 约 {formatCount(groupDocs)} 条
                    </span>
                  </button>
                </div>
                {open ? (
                  <div className="border-t px-4 py-2" style={{ borderColor: 'var(--border-subtle)' }}>
                    {group.collections.map((c) => (
                      <div key={c.name} className="flex items-center justify-between gap-3 py-1 text-xs">
                        <span className="truncate font-mono" style={{ color: 'var(--text-secondary)' }}>{c.name}</span>
                        <span className="shrink-0" style={{ color: 'var(--text-muted)' }}>
                          {formatCount(c.estimatedCount)} 条
                          {c.redactFields.length > 0 ? ` · ${c.redactFields.join(' / ')} 不会带走` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="mt-4">
          <button
            type="button"
            className="flex items-center gap-2 text-xs"
            style={{ color: 'var(--text-muted)' }}
            onClick={() => setShowExcluded((v) => !v)}
          >
            {showExcluded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            无论怎么勾都不会带走的 {catalog.excluded.length} 个集合
          </button>
          {showExcluded ? (
            <div
              className="mt-2 max-h-56 overflow-y-auto rounded-lg px-3 py-2"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', overscrollBehavior: 'contain' }}
            >
              {catalog.excluded.map((item) => (
                <div key={item.collection} className="flex items-baseline justify-between gap-3 py-0.5 text-xs">
                  <span className="shrink-0 font-mono" style={{ color: 'var(--text-secondary)' }}>{item.collection}</span>
                  <span className="truncate text-right" style={{ color: 'var(--text-muted)' }}>{item.reason}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {error ? (
          <p className="mt-4 flex items-center gap-2 text-sm" style={{ color: 'var(--danger)' }} role="alert">
            <ShieldAlert size={16} /> {error}
          </p>
        ) : null}

        <footer className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            本次将允许对方读取 {totals.collections} 个集合、约 {formatCount(totals.documents)} 条记录。
            密钥、口令与访问令牌一律留在本站。
          </p>
          <button
            type="button"
            disabled={submitting || checked.size === 0}
            onClick={() => void approve()}
            className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
            style={{ background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)' }}
          >
            {submitting ? <MapSpinner size={14} /> : <ShieldCheck size={16} />}
            {submitting ? '正在签发授权' : '同意并返回'}
          </button>
        </footer>
      </section>
    </main>
  );
}

function Shell({ tone, title, children }: { tone: 'normal' | 'alert'; title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen w-full items-center justify-center px-5" style={{ background: 'var(--bg-base)' }}>
      <section
        className="w-full max-w-md rounded-2xl p-7 text-center"
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          boxShadow: 'var(--shadow-raised)',
        }}
        role={tone === 'alert' ? 'alert' : 'status'}
        aria-live="polite"
      >
        <div
          className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl"
          style={{ background: 'rgba(var(--accent-primary-rgb), 0.14)', color: 'var(--accent-primary)' }}
        >
          {tone === 'alert' ? <ShieldAlert size={22} /> : <ShieldCheck size={22} />}
        </div>
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h1>
        <div className="mt-2 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>{children}</div>
      </section>
    </main>
  );
}
