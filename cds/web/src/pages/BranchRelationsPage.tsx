import { useSurfaceNavigate as useNavigate } from '@/components/layout/RouteMotion';
import {
  BRANCH_RELATIONS_CANVAS_CLASS, BRANCH_RELATIONS_LAYOUT_CLASS, BranchRelationsSkeleton,
} from '@/components/skeletons/WorkspaceSkeletons';
/*
 * BranchRelationsPage — 全屏关系图（plan.cds.service-relations 第四批）。独立路由，可分享。
 * 与总览关系卡、展开视图、cdscli topology 读同一份 service-graph 数据。
 */
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { ArrowLeft, Copy, Minimize2, RefreshCw } from 'lucide-react';
import { AppShell, ConsoleAuthContext, Crumb, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { RelationWorkspace, useRelationPayload } from '@/components/branch/RelationCard';
import { relationHeadline } from '@/components/branch/RelationGraph';
import { consoleAccountIdentity } from '@/lib/consoleIdentity';
import { enterRelationReturn, relationReturnKind, type RelationReturnTask } from '@/lib/relationReturn';
import { copyTextToClipboard } from '@/lib/clipboard';
import { bottomRightToastStyle } from '@/lib/overlayOffsets';

export function BranchRelationsPage(): JSX.Element {
  const { branchId } = useParams<{ branchId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useContext(ConsoleAuthContext);
  const actor = auth.pending ? null : consoleAccountIdentity(auth.status);
  const token = location.state && typeof location.state === 'object' ? (location.state as { relationReturn?: unknown }).relationReturn : undefined;
  const [returnKind, setReturnKind] = useState<RelationReturnTask['kind'] | null>(null);
  useLayoutEffect(() => { setReturnKind(enterRelationReturn(token, actor, branchId, location.key, window.history.state?.idx)); }, [token, actor, branchId, location.key]);
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');
  const copyScope = useRef(0);
  const manualAddress = useRef<HTMLInputElement>(null);
  const focusManual = useRef(false);
  const canonical = branchId ? new URL(`/branch-relations/${encodeURIComponent(branchId)}`, window.location.origin).href : '';
  useEffect(() => { copyScope.current += 1; setCopyState('idle'); }, [branchId, actor]);
  useEffect(() => { if (copyState !== 'copied') return; const timer = window.setTimeout(() => setCopyState('idle'), 2400); return () => window.clearTimeout(timer); }, [copyState]);
  useLayoutEffect(() => { if (copyState === 'error' && focusManual.current) { focusManual.current = false; manualAddress.current?.focus({ preventScroll: true }); manualAddress.current?.select(); } }, [copyState]);
  const copyLink = async (source: HTMLButtonElement) => {
    const scope = copyScope.current; setCopyState('copying');
    try {
      await copyTextToClipboard(canonical);
      if (scope !== copyScope.current) return;
      setCopyState('copied');
      if (document.activeElement === document.body && source.isConnected) source.focus({ preventScroll: true });
    } catch {
      if (scope !== copyScope.current) return;
      const active = document.activeElement;
      focusManual.current = !(active instanceof HTMLElement) || active === source || active === document.body || !active.isConnected || active.getAttribute('aria-label') === '更多操作';
      setCopyState('error');
    }
  };
  const returnToTask = () => {
    if (relationReturnKind(token, actor, branchId, location.key, window.history.state?.idx)) navigate(-1);
    else navigate(branchId ? `/branch-panel/${encodeURIComponent(branchId)}` : '/branch-list');
  };
  const returnLabel = returnKind === 'overview' ? '返回项目关系总览'
    : returnKind === 'branches' ? '返回分支总览' : '返回分支详情';
  const { state, reload, refreshing, refreshError } = useRelationPayload(branchId);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const data = state.status === 'ok' ? state.data : null;
  return (
    <AppShell
      active="projects"
      wide
      topbar={(
        <TopBar
          left={<><span className="hidden md:inline"><Crumb items={[{ label: 'CDS', href: '/project-list' }, { label: '分支', href: branchId ? `/branch-panel/${encodeURIComponent(branchId)}` : '/branch-list' }, { label: '关系图' }]} /></span><Button variant="ghost" size="sm" className="md:hidden" style={{ minHeight: '3.25rem' }} onClick={returnToTask}><ArrowLeft />{returnLabel}</Button></>}
          right={(
            <>
              {data ? (
                <>
                  {data.lint.summary.errors ? <span className="inline-flex h-[1.125rem] items-center rounded-full border border-destructive/60 px-1.5 text-[0.625rem] font-semibold text-destructive">{data.lint.summary.errors} 错误</span> : null}
                  {data.lint.summary.warnings ? <span className="inline-flex h-[1.125rem] items-center rounded-full border border-warn/60 bg-warn-soft px-1.5 text-[0.625rem] font-semibold text-warn">{data.lint.summary.warnings} 警告</span> : null}
                </>
              ) : null}
              <Button variant={onlyProblems ? 'default' : 'outline'} size="sm" onClick={() => setOnlyProblems((v) => !v)} title="只列错误与警告">只看问题</Button>
              <Button variant="outline" size="sm" disabled={!canonical || copyState === 'copying'} onClick={event => { void copyLink(event.currentTarget); }} title="复制此关系图的地址，不包含返回任务状态"><Copy />{copyState === 'copying' ? '正在复制' : '复制链接'}</Button>
              <Button variant="outline" size="sm" onClick={reload} disabled={refreshing}><RefreshCw className={refreshing ? 'animate-spin' : ''} />刷新</Button>
              <Button variant="outline" size="sm" className="hidden md:inline-flex" onClick={returnToTask}><Minimize2 />{returnLabel}</Button>
            </>
          )}
        />
      )}
    >
      <Workspace fluid className="cds-workspace--fill">
        {copyState === 'error' ? <div role="alert" className="mb-3 space-y-2 text-sm text-warn"><p>自动复制未完成。可再次复制链接，或选中以下完整地址手动复制。</p><input ref={manualAddress} aria-label="关系图完整地址" readOnly value={canonical} onFocus={event => event.currentTarget.select()} className="w-full rounded-md border border-input bg-background px-3 text-foreground" style={{ minHeight: '3.25rem' }} /></div> : null}
        {copyState === 'copied' ? <div role="status" className="fixed z-50 rounded-md border border-border bg-card px-4 py-3 text-sm shadow-lg" style={bottomRightToastStyle}>链接已复制</div> : null}
        {refreshError && data ? <p role="alert" className="py-3 text-sm text-destructive">刷新失败：{refreshError}；当前显示上次读取的内容。</p> : null}
        {state.status === 'loading' ? <BranchRelationsSkeleton /> : null}
        {state.status === 'error' ? <div className="p-6 text-xs text-destructive">读取失败：{state.message}</div> : null}
        {data ? (
          <div className={BRANCH_RELATIONS_LAYOUT_CLASS}>
            <div className="text-xs text-foreground-muted">{relationHeadline(data)}</div>
            {/* 与展开视图同一个主体：问题带在上、关系图在下，不再是右侧窄栏 */}
            <div className={BRANCH_RELATIONS_CANVAS_CLASS}>
              <RelationWorkspace data={data} onlyProblems={onlyProblems} />
            </div>
          </div>
        ) : null}
      </Workspace>
    </AppShell>
  );
}
