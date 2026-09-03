/*
 * BranchRelationsPage — 全屏关系图（plan.cds.service-relations 第四批）。独立路由，可分享。
 * 与总览缩略卡、半屏抽屉、cdscli topology 读同一份 service-graph 数据。
 */
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Copy, Minimize2, RefreshCw } from 'lucide-react';
import { AppShell, Crumb, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { FindingsList, useRelationPayload } from '@/components/branch/RelationCard';
import { RelationGraph, relationHeadline } from '@/components/branch/RelationGraph';

export function BranchRelationsPage(): JSX.Element {
  const { branchId } = useParams<{ branchId: string }>();
  const navigate = useNavigate();
  const { state, reload } = useRelationPayload(branchId);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const data = state.status === 'ok' ? state.data : null;
  return (
    <AppShell
      active="projects"
      wide
      topbar={(
        <TopBar
          left={<Crumb items={[{ label: 'CDS', href: '/project-list' }, { label: '分支', href: branchId ? `/branch-panel/${encodeURIComponent(branchId)}` : '/branch-list' }, { label: '关系图' }]} />}
          right={(
            <>
              {data ? (
                <>
                  {data.lint.summary.errors ? <span className="inline-flex h-[18px] items-center rounded-full border border-destructive/60 px-1.5 text-[10px] font-semibold text-destructive">{data.lint.summary.errors} 错误</span> : null}
                  {data.lint.summary.warnings ? <span className="inline-flex h-[18px] items-center rounded-full border border-warn/60 bg-warn-soft px-1.5 text-[10px] font-semibold text-warn">{data.lint.summary.warnings} 警告</span> : null}
                </>
              ) : null}
              <Button variant={onlyProblems ? 'default' : 'outline'} size="sm" onClick={() => setOnlyProblems((v) => !v)} title="只列错误与警告">只看问题</Button>
              <Button variant="outline" size="sm" onClick={() => { void navigator.clipboard?.writeText(window.location.href); }} title="复制本页链接"><Copy />复制链接</Button>
              <Button variant="outline" size="sm" onClick={reload}><RefreshCw />刷新</Button>
              <Button variant="outline" size="sm" onClick={() => navigate(branchId ? `/branch-panel/${encodeURIComponent(branchId)}` : '/branch-list')}><Minimize2 />退出全屏</Button>
            </>
          )}
        />
      )}
    >
      <Workspace fluid className="cds-workspace--fill">
        {state.status === 'loading' ? <div className="p-6 text-xs text-muted-foreground">正在算服务关系与体检…</div> : null}
        {state.status === 'error' ? <div className="p-6 text-xs text-destructive">读取失败：{state.message}</div> : null}
        {data ? (
          <div className="flex h-full min-h-0 flex-col gap-3">
            <div className="text-xs text-foreground-muted">{relationHeadline(data)}</div>
            <div className="flex min-h-0 flex-1 gap-3">
              <div className="cds-surface-sunken cds-hairline min-w-0 flex-1 overflow-hidden rounded-lg">
                <RelationGraph payload={data} highlight={highlight} style={{ height: '100%' }} />
              </div>
              <div className="w-[320px] shrink-0 overflow-auto rounded-lg border border-[hsl(var(--hairline))] p-3">
                <div className="mb-2 text-[11px] font-bold text-muted-foreground">需要处理 · 按严重度</div>
                <FindingsList findings={onlyProblems ? data.lint.findings.filter((f) => f.severity !== 'info') : data.lint.findings} onPick={setHighlight} />
              </div>
            </div>
          </div>
        ) : null}
      </Workspace>
    </AppShell>
  );
}
