import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { History, RotateCcw, X } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { RelativeTime } from '@/components/ui/RelativeTime';

/** 版本元信息（不含正文） */
export type VersionMeta = {
  id: string;
  versionNumber: number;
  charCount: number;
  sizeBytes: number;
  source: string;
  restoredFromVersionId?: string | null;
  createdBy: string;
  createdByName?: string | null;
  createdAt: string;
};

/** 版本完整正文 */
export type VersionFull = VersionMeta & { content: string };

/** 版本控制接口：由可写知识库注入，DocBrowser 透传给本弹窗。 */
type ApiLike<T> = { success: boolean; data?: T | null; error?: { message?: string } | null };

export type VersionApi = {
  list: (entryId: string, page: number, pageSize: number) => Promise<ApiLike<{ items: VersionMeta[]; total: number }>>;
  get: (entryId: string, versionId: string) => Promise<ApiLike<VersionFull>>;
  restore: (entryId: string, versionId: string) => Promise<ApiLike<{ updatedAt: string; fromVersionNumber: number }>>;
};

const SOURCE_LABEL: Record<string, string> = {
  edit: '编辑',
  restore: '恢复',
  sync: '外部同步',
  import: '导入',
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

type Props = {
  entryId: string;
  entryTitle: string;
  api: VersionApi;
  /** 恢复成功后回调：把恢复后的正文 + 服务端新 updatedAt 交给 DocBrowser 就地更新 preview。 */
  onRestored: (content: string, updatedAt: string) => void;
  onClose: () => void;
};

/**
 * 知识库历史版本弹窗：左列版本列表，右列选中版本正文预览，可一键恢复。
 * 遵循 frontend-modal.md：createPortal 到 body + inline style 控高 + 滚动区 min-h:0。
 */
export function VersionHistoryModal({ entryId, entryTitle, api, onRestored, onClose }: Props) {
  const [versions, setVersions] = useState<VersionMeta[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<VersionFull | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const listFetchId = useRef(0);
  const loadList = useCallback(async () => {
    const fid = ++listFetchId.current; // 防过期响应：切换 entry 后慢响应回来不得覆盖当前列表（Bugbot）
    const res = await api.list(entryId, 1, 100);
    if (fid !== listFetchId.current) return;
    if (res.success && res.data) {
      setVersions(res.data.items);
      if (res.data.items.length > 0) setSelectedId(res.data.items[0].id);
    } else {
      setVersions([]);
      toast.error('加载版本失败', res.error?.message);
    }
  }, [api, entryId]);

  useEffect(() => { void loadList(); }, [loadList]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let alive = true;
    setDetail(null);          // 切换版本时先清空旧 detail：加载期间恢复按钮禁用、不会拿上一条快照去恢复（Bugbot）
    setDetailLoading(true);
    void api.get(entryId, selectedId).then(res => {
      if (!alive) return;
      setDetail(res.success && res.data ? res.data : null);
      setDetailLoading(false);
    });
    return () => { alive = false; };
  }, [api, entryId, selectedId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleRestore = useCallback(async () => {
    // detail 必须是当前选中版本：切换行后 detail 仍是上一条、或正在加载时，禁止用旧快照恢复（Bugbot）
    if (!detail || detailLoading || detail.id !== selectedId) return;
    setRestoring(true);
    try {
      const res = await api.restore(entryId, detail.id);
      if (res.success && res.data) {
        toast.success('已恢复到该版本', `版本 #${detail.versionNumber} 的内容已写回当前文档`);
        onRestored(detail.content, res.data.updatedAt);
        onClose();
      } else {
        toast.error('恢复失败', res.error?.message);
      }
    } finally {
      setRestoring(false);
    }
  }, [api, detail, detailLoading, selectedId, entryId, onRestored, onClose]);

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)' }}
      onClick={onClose}>
      <div
        className="rounded-xl flex flex-col"
        style={{
          width: 'min(960px, 92vw)', height: '80vh', maxHeight: '80vh',
          // 必须用不透明的 elevated 面色：--bg-card 在暗色主题是 rgba(255,255,255,0.08)（半透明卡片色），
          // 直接当弹窗底会透出背景正文造成重叠（用户实测）。浮层走 --bg-elevated（两主题均不透明）。
          background: 'var(--bg-elevated, #1e1e24)',
          border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))',
          boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
        }}
        onClick={(e) => e.stopPropagation()}>
        {/* 头部 */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <div className="flex items-center gap-2 min-w-0">
            <History size={15} style={{ color: 'var(--text-secondary, rgba(255,255,255,0.7))' }} />
            <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>历史版本</span>
            <span className="text-[12px] truncate" style={{ color: 'var(--text-muted)' }}>· {entryTitle}</span>
          </div>
          <button onClick={onClose} className="h-7 w-7 rounded-lg flex items-center justify-center cursor-pointer" style={{ color: 'var(--text-muted)' }}>
            <X size={15} />
          </button>
        </div>

        {/* 主体：左列表 + 右预览 */}
        <div className="flex-1 flex min-h-0">
          {/* 版本列表 */}
          <div className="shrink-0 flex flex-col" style={{ width: 280, borderRight: '1px solid rgba(255,255,255,0.08)', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
            {versions === null ? (
              <MapSectionLoader text="正在加载版本…" />
            ) : versions.length === 0 ? (
              <div className="px-4 py-8 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
                还没有历史版本。<br />编辑并保存文档后，这里会自动留存每一次修改。
              </div>
            ) : (
              versions.map((v, idx) => {
                const active = v.id === selectedId;
                return (
                  <button
                    key={v.id}
                    onClick={() => setSelectedId(v.id)}
                    className="text-left px-4 py-3 cursor-pointer flex flex-col gap-1"
                    style={{
                      background: active ? 'rgba(59,130,246,0.1)' : 'transparent',
                      borderLeft: active ? '2px solid rgba(59,130,246,0.7)' : '2px solid transparent',
                      borderBottom: '1px solid rgba(255,255,255,0.04)',
                    }}>
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>版本 #{v.versionNumber}</span>
                      {idx === 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(34,197,94,0.12)', color: 'rgba(34,197,94,0.95)' }}>当前</span>
                      )}
                      <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}>{SOURCE_LABEL[v.source] ?? v.source}</span>
                    </div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {/* 列表场景禁用每实例刷新定时器（最多 100 行各开一个 interval）—— 项目规则 / Bugbot */}
                      <RelativeTime value={v.createdAt} refreshIntervalMs={0} /> · {v.charCount} 字 · {formatBytes(v.sizeBytes)}
                    </div>
                    {v.createdByName && (
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{v.createdByName}</div>
                    )}
                  </button>
                );
              })
            )}
          </div>

          {/* 正文预览 */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className="flex-1 min-h-0 overflow-auto px-5 py-4" style={{ overscrollBehavior: 'contain' }}>
              {detailLoading ? (
                <MapSectionLoader text="正在加载正文…" />
              ) : detail ? (
                <pre className="text-[12px] whitespace-pre-wrap break-words font-mono" style={{ color: 'var(--text-secondary, rgba(255,255,255,0.78))', margin: 0 }}>{detail.content || '（空内容）'}</pre>
              ) : (
                <div className="text-[12px] py-8 text-center" style={{ color: 'var(--text-muted)' }}>选择左侧版本查看正文</div>
              )}
            </div>
            {/* 底部操作 */}
            <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              <button
                onClick={handleRestore}
                // 不再因「是最新快照」就禁用恢复：部分写入路径（如 AI 改写/续写、reprocess apply）
                // 不产生版本，此时 versions[0] 未必等于当前正文，禁用会让用户无法用历史撤销那次写入（Codex P2）。
                // 恢复是幂等的（内容相同则 SnapshotAsync 去重、不产生噪音版本），始终允许最安全。
                disabled={!detail || restoring || detailLoading}
                className="h-8 px-3 rounded-lg text-[12px] font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.25)', color: 'rgba(147,197,253,0.95)' }}
                title="把该版本内容写回当前文档（当前内容会自动保留为新版本）">
                {restoring ? <MapSpinner size={12} /> : <RotateCcw size={12} />}
                恢复此版本
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
