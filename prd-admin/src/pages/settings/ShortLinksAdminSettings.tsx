/**
 * 「分享短链」Tab — 系统设置内的管理员视图。
 *
 * 跨用户列出 /s/{seq} 数字短链，支持筛选 targetType、按 seq 或 token 搜索、
 * 强制吊销、修复 counter。统一短链体系将逐步覆盖网页托管 / 周报 / 文档空间
 * / 缺陷 / 工作流等子系统，这里是它们共同的管理面板。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link2, ExternalLink, Copy, X, RefreshCw, Wrench, Search } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { listAdminShortLinks, revokeAdminShortLink, repairShortLinkCounter } from '@/services';
import type { AdminShortLinkItem } from '@/services';

const PAGE_SIZE = 50;

const TARGET_TYPE_LABELS: Record<string, string> = {
  web_page: '网页托管',
  workflow: '工作流',
  defect: '缺陷',
  report: '周报',
  document_store: '文档空间',
  toolbox: '百宝箱',
};

function fmtDate(s?: string) {
  if (!s) return '-';
  try {
    return new Date(s).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return s;
  }
}

export function ShortLinksAdminSettings() {
  const [items, setItems] = useState<AdminShortLinkItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [targetType, setTargetType] = useState<string>('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [skip, setSkip] = useState(0);
  const [busy, setBusy] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // 用 epoch 计数器抵御 stale-while-revalidate：快速切 filter 时
  // 多个 load 并发飞，只有最新一次的响应允许写状态，旧响应静默丢弃。
  const loadEpochRef = useRef(0);

  const load = useCallback(async () => {
    const myEpoch = ++loadEpochRef.current;
    setLoading(true);
    const res = await listAdminShortLinks({ targetType: targetType || undefined, search: search || undefined, skip, limit: PAGE_SIZE });
    if (loadEpochRef.current !== myEpoch) return; // 已被更新的请求覆盖
    setLoading(false);
    if (res.success) {
      setItems(res.data.items);
      setTotal(res.data.total);
      // 外部删除让 skip 越界（例如别处删了几条，刷新后 total 缩水到 skip 之前）
      // → 回退到最后一页，避免分页文案显示 "第 51-0 条" 这种荒谬范围。
      if (skip > 0 && skip >= res.data.total) {
        const lastPageSkip = Math.max(0, Math.floor(Math.max(0, res.data.total - 1) / PAGE_SIZE) * PAGE_SIZE);
        setSkip(lastPageSkip);
      }
    } else {
      setToast(res.error?.message || '加载失败');
    }
  }, [targetType, search, skip]);

  useEffect(() => { void load(); }, [load]);

  // toast 2.5s 后自动消失（原先依赖 onAnimationEnd 但元素没动画，永远不触发）
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2500);
    return () => window.clearTimeout(id);
  }, [toast]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSkip(0);
    setSearch(searchInput.trim());
  };

  const handleRevoke = async (item: AdminShortLinkItem) => {
    if (item.share?.isRevoked) {
      setToast(`#${item.seq} 已经被吊销过`);
      return;
    }
    if (!confirm(`确认强制吊销短链 /s/${item.seq}？\n${item.share?.title || ''}\n吊销后 /s/${item.seq} 和 /s/wp/${item.token} 两条 URL 都会失效。`)) return;
    setBusy(item.seq);
    const res = await revokeAdminShortLink(item.seq);
    setBusy(null);
    if (res.success) {
      setToast(`已吊销 /s/${item.seq}`);
      await load();
    } else {
      setToast(res.error?.message || '吊销失败');
    }
  };

  const handleRepair = async () => {
    if (!confirm('修复计数器：把全局 counter 重置为当前 max(seq)。仅在遇到 seq 撞车/分配失败时使用。继续？')) return;
    const res = await repairShortLinkCounter();
    if (res.success) {
      setToast(`counter 已修复，当前值=${res.data.counterSet}`);
    } else {
      setToast(res.error?.message || '修复失败');
    }
  };

  const handleCopy = (item: AdminShortLinkItem) => {
    const url = `${window.location.origin}/s/${item.seq}`;
    navigator.clipboard.writeText(url);
    setToast(`已复制 ${url}`);
  };

  const handleOpen = (item: AdminShortLinkItem) => {
    window.open(`/s/${item.seq}`, '_blank');
  };

  const targetTypeOptions = useMemo(
    () => Object.entries(TARGET_TYPE_LABELS).map(([k, v]) => ({ value: k, label: v })),
    [],
  );

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      <GlassCard className="p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <Link2 size={18} style={{ color: 'var(--text-primary)' }} />
          <h2 className="text-base font-semibold m-0" style={{ color: 'var(--text-primary)' }}>分享短链</h2>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            跨用户管理所有 /s/&#123;seq&#125; 数字短链。
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button size="xs" variant="ghost" onClick={() => void load()} title="刷新">
              <RefreshCw size={12} />
            </Button>
            <Button size="xs" variant="secondary" onClick={() => void handleRepair()} title="把全局 counter 同步到 max(seq)">
              <Wrench size={12} /> 修复 counter
            </Button>
          </div>
        </div>

        <form onSubmit={handleSearch} className="mt-3 flex items-center gap-2 flex-wrap">
          <select
            value={targetType}
            onChange={e => { setTargetType(e.target.value); setSkip(0); }}
            className="rounded px-2 py-1 text-sm"
            style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
          >
            <option value="">全部类型</option>
            {targetTypeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <input
            type="text"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="按 seq（数字）或 token 关键字搜索"
            className="rounded px-2 py-1 text-sm min-w-[260px]"
            style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
          />
          <Button size="xs" type="submit"><Search size={12} /> 搜索</Button>
          {(search || targetType) && (
            <Button size="xs" variant="ghost" onClick={() => { setSearch(''); setSearchInput(''); setTargetType(''); setSkip(0); }}>
              清除
            </Button>
          )}
          <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>
            共 {total} 条
          </span>
        </form>
      </GlassCard>

      <GlassCard className="p-0 flex-1 min-h-0 overflow-hidden flex flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
          {loading ? (
            <MapSectionLoader text="加载中..." />
          ) : items.length === 0 ? (
            <div className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              没有短链记录
            </div>
          ) : (
            <table className="w-full text-sm" style={{ color: 'var(--text-primary)' }}>
              <thead className="text-xs" style={{ background: 'var(--bg-sunken)', color: 'var(--text-muted)' }}>
                <tr>
                  <th className="px-3 py-2 text-left w-16">#Seq</th>
                  <th className="px-3 py-2 text-left">类型 / 标题</th>
                  <th className="px-3 py-2 text-left w-24">作者</th>
                  <th className="px-3 py-2 text-left w-24">访问</th>
                  <th className="px-3 py-2 text-left w-16">浏览</th>
                  <th className="px-3 py-2 text-left w-44">创建时间</th>
                  <th className="px-3 py-2 text-left w-40">Token</th>
                  <th className="px-3 py-2 text-right w-36">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <tr key={`${item.targetType}/${item.token}`}
                      style={{ borderTop: '1px solid var(--border-subtle)', opacity: item.share?.isRevoked ? 0.55 : 1 }}>
                    <td className="px-3 py-2 font-mono">/s/{item.seq}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="subtle">{TARGET_TYPE_LABELS[item.targetType] ?? item.targetType}</Badge>
                        <span className="truncate" style={{ color: 'var(--text-primary)' }}>
                          {item.share?.title || <em style={{ color: 'var(--text-muted)' }}>（无标题）</em>}
                        </span>
                        {item.share?.isRevoked && <Badge variant="danger">已吊销</Badge>}
                        {item.share?.expiresAt && new Date(item.share.expiresAt) < new Date() && (
                          <Badge variant="warning">已过期</Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {item.share?.createdByName || item.share?.createdBy || '-'}
                    </td>
                    <td className="px-3 py-2">
                      {item.share?.accessLevel === 'password' ? (
                        <Badge variant="warning">密码</Badge>
                      ) : item.share ? (
                        <Badge variant="success">公开</Badge>
                      ) : (
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>-</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">{item.share?.viewCount ?? 0}</td>
                    <td className="px-3 py-2 text-xs">{fmtDate(item.createdAt)}</td>
                    <td className="px-3 py-2 font-mono text-xs truncate" title={item.token}>{item.token}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        <Button size="xs" variant="ghost" onClick={() => handleCopy(item)} title="复制短链">
                          <Copy size={12} />
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => handleOpen(item)} title="新窗口打开">
                          <ExternalLink size={12} />
                        </Button>
                        <Button
                          size="xs"
                          variant="danger"
                          onClick={() => void handleRevoke(item)}
                          disabled={busy === item.seq || !!item.share?.isRevoked}
                          title={item.share?.isRevoked ? '已吊销' : '强制吊销'}
                        >
                          {busy === item.seq ? <MapSpinner size={12} /> : <X size={12} />}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* skip > 0 时即使 total <= PAGE_SIZE 也要保留导航，避免筛选后困在空页 */}
        {(total > PAGE_SIZE || skip > 0) && (
          <div className="p-3 flex items-center justify-between text-xs" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <span style={{ color: 'var(--text-muted)' }}>
              {total === 0
                ? `共 0 条`
                : `第 ${Math.min(skip + 1, total)}-${Math.min(skip + PAGE_SIZE, total)} 条 / 共 ${total}`}
            </span>
            <div className="flex gap-2">
              <Button size="xs" variant="ghost" disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - PAGE_SIZE))}>上一页</Button>
              <Button size="xs" variant="ghost" disabled={skip + PAGE_SIZE >= total} onClick={() => setSkip(skip + PAGE_SIZE)}>下一页</Button>
            </div>
          </div>
        )}
      </GlassCard>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg text-sm z-[100]"
             style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}>
          {toast}
        </div>
      )}
    </div>
  );
}
