import { getFileTypeConfig } from '@/lib/fileTypeRegistry';
import type { FilePreviewKind } from '@/lib/fileTypeRegistry';
import { AudioWavePlayer } from '@/components/doc-browser/AudioWavePlayer';
import type { DocBrowserEntry, EntryPreview } from '@/components/doc-browser/DocBrowser';
import { MarkdownViewer } from './MarkdownViewer';

// ── 文件预览组件（按 fileTypeRegistry.preview 字段路由到不同渲染器） ──

export function FilePreview({ entry, preview }: { entry?: DocBrowserEntry; preview: EntryPreview | null }) {
  if (!entry) {
    return (
      <div className="text-center py-12 text-[12px]" style={{ color: 'var(--text-muted)' }}>
        请选择文件
      </div>
    );
  }
  if (entry.isFolder) {
    return (
      <div className="text-center py-12 text-[12px]" style={{ color: 'var(--text-muted)' }}>
        请选择文件夹中的文件查看内容
      </div>
    );
  }

  const cfg = getFileTypeConfig(entry.title, entry.contentType);
  const kind: FilePreviewKind = cfg.preview;
  const fileUrl = preview?.fileUrl ?? null;
  const text = preview?.text ?? null;

  // 图片预览
  if (kind === 'image' && fileUrl) {
    return (
      <div className="flex items-center justify-center py-4 w-full">
        <img
          src={fileUrl}
          alt={entry.title}
          className="max-w-full max-h-[80vh] rounded-lg"
          style={{ border: '1px solid rgba(255,255,255,0.06)', boxShadow: '0 8px 32px rgba(0,0,0,0.3)' }}
        />
      </div>
    );
  }

  // 视频预览
  if (kind === 'video' && fileUrl) {
    return (
      <div className="flex items-center justify-center py-4 w-full">
        <video
          src={fileUrl}
          controls
          className="max-w-full max-h-[80vh] rounded-lg"
          style={{ border: '1px solid rgba(255,255,255,0.06)' }}
        />
      </div>
    );
  }

  // 音频预览 — 自定义波形播放器（wavesurfer.js）
  if (kind === 'audio' && fileUrl) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center py-12 gap-5">
        <div className="flex h-14 w-14 items-center justify-center rounded-[18px]"
          style={{
            background: 'linear-gradient(135deg, rgba(168,85,247,0.15), rgba(59,130,246,0.10))',
            border: '1px solid rgba(168,85,247,0.22)',
          }}>
          <cfg.icon size={26} style={{ color: cfg.color }} />
        </div>
        <p className="text-[13px] font-semibold text-center" style={{ color: 'var(--text-primary)' }}>{entry.title}</p>
        <AudioWavePlayer src={fileUrl} />
      </div>
    );
  }

  // PDF 预览（iframe 嵌入，浏览器原生支持）
  if (kind === 'pdf' && fileUrl) {
    return (
      <iframe
        src={fileUrl}
        title={entry.title}
        className="w-full rounded-lg"
        style={{ height: '100%', minHeight: 420, border: '1px solid rgba(255,255,255,0.06)' }}
      />
    );
  }

  // HTML 预览：sandbox iframe 真渲染（禁脚本/表单/同源，仅静态 HTML+CSS，防 XSS）。
  // 上传的 .html 文件走 fileUrl；导入/手写的 HTML 正文（存于 document content）走 srcDoc，
  // 两者都渲染成页面而非源码（编辑态仍可改源码）。registry kind 之外再兜底按 contentType/扩展名识别。
  const isHtmlFile = kind === 'html'
    || (entry.contentType ?? '').toLowerCase().includes('html') || /\.html?$/i.test(entry.title);
  if (isHtmlFile && (fileUrl || text)) {
    return (
      <iframe
        {...(fileUrl ? { src: fileUrl } : { srcDoc: text ?? '' })}
        title={entry.title}
        sandbox=""
        className="w-full rounded-lg"
        style={{ height: '100%', minHeight: 480, border: '1px solid rgba(255,255,255,0.06)', background: '#fff' }}
      />
    );
  }

  // 文本预览（Markdown / 提取后的 Office 文本 / 代码）
  if ((kind === 'text' || kind === 'html') && text) {
    return <MarkdownViewer content={text} />;
  }

  // 引用类条目（如"转存自网页托管"）：本地没有 attachment / document content，
  // 但 metadata 里带了公开 sourceUrl —— 直接 iframe 嵌入该公开链接作预览
  const referenceUrl = entry.metadata?.sourceUrl;
  if (!fileUrl && !text && referenceUrl) {
    return (
      <div className="flex h-full w-full flex-col">
        <div className="mb-2 flex items-center justify-between gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          <span className="truncate">引用自：{referenceUrl}</span>
          <a
            href={referenceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-6 items-center gap-1 rounded-[6px] px-2 text-[11px] transition-colors hover:bg-white/6"
            style={{ color: 'var(--accent-primary)' }}
          >
            新窗口打开
          </a>
        </div>
        <iframe
          src={referenceUrl}
          title={entry.title}
          className="w-full rounded-lg"
          style={{ height: 'calc(100vh - 240px)', border: '1px solid rgba(255,255,255,0.06)' }}
        />
      </div>
    );
  }

  // 兜底：有 fileUrl 但无可用预览方式 → 显示下载链接
  if (fileUrl) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4">
        <cfg.icon size={48} style={{ color: cfg.color }} />
        <p className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{entry.title}</p>
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{cfg.label} 文件不支持在线预览</p>
        <a
          href={fileUrl}
          target="_blank"
          rel="noopener noreferrer"
          download={entry.title}
          className="h-8 px-4 rounded-[8px] text-[12px] font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
          style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', color: 'rgba(59,130,246,0.9)' }}
        >
          下载文件
        </a>
      </div>
    );
  }

  // GitHub 目录订阅父条目：本身无正文（它是一个目录容器，正文在它同步下来的各文件里）。
  // 历史上它被建成"无内容的可点击叶子"，点开就空白 ——这里给一张目录卡片，
  // 展示仓库/路径/分支 + 跳转 GitHub，避免"打不开"。
  const md = entry.metadata ?? {};
  const isGithubDir = entry.sourceType === 'github_directory' || entry.contentType === 'application/x-github-directory';
  if (isGithubDir) {
    const owner = md.github_owner;
    const repo = md.github_repo;
    const path = md.github_path;
    const branch = md.github_branch || 'main';
    const ghUrl = owner && repo
      ? `https://github.com/${owner}/${repo}/tree/${branch}/${path ?? ''}`.replace(/\/$/, '')
      : (md.sourceUrl || entry.metadata?.sourceUrl);
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
        <cfg.icon size={44} style={{ color: cfg.color }} />
        <p className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{entry.title}</p>
        <p className="text-[12px] max-w-[420px]" style={{ color: 'var(--text-muted)' }}>
          这是一个 GitHub 目录订阅。它本身不含正文——同步下来的文件已作为独立文档收录在本知识库中，可在左侧目录里查看。
        </p>
        {(owner && repo) && (
          <div className="text-[11px] font-mono px-3 py-2 rounded-[8px]"
            style={{ background: 'var(--bg-tertiary, rgba(255,255,255,0.04))', color: 'var(--text-secondary)', border: '1px solid var(--border-faint)' }}>
            {owner}/{repo} · {path || '/'} · {branch}
          </div>
        )}
        {ghUrl && (
          <a href={ghUrl} target="_blank" rel="noopener noreferrer"
            className="h-8 px-4 rounded-[8px] text-[12px] font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
            style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', color: 'rgba(59,130,246,0.9)' }}>
            在 GitHub 打开
          </a>
        )}
      </div>
    );
  }

  // 完全无内容
  return (
    <div className="text-center py-12 text-[12px]" style={{ color: 'var(--text-muted)' }}>
      暂无可预览的内容
    </div>
  );
}

export default FilePreview;
