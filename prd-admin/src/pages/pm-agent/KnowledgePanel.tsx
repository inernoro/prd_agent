import { useCallback, useEffect, useRef, useState } from 'react';
import { Upload, Trash2, Download, Globe, FolderOpen } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { getFileTypeConfig } from '@/lib/fileTypeRegistry';
import { toast } from '@/lib/toast';
import {
  listPmKnowledgeFiles, uploadPmKnowledgeFile, deletePmKnowledgeFile, getPmMemberSites,
} from '@/services';
import type { PmKnowledgeFile, PmMemberSite } from '@/services/contracts/pmAgent';

interface Props {
  projectId: string;
}

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 项目知识库 — 多格式文件上传/分类/下载/删除 + 成员托管站点免密聚合。
 * 上传走原生 fetch+FormData（规则 #7：不走 apiRequest）。
 */
export function KnowledgePanel({ projectId }: Props) {
  const [files, setFiles] = useState<PmKnowledgeFile[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [activeCat, setActiveCat] = useState<string>('');
  const [sites, setSites] = useState<PmMemberSite[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [fr, sr] = await Promise.all([
      listPmKnowledgeFiles(projectId, activeCat || undefined),
      getPmMemberSites(projectId),
    ]);
    if (fr.success) { setFiles(fr.data.files); setCategories(fr.data.categories); }
    else toast.error('加载失败', fr.error?.message || '');
    if (sr.success) setSites(sr.data.sites);
    setLoading(false);
  }, [projectId, activeCat]);

  useEffect(() => { load(); }, [load]);

  const handleUpload = async (file: File) => {
    setUploading(true);
    const res = await uploadPmKnowledgeFile(projectId, file, activeCat || undefined);
    setUploading(false);
    if (res.success) { toast.success('已上传', file.name); load(); }
    else toast.error('上传失败', res.error?.message || '');
  };

  const handleDelete = async (f: PmKnowledgeFile) => {
    if (!window.confirm(`确定删除「${f.fileName}」？`)) return;
    const res = await deletePmKnowledgeFile(f.id);
    if (res.success) { setFiles((prev) => prev.filter((x) => x.id !== f.id)); toast.success('已删除', ''); }
    else toast.error('删除失败', res.error?.message || '');
  };

  if (loading) return <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在加载知识库…" /></div>;

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
      {/* 工具栏 */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>项目知识库</div>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>多格式文件 + 分类管理（单文件 ≤ 50MB）</span>
        <input ref={fileInputRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.currentTarget.value = ''; }} />
        <Button variant="primary" size="sm" className="ml-auto" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
          {uploading ? <MapSpinner size={13} /> : <Upload size={13} />}上传文件
        </Button>
      </div>

      {/* 分类筛选 */}
      <div className="flex items-center gap-1.5 flex-wrap text-[12px]">
        <button onClick={() => setActiveCat('')} className="px-2.5 py-1 rounded-md border"
          style={{ background: !activeCat ? 'rgba(59,130,246,0.15)' : 'var(--bg-input)', borderColor: !activeCat ? '#3B82F6' : 'var(--border-subtle)', color: !activeCat ? '#3B82F6' : 'var(--text-secondary)' }}>
          全部
        </button>
        {categories.map((c) => (
          <button key={c} onClick={() => setActiveCat(c)} className="px-2.5 py-1 rounded-md border"
            style={{ background: activeCat === c ? 'rgba(59,130,246,0.15)' : 'var(--bg-input)', borderColor: activeCat === c ? '#3B82F6' : 'var(--border-subtle)', color: activeCat === c ? '#3B82F6' : 'var(--text-secondary)' }}>
            {c}
          </button>
        ))}
      </div>

      {/* 文件列表 */}
      {files.length === 0 ? (
        <div className="text-[12px] text-center py-8 rounded-lg border border-dashed" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
          <FolderOpen size={28} className="mx-auto mb-2" style={{ opacity: 0.5 }} />
          {activeCat ? `「${activeCat}」分类下暂无文件` : '还没有文件，点右上角「上传文件」'}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {files.map((f) => {
            const cfg = getFileTypeConfig(f.fileName, f.contentType);
            const Icon = cfg.icon;
            return (
              <div key={f.id} className="group flex items-center gap-3 rounded-lg border px-3 py-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
                <Icon size={18} className="shrink-0" style={{ color: cfg.color }} />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] truncate" style={{ color: 'var(--text-primary)' }}>{f.fileName}</div>
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{f.category}·{fmtSize(f.fileSize)}·{f.uploaderName || '—'}</div>
                </div>
                <a href={f.url} target="_blank" rel="noreferrer" download className="opacity-0 group-hover:opacity-100 p-1 rounded shrink-0" style={{ color: 'var(--text-muted)' }} title="下载"><Download size={15} /></a>
                <button onClick={() => handleDelete(f)} className="opacity-0 group-hover:opacity-100 p-1 rounded shrink-0" style={{ color: 'var(--text-muted)' }} title="删除"><Trash2 size={15} /></button>
              </div>
            );
          })}
        </div>
      )}

      {/* 成员托管站点（免密聚合） */}
      <div className="mt-2">
        <div className="flex items-center gap-1.5 mb-2">
          <Globe size={14} style={{ color: '#10B981' }} />
          <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>成员托管站点</span>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>项目成员用「网页托管」发布的站点，点开免密查看</span>
        </div>
        {sites.length === 0 ? (
          <div className="text-[11px] text-center py-4 rounded-lg border border-dashed" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
            暂无成员发布的公开站点
          </div>
        ) : (
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
            {sites.map((s) => (
              <button key={s.siteId} onClick={() => window.open(s.url, '_blank', 'noopener')} className="text-left rounded-lg border px-3 py-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
                <div className="text-[12.5px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{s.title || '未命名站点'}</div>
                <div className="text-[11px] mt-0.5 inline-flex items-center gap-1" style={{ color: 'var(--text-muted)' }}><Globe size={10} />{s.userName}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
