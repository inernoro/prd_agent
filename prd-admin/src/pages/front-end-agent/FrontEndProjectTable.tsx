import { useMemo, useState } from 'react';
import { Clipboard, ExternalLink, FolderSearch, Search } from 'lucide-react';
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
      className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-sky-200/85 hover:bg-white/[0.08]"
      title={url}
    >
      {label}
      <ExternalLink className="w-3 h-3" />
    </a>
  );
}

export function FrontEndProjectTable() {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);

  const visibleProjects = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? FRONT_END_PROJECTS.filter((project) => searchableText(project).includes(q))
      : FRONT_END_PROJECTS;
    return expanded ? list : list.slice(0, 8);
  }, [expanded, query]);

  const totalMatched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? FRONT_END_PROJECTS.filter((project) => searchableText(project).includes(q)).length : FRONT_END_PROJECTS.length;
  }, [query]);

  const copyProject = async (project: FrontEndProjectEntry) => {
    await navigator.clipboard.writeText(projectAddressSummary(project));
    toast.success(`已复制 ${project.name} 的项目地址`);
  };

  return (
    <section className="shrink-0 rounded-2xl border border-white/10 bg-white/[0.035] overflow-hidden">
      <div className="px-4 py-3 border-b border-white/10 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl border border-sky-400/25 bg-sky-500/10 flex items-center justify-center">
            <FolderSearch className="w-4 h-4 text-sky-200" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-white">前端项目表</h2>
            <p className="text-[11px] text-white/45 truncate">
              内置 {FRONT_END_PROJECTS.length} 个项目地址，可按项目名、仓库、技术栈、构建地址搜索。
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 w-full lg:w-80">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/35" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜：会员 / dcrm / SVN / uniapp / 构建地址"
              className="w-full h-9 rounded-xl border border-white/10 bg-black/20 pl-8 pr-3 text-xs text-white placeholder:text-white/25 outline-none focus:border-sky-300/35"
            />
          </div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="h-9 shrink-0 rounded-xl border border-white/10 bg-white/5 px-3 text-xs text-white/65 hover:bg-white/10"
          >
            {expanded ? '收起' : '展开'}
          </button>
        </div>
      </div>

      <div style={{ maxHeight: expanded ? 420 : 260, overflowY: 'auto', overscrollBehavior: 'contain' }}>
        {visibleProjects.length === 0 ? (
          <div className="px-4 py-6 text-sm text-white/45">没有匹配的前端项目。换个项目名、仓库名或技术栈试试。</div>
        ) : (
          <div className="divide-y divide-white/10">
            {visibleProjects.map((project) => {
              const primaryUrl = getPrimaryUrl(project);
              return (
                <article key={`${project.name}-${primaryUrl ?? project.tech}`} className="px-4 py-3 hover:bg-white/[0.025]">
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
                      onClick={() => copyProject(project)}
                      className="h-8 shrink-0 rounded-lg border border-white/10 bg-white/5 px-2.5 text-[11px] text-white/65 hover:bg-white/10 inline-flex items-center gap-1.5"
                    >
                      <Clipboard className="w-3.5 h-3.5" />
                      复制地址
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {!expanded && totalMatched > visibleProjects.length && (
        <div className="px-4 py-2 border-t border-white/10 text-[11px] text-white/40">
          当前显示前 {visibleProjects.length} 条，匹配共 {totalMatched} 条；点击“展开”查看全部。
        </div>
      )}
    </section>
  );
}

