import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/design/Button';
import { Database, Filter, FileText, Settings } from 'lucide-react';
import {
  listDocumentStoresWithPreview,
  listDocumentEntries,
  getDocumentContent,
} from '@/services';
import type { DocumentStore, DocumentEntry } from '@/services/contracts/documentStore';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';

const STORAGE_KEY = 'weekly-reports-tab-config';

type Config = { storeId: string; prefix: string };

function readConfig(): Config | null {
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved) as Config;
    if (!parsed?.storeId) return null;
    return { storeId: parsed.storeId, prefix: parsed.prefix ?? '' };
  } catch {
    return null;
  }
}

export function WeeklyReportsTab() {
  const [config, setConfig] = useState<Config | null>(() => readConfig());
  const [stores, setStores] = useState<DocumentStore[]>([]);
  const [entries, setEntries] = useState<DocumentEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loadingStores, setLoadingStores] = useState(false);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // 首次加载：拉所有知识库（下拉选择用）
  useEffect(() => {
    let alive = true;
    setLoadingStores(true);
    listDocumentStoresWithPreview(1, 200)
      .then(res => {
        if (!alive) return;
        if (res.success) setStores(res.data.items);
      })
      .finally(() => { if (alive) setLoadingStores(false); });
    return () => { alive = false; };
  }, []);

  // 跟随 config 变化：加载选中知识库的条目
  useEffect(() => {
    if (!config) { setEntries([]); return; }
    let alive = true;
    setLoadingEntries(true);
    listDocumentEntries(config.storeId, 1, 500)
      .then(res => {
        if (!alive) return;
        if (res.success) setEntries(res.data.items);
        else toast.error('加载条目失败', res.error?.message);
      })
      .finally(() => { if (alive) setLoadingEntries(false); });
    return () => { alive = false; };
  }, [config]);

  // 前端过滤 + 按最新时间倒序
  const filtered = useMemo(() => {
    if (!config) return [];
    const q = (config.prefix || '').trim().toLowerCase();
    const pool = entries.filter(e => !e.isFolder);
    const matched = q
      ? pool.filter(e => e.title.toLowerCase().includes(q))
      : pool;
    return [...matched].sort((a, b) => {
      const at = a.lastChangedAt || a.updatedAt || a.createdAt || '';
      const bt = b.lastChangedAt || b.updatedAt || b.createdAt || '';
      return bt.localeCompare(at);
    });
  }, [config, entries]);

  // 默认自动选中最新一篇；过滤变化后如选中不在列表里则切到最新
  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId(prev => {
      if (prev && filtered.some(e => e.id === prev)) return prev;
      return filtered[0].id;
    });
  }, [filtered]);

  // 加载选中条目内容
  useEffect(() => {
    if (!selectedId) { setContent(null); return; }
    let alive = true;
    setLoadingContent(true);
    getDocumentContent(selectedId)
      .then(res => {
        if (!alive) return;
        if (res.success) {
          setContent(res.data.hasContent && res.data.content
            ? res.data.content
            : '（此文件暂无可直接渲染的文本内容）');
        } else {
          setContent(`❌ 加载失败：${res.error?.message || '未知错误'}`);
        }
      })
      .finally(() => { if (alive) setLoadingContent(false); });
    return () => { alive = false; };
  }, [selectedId]);

  const handleSaveConfig = (next: Config) => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setConfig(next);
    setShowSettings(false);
    setSelectedId(null);
  };

  // == 初次进入 / 重新配置 ==
  if (!config || showSettings) {
    return (
      <SetupPanel
        stores={stores}
        initial={config}
        loading={loadingStores}
        onCancel={config ? () => setShowSettings(false) : undefined}
        onConfirm={handleSaveConfig}
      />
    );
  }

  const currentStore = stores.find(s => s.id === config.storeId);
  const currentEntry = filtered.find(e => e.id === selectedId);

  return (
    <div
      className="flex flex-col"
      style={{ height: 'calc(100vh - 140px)', minHeight: '500px' }}
    >
      {/* ── 顶部操作条 ── */}
      <div
        className="flex items-center justify-between mb-4"
        style={{ flexShrink: 0 }}
      >
        <div className="flex items-center gap-3 pl-1 flex-wrap">
          <div
            className="px-2.5 py-1 rounded-md text-[11px] font-bold font-mono tracking-wider"
            style={{
              background: 'rgba(168, 85, 247, 0.1)',
              border: '1px solid rgba(168, 85, 247, 0.3)',
              color: '#d8b4fe',
            }}
          >● LIVE</div>
          <span className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
            {currentStore?.name || '（未知知识库）'}
          </span>
          {config.prefix && (
            <span
              className="text-[11px] flex items-center gap-1 px-1.5 py-0.5 rounded-md"
              style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)' }}
            >
              <Filter size={10} />
              匹配：{config.prefix}
            </span>
          )}
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            共 {filtered.length} 篇
          </span>
        </div>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setShowSettings(true)}
          className="rounded-lg text-[12px] h-8 px-3 transition-colors bg-white/5 hover:bg-white/10"
          style={{ color: 'var(--text-secondary)' }}
        >
          <Settings size={14} className="mr-1.5" />
          重新选择
        </Button>
      </div>

      {/* ── 主体：左右独立滚动 ── */}
      <div
        className="flex gap-3 rounded-2xl"
        style={{
          flex: 1,
          minHeight: 0,
          background: 'rgba(0,0,0,0.25)',
          border: '1px solid rgba(255,255,255,0.08)',
          padding: '12px',
          overflow: 'hidden',
        }}
      >
        {/* 左：文件列表（独立滚动） */}
        <aside
          className="flex flex-col rounded-xl"
          style={{
            width: '300px',
            flexShrink: 0,
            minHeight: 0,
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.04)',
            overflow: 'hidden',
          }}
        >
          <div
            className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider"
            style={{
              color: 'var(--text-muted)',
              borderBottom: '1px solid rgba(255,255,255,0.04)',
              flexShrink: 0,
            }}
          >
            周报列表 · 按最新更新排序
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              overscrollBehavior: 'contain',
            }}
          >
            {loadingEntries ? (
              <div className="py-10"><MapSectionLoader text="正在加载…" /></div>
            ) : filtered.length === 0 ? (
              <div className="p-4 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {entries.length === 0
                  ? '该知识库暂无文件'
                  : config.prefix
                    ? `没有匹配「${config.prefix}」的文件`
                    : '暂无文件'}
              </div>
            ) : (
              <ul className="py-1">
                {filtered.map(e => {
                  const active = selectedId === e.id;
                  const date = (e.lastChangedAt || e.updatedAt || e.createdAt || '').slice(0, 10);
                  return (
                    <li key={e.id}>
                      <button
                        onClick={() => setSelectedId(e.id)}
                        className="w-full text-left px-3 py-2 transition-colors"
                        style={{
                          background: active ? 'rgba(168,85,247,0.12)' : 'transparent',
                          color: active ? '#e9d5ff' : 'var(--text-secondary)',
                          borderLeft: `2px solid ${active ? 'rgba(168,85,247,0.6)' : 'transparent'}`,
                          cursor: 'pointer',
                        }}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText size={12} style={{ flexShrink: 0, opacity: 0.7 }} />
                          <span className="text-[12px] truncate flex-1">{e.title}</span>
                        </div>
                        {date && (
                          <div
                            className="text-[10px] mt-0.5"
                            style={{ paddingLeft: 20, color: 'var(--text-muted)' }}
                          >
                            {date}
                          </div>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        {/* 右：内容（独立滚动） */}
        <section
          className="flex flex-col rounded-xl"
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.04)',
            overflow: 'hidden',
          }}
        >
          <div
            className="px-4 py-2.5 text-[13px] font-semibold truncate"
            style={{
              borderBottom: '1px solid rgba(255,255,255,0.04)',
              color: 'var(--text-primary)',
              flexShrink: 0,
            }}
          >
            {currentEntry?.title || '（未选中文件）'}
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              overscrollBehavior: 'contain',
              padding: '20px 28px',
            }}
          >
            {loadingContent ? (
              <div className="py-10"><MapSectionLoader text="加载内容中…" /></div>
            ) : content == null ? (
              <div className="text-center text-[12px] py-10" style={{ color: 'var(--text-muted)' }}>
                左侧点击一篇周报查看内容
              </div>
            ) : (
              <MarkdownContent content={content} />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

// ── 配置面板：选知识库 + 填文件名关键词 ──
function SetupPanel({
  stores,
  initial,
  loading,
  onCancel,
  onConfirm,
}: {
  stores: DocumentStore[];
  initial: Config | null;
  loading: boolean;
  onCancel?: () => void;
  onConfirm: (cfg: Config) => void;
}) {
  const [storeId, setStoreId] = useState(initial?.storeId || '');
  const [prefix, setPrefix] = useState(initial?.prefix ?? 'week');

  const handleConfirm = () => {
    if (!storeId) {
      toast.error('请先选择一个知识库');
      return;
    }
    onConfirm({ storeId, prefix: prefix.trim() });
  };

  return (
    <div
      className="mt-8 mx-auto max-w-xl rounded-2xl p-8"
      style={{
        background: 'linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
      }}
    >
      <div className="flex flex-col items-center text-center gap-4 mb-8">
        <div
          className="w-16 h-16 rounded-2xl flex items-center justify-center"
          style={{
            background: 'rgba(168,85,247,0.1)',
            border: '1px solid rgba(168,85,247,0.25)',
            color: '#d8b4fe',
          }}
        >
          <Database size={32} />
        </div>
        <div>
          <h2 className="text-xl font-bold text-white tracking-wide mb-2">选择周报来源</h2>
          <p className="text-sm text-gray-400 leading-relaxed">
            从已有的知识库里挑一个，再给一个文件名关键词。<br />
            只在当前页做展示过滤，不会修改知识库任何数据。
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <label className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            选择知识库
          </label>
          <select
            value={storeId}
            onChange={e => setStoreId(e.target.value)}
            disabled={loading}
            className="w-full h-11 px-4 rounded-xl outline-none text-[13px]"
            style={{
              background: 'rgba(0,0,0,0.2)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: 'var(--text-primary)',
            }}
          >
            <option value="">{loading ? '正在加载知识库…' : '— 请选择 —'}</option>
            {stores.map(s => (
              <option key={s.id} value={s.id}>
                {s.name}（{s.documentCount} 项）
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            文件名关键词（留空则全部显示）
          </label>
          <input
            value={prefix}
            onChange={e => setPrefix(e.target.value)}
            placeholder='例如 "week" 或 "周报"'
            className="w-full h-11 px-4 rounded-xl outline-none text-[13px] font-mono"
            style={{
              background: 'rgba(0,0,0,0.2)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: 'var(--text-primary)',
            }}
          />
          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            纯前端过滤，不区分大小写，按子串匹配。不订阅、不抓取、不改动后端任何数据。
          </p>
        </div>

        <div className="flex gap-3 mt-2">
          {onCancel && (
            <Button
              variant="ghost"
              className="flex-1 h-11 rounded-xl text-[13px]"
              onClick={onCancel}
            >
              取消
            </Button>
          )}
          <Button
            variant="primary"
            className="flex-1 h-11 text-[13px] font-bold rounded-xl flex items-center justify-center gap-2"
            style={{
              background: 'linear-gradient(135deg, #a855f7 0%, #7e22ce 100%)',
              border: '1px solid rgba(255,255,255,0.1)',
              boxShadow: '0 4px 12px rgba(168,85,247,0.3)',
            }}
            onClick={handleConfirm}
            disabled={loading}
          >
            {loading ? <MapSpinner size={14} /> : <Database size={16} />}
            开始浏览
          </Button>
        </div>
      </div>
    </div>
  );
}
