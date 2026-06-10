import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Clipboard, ExternalLink, FolderSearch, Search, X } from 'lucide-react';
import { toast } from '@/lib/toast';
import {
  FRONT_END_PROJECT_KIND_LABEL,
  FRONT_END_PROJECTS,
  type FrontEndProjectEntry,
} from './frontEndProjectRegistry';

function searchableText(project: FrontEndProjectEntry): string {
  return [
    project.name,
    project.kind,
    project.tech,
    project.codingUrl,
    project.githubUrl,
    project.svnUrl,
    project.docUrl,
    project.buildUrl,
    project.localUrl,
    project.branches,
    project.release,
    project.notes,
    ...project.tags,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function getPrimaryUrl(project: FrontEndProjectEntry): string | undefined {
  return project.codingUrl ?? project.githubUrl ?? project.svnUrl ?? project.localUrl ?? project.buildUrl ?? project.docUrl;
}

function projectAddressSummary(project: FrontEndProjectEntry): string {
  const lines = [
    `项目：${project.name}`,
    `类型：${FRONT_END_PROJECT_KIND_LABEL[project.kind]}`,
    `技术栈：${project.tech}`,
    project.codingUrl ? `Coding：${project.codingUrl}` : null,
    project.githubUrl ? `GitHub：${project.githubUrl}` : null,
    project.svnUrl ? `SVN：${project.svnUrl}` : null,
    project.docUrl ? `文档：${project.docUrl}` : null,
    project.buildUrl ? `构建：${project.buildUrl}` : null,
    project.localUrl ? `访问/本地：${project.localUrl}` : null,
    project.branches ? `分支：${project.branches}` : null,
    project.release ? `发布：${project.release}` : null,
    project.notes ? `备注：${project.notes}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

function AddressLink({ label, url }: { label: string; url?: string }) {
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="fea-link inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-sky-200/85 hover:bg-white/[0.08]"
      title={url}
    >
      {label}
      <ExternalLink className="w-3 h-3" />
    </a>
  );
}

function useProjectSearch() {
  const [query, setQuery] = useState('');

  const filteredProjects = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return FRONT_END_PROJECTS;
    return FRONT_END_PROJECTS.filter((project) => searchableText(project).includes(q));
  }, [query]);

  return { query, setQuery, filteredProjects, total: FRONT_END_PROJECTS.length };
}

function ProjectTableBody({
  projects,
  onCopy,
}: {
  projects: FrontEndProjectEntry[];
  onCopy: (project: FrontEndProjectEntry) => void;
}) {
  if (projects.length === 0) {
    return (
      <div className="px-4 py-8 text-sm text-white/45 text-center">
        没有匹配的前端项目。换个项目名、仓库名或技术栈试试。
      </div>
    );
  }

  return (
    <div className="divide-y divide-white/10">
      {projects.map((project) => {
        const primaryUrl = getPrimaryUrl(project);
        return (
          <article key={`${project.name}-${primaryUrl ?? project.tech}`} className="px-4 py-3 hover:bg-white/[0.025] transition-colors duration-200">
            <div className="flex flex-col gap-2 xl:flex-row xl:items-start xl:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-medium text-white">{project.name}</h3>
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-white/55">
                    {FRONT_END_PROJECT_KIND_LABEL[project.kind]}
                  </span>
                  <span className="text-[11px] text-white/45">{project.tech}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <AddressLink label="Coding" url={project.codingUrl} />
                  <AddressLink label="GitHub" url={project.githubUrl} />
                  <AddressLink label="SVN" url={project.svnUrl} />
                  <AddressLink label="文档" url={project.docUrl} />
                  <AddressLink label="构建" url={project.buildUrl} />
                  <AddressLink label="访问" url={project.localUrl} />
                </div>
                {(project.branches || project.release || project.notes) && (
                  <p className="mt-2 line-clamp-2 text-[11px] leading-5 text-white/45">
                    {[project.branches, project.release, project.notes].filter(Boolean).join('；')}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => onCopy(project)}
                className="fea-btn h-8 shrink-0 rounded-lg border border-white/10 bg-white/5 px-2.5 text-[11px] text-white/65 hover:bg-white/10 inline-flex items-center gap-1.5"
              >
                <Clipboard className="w-3.5 h-3.5" />
                复制地址
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function FrontEndProjectRailCard({ onOpen }: { onOpen: () => void }) {
  const preview = FRONT_END_PROJECTS.slice(0, 3);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="fea-rail-card w-full text-left rounded-2xl border border-sky-400/20 bg-gradient-to-br from-sky-500/[0.12] to-cyan-500/[0.04] p-4 hover:border-sky-300/35 hover:shadow-[0_8px_32px_rgba(14,165,233,0.12)]"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl border border-sky-400/30 bg-sky-500/15 flex items-center justify-center shrink-0">
            <FolderSearch className="w-4 h-4 text-sky-200" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-white">前端项目表</h3>
            <p className="text-[11px] text-sky-100/55 mt-0.5">{FRONT_END_PROJECTS.length} 个仓库地址</p>
          </div>
        </div>
        <ChevronRight className="w-4 h-4 text-sky-200/50 shrink-0 mt-1" />
      </div>
      <div className="mt-3 space-y-1.5">
        {preview.map((p) => (
          <div key={p.name} className="text-[11px] text-white/50 truncate pl-0.5">
            <span className="text-white/70">{p.name}</span>
            <span className="text-white/30 mx-1">·</span>
            <span>{FRONT_END_PROJECT_KIND_LABEL[p.kind]}</span>
          </div>
        ))}
        <p className="text-[10px] text-sky-200/45 pt-0.5">点击查看完整列表与搜索</p>
      </div>
    </button>
  );
}

export function FrontEndProjectTableModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { query, setQuery, filteredProjects, total } = useProjectSearch();

  const copyProject = useCallback(async (project: FrontEndProjectEntry) => {
    await navigator.clipboard.writeText(projectAddressSummary(project));
    toast.success(`已复制 ${project.name} 的项目地址`);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const modal = (
    <div
      className="fea-modal-backdrop fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/65 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="前端项目表"
        className="fea-modal-panel w-full max-w-4xl rounded-2xl border border-white/10 bg-[#0b0d12] shadow-2xl flex flex-col"
        style={{ height: '90vh', maxHeight: '90vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-5 py-4 border-b border-white/10 flex items-center justify-between gap-3">
          <div className="min-w-0 flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl border border-sky-400/25 bg-sky-500/10 flex items-center justify-center">
              <FolderSearch className="w-4 h-4 text-sky-200" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-white">前端项目表</h2>
              <p className="text-[11px] text-white/45">内置 {total} 个项目，支持按名称、仓库、技术栈搜索</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="fea-btn h-8 w-8 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 inline-flex items-center justify-center text-white/60"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="shrink-0 px-5 py-3 border-b border-white/10">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/35" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜：会员 / dcrm / SVN / uniapp / 构建地址"
              className="w-full h-9 rounded-xl border border-white/10 bg-black/20 pl-8 pr-3 text-xs text-white placeholder:text-white/25 outline-none focus:border-sky-300/35 transition-colors duration-200"
              autoFocus
            />
          </div>
          <p className="mt-2 text-[11px] text-white/35">匹配 {filteredProjects.length} 条</p>
        </div>

        <div
          className="flex-1"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          <ProjectTableBody projects={filteredProjects} onCopy={copyProject} />
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
