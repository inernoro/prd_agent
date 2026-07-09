/**
 * AgentKeyScopePanel — 统一的 Agent Key 授权作用域勾选面板(2026-07-09)。
 *
 * 一把 key 的授权 = { canCreateProjects, projects: 'all' | string[] }。本面板把它
 * 摊成三组可勾选项,签发全局 Key、项目卡钥匙两个入口共用同一套 UI,只是**默认勾选**
 * 不同(见各入口):
 *   - 签发全局 Key:默认只勾「允许创建新项目」(能 bootstrap 建项目,碰不坏现有项目)。
 *   - 项目卡钥匙:默认勾「当前项目」。
 *
 * 主题:所有颜色走 hsl(var(--*)) token(.claude/rules/cds-theme-tokens.md),禁暗色字面量。
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, FolderGit2, Loader2, PlusCircle } from 'lucide-react';

import { apiRequest, ApiError } from '@/lib/api';

export interface AgentKeyScope {
  canCreateProjects: boolean;
  /** 'all' = 操作所有现有项目;string[] = 指定项目 id 列表(空 = 不能碰现有项目)。 */
  projects: 'all' | string[];
}

interface ProjectRow {
  id: string;
  name?: string;
  slug?: string;
}

interface Props {
  value: AgentKeyScope;
  onChange: (next: AgentKeyScope) => void;
  disabled?: boolean;
  /** 高亮标注"当前项目"(项目卡入口),仅视觉提示。 */
  currentProjectId?: string;
}

export function AgentKeyScopePanel({ value, onChange, disabled, currentProjectId }: Props): JSX.Element {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    apiRequest<{ projects: ProjectRow[] }>('/api/projects')
      .then((data) => {
        if (cancelled) return;
        setProjects((data.projects || []).map((p) => ({ id: p.id, name: p.name, slug: p.slug })));
        setLoadState('ok');
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof ApiError ? err.message : String(err));
        setLoadState('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const allProjects = value.projects === 'all';
  const selectedList = allProjects ? [] : (value.projects as string[]);

  function toggleCreate(): void {
    onChange({ ...value, canCreateProjects: !value.canCreateProjects });
  }

  function toggleAll(): void {
    onChange({ ...value, projects: allProjects ? [] : 'all' });
  }

  function toggleProject(id: string): void {
    if (allProjects) return;
    // 单选:选一个项目即替换(多项目 ≥2 作用域后端暂不支持,见 projects.ts 签发校验)。
    // 再点已选项 = 取消。
    onChange({ ...value, projects: selectedList.includes(id) ? [] : [id] });
  }

  const rowClass =
    'flex items-start gap-2.5 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] px-3 py-2.5';

  return (
    <div className="space-y-2.5">
      <div className="text-sm font-medium text-foreground">授权范围</div>

      {/* 1. 允许创建新项目 */}
      <label className={rowClass + (disabled ? ' opacity-60' : ' cursor-pointer')}>
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
          checked={value.canCreateProjects}
          onChange={toggleCreate}
          disabled={disabled}
        />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <PlusCircle className="h-3.5 w-3.5 text-primary" />
            允许创建新项目
          </span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
            可调 POST /api/projects 建新项目。建成后 CDS 会返回该新项目的独立 Key，这把 Key
            本身碰不到你现有的项目。
          </span>
        </span>
      </label>

      {/* 2. 操作所有现有项目(危险) */}
      <label className={rowClass + (disabled ? ' opacity-60' : ' cursor-pointer')}>
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 accent-[hsl(var(--destructive))]"
          checked={allProjects}
          onChange={toggleAll}
          disabled={disabled}
        />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-sm font-medium text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            操作所有现有项目（管理员权限，危险）
          </span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
            等同旧的全权全局 Key，可读写所有项目的构建配置、基础设施与部署。仅在跨项目自动化时勾选。
          </span>
        </span>
      </label>

      {/* 3. 指定现有项目(多选) */}
      <div className={rowClass.replace('items-start', 'flex-col items-stretch') + (allProjects ? ' opacity-50' : '')}>
        <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-foreground">
          <FolderGit2 className="h-3.5 w-3.5" />
          指定一个现有项目
          {allProjects ? <span className="text-xs font-normal text-muted-foreground">（已选「所有项目」，无需再选）</span> : null}
        </div>
        {loadState === 'loading' ? (
          <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            加载项目列表…
          </div>
        ) : null}
        {loadState === 'error' ? (
          <div className="rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            加载项目失败：{loadError}
          </div>
        ) : null}
        {loadState === 'ok' && projects.length === 0 ? (
          <div className="py-1 text-xs text-muted-foreground">还没有任何项目。勾选上方「允许创建新项目」先建第一个。</div>
        ) : null}
        {loadState === 'ok' && projects.length > 0 ? (
          <div className="max-h-44 space-y-1 overflow-y-auto pr-1" style={{ overscrollBehavior: 'contain' }}>
            {projects.map((p) => {
              const checked = selectedList.includes(p.id);
              const isCurrent = currentProjectId === p.id;
              return (
                <label
                  key={p.id}
                  className={
                    'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-[hsl(var(--surface-sunken))]' +
                    (allProjects || disabled ? ' pointer-events-none' : '')
                  }
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
                    checked={allProjects || checked}
                    onChange={() => toggleProject(p.id)}
                    disabled={allProjects || disabled}
                  />
                  <span className="min-w-0 flex-1 truncate text-foreground">{p.name || p.slug || p.id}</span>
                  {isCurrent ? (
                    <span className="shrink-0 rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      当前项目
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 把作用域转成一行中文摘要,给 key 列表展示用。 */
export function describeAgentKeyScope(access?: AgentKeyScope | null): string {
  if (!access) return '全权（所有项目 + 建项目）';
  const parts: string[] = [];
  if (access.canCreateProjects) parts.push('建项目');
  if (access.projects === 'all') parts.push('所有现有项目');
  else if (Array.isArray(access.projects) && access.projects.length > 0) {
    parts.push(`${access.projects.length} 个指定项目`);
  }
  return parts.length > 0 ? parts.join(' + ') : '（空授权）';
}
