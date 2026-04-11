import { useEffect, useState } from 'react';
import { X, FileText, Loader2, AlertTriangle, Link2, ExternalLink } from 'lucide-react';
import {
  getPrReviewItemRaw,
  type PrReviewRawContentDto,
  type PrReviewRawFileDto,
} from '@/services/real/prReview';

interface Props {
  itemId: string;
  onClose: () => void;
}

/**
 * PR 原文查看弹窗。
 *
 * 展示内容：
 * 1. PR 描述（body，markdown 原文）
 * 2. 关联 issue body（若有）
 * 3. 变更文件列表：文件名 + 状态 + 增减行数 + 可折叠的 diff patch
 *
 * 数据来源：GET /api/pr-review/items/{id}/raw
 * 单独拉取，避免把 100KB 级别的 files 塞进列表接口拖慢常规路径。
 */
export function PrRawContentModal({ itemId, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PrReviewRawContentDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const res = await getPrReviewItemRaw(itemId);
      if (cancelled) return;
      if (res.success && res.data) {
        setData(res.data);
      } else {
        setError(res.error?.message ?? '加载失败');
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-4xl max-h-[90vh] mx-4 rounded-xl border border-white/10 bg-[#0f1014] shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-white/10 shrink-0">
          <FileText size={18} className="text-sky-300" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-white truncate">
              {data?.title ?? 'PR 原文'}
            </div>
            {data && (
              <div className="mt-0.5 text-[11px] text-white/50 font-mono truncate">
                +{data.additions} / -{data.deletions} · {data.changedFiles} files · {data.headSha.slice(0, 7)}
              </div>
            )}
          </div>
          {data?.htmlUrl && (
            <a
              href={data.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/70 hover:text-white text-xs transition"
            >
              <ExternalLink size={12} />
              GitHub
            </a>
          )}
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-5 py-4 space-y-5">
          {loading && (
            <div className="flex items-center justify-center gap-2 text-sm text-white/50 py-12">
              <Loader2 size={16} className="animate-spin" />
              加载中...
            </div>
          )}

          {error && !loading && (
            <div className="flex items-start gap-2 p-4 rounded-lg border border-red-500/30 bg-red-500/10 text-sm text-red-200">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">加载失败</div>
                <div className="text-red-200/80 mt-1">{error}</div>
              </div>
            </div>
          )}

          {data && !loading && !error && (
            <>
              {/* PR 描述 */}
              <section>
                <SectionTitle>PR 描述</SectionTitle>
                {data.body && data.body.trim() ? (
                  <pre className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-white/85 font-sans bg-black/30 rounded-lg p-4 border border-white/5">
                    {data.body}
                  </pre>
                ) : (
                  <div className="text-xs text-white/40 italic p-4 rounded-lg bg-black/20 border border-white/5">
                    （作者没有填写 PR 描述）
                  </div>
                )}
              </section>

              {/* 关联 issue */}
              {data.linkedIssueNumber && (
                <section>
                  <SectionTitle>
                    <span className="flex items-center gap-1.5">
                      <Link2 size={12} />
                      关联 Issue #{data.linkedIssueNumber}
                      {data.linkedIssueTitle && <span className="text-white/60">· {data.linkedIssueTitle}</span>}
                    </span>
                  </SectionTitle>
                  {data.linkedIssueBody && data.linkedIssueBody.trim() ? (
                    <pre className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-white/85 font-sans bg-black/30 rounded-lg p-4 border border-white/5">
                      {data.linkedIssueBody}
                    </pre>
                  ) : (
                    <div className="text-xs text-white/40 italic p-4 rounded-lg bg-black/20 border border-white/5">
                      （关联 issue 没有描述或未拉取）
                    </div>
                  )}
                </section>
              )}

              {/* 变更文件 */}
              <section>
                <SectionTitle>变更文件 ({data.files.length})</SectionTitle>
                {data.files.length === 0 ? (
                  <div className="text-xs text-white/40 italic p-4 rounded-lg bg-black/20 border border-white/5">
                    （没有变更文件）
                  </div>
                ) : (
                  <div className="space-y-2">
                    {data.files.map((f, i) => (
                      <FileEntry key={`${f.filename}-${i}`} file={f} />
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-white/50 mb-2">
      {children}
    </h3>
  );
}

function fileStatusColor(status: string): string {
  switch (status) {
    case 'added':
      return 'text-emerald-300 border-emerald-400/30 bg-emerald-400/10';
    case 'removed':
      return 'text-red-300 border-red-400/30 bg-red-400/10';
    case 'renamed':
      return 'text-sky-300 border-sky-400/30 bg-sky-400/10';
    case 'modified':
    default:
      return 'text-amber-300 border-amber-400/30 bg-amber-400/10';
  }
}

function FileEntry({ file }: { file: PrReviewRawFileDto }) {
  const [open, setOpen] = useState(false);
  const statusColor = fileStatusColor(file.status);

  return (
    <div className="rounded-lg border border-white/10 bg-black/20 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-3 py-2 hover:bg-white/5 transition text-left"
      >
        <span className={`shrink-0 px-1.5 py-0.5 rounded border text-[10px] uppercase font-mono ${statusColor}`}>
          {file.status}
        </span>
        <span className="flex-1 min-w-0 truncate text-[12px] font-mono text-white/85">
          {file.filename}
        </span>
        <span className="shrink-0 text-[11px] font-mono text-white/50">
          <span className="text-emerald-300">+{file.additions}</span>
          {' '}
          <span className="text-red-300">-{file.deletions}</span>
        </span>
      </button>
      {open && (
        <div className="border-t border-white/5">
          {file.patch ? (
            <pre className="text-[11px] leading-relaxed font-mono whitespace-pre overflow-x-auto p-3 bg-black/40 max-h-96">
              {file.patch.split('\n').map((line, i) => {
                let cls = 'text-white/70';
                if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-emerald-300';
                else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-red-300';
                else if (line.startsWith('@@')) cls = 'text-sky-300';
                return (
                  <div key={i} className={cls}>
                    {line || ' '}
                  </div>
                );
              })}
            </pre>
          ) : (
            <div className="text-[11px] text-white/40 italic p-3">
              （无 diff 内容，可能是二进制文件、文件过大被截断，或未拉取）
            </div>
          )}
        </div>
      )}
    </div>
  );
}
