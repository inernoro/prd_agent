/*
 * ReferencesPanel — 配置页签「引用」分区（plan.cds.service-relations 第三批）。
 *
 * 从全部环境变量里单独抽出「指向别的服务、分支或项目的地址」：引用变量、手写网址、
 * 键名带 URL/BASE/ENDPOINT/HOST 后缀的、平台注入的入口表。每条给出来源层、指向哪里、
 * 目标现在活没活；引用变量可以在这里切换目标分支并重新部署受影响的服务。
 * 数据源：GET /api/branches/:id/references；切换：PUT /api/branches/:id/references/:key；
 * 生效：POST /api/branches/:id/deploy/:profileId（逐个服务重建容器）。
 * 为什么是重新部署而不是重启：分支级重启走 docker restart，容器保留旧环境变量，
 * 切换后的引用值根本进不了容器（Codex P1，2026-09-02）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api';
import { postSse, sseEventText } from '@/lib/sse';

type RefKind = 'cds-ref' | 'url' | 'name-hint' | 'platform';
type RefStatus = 'running' | 'stopped' | 'building' | 'error' | 'missing-service' | 'missing-branch' | 'missing-project';

interface ResolvedRef {
  ref: { raw: string; projectRef: string; serviceId: string; branchRef?: string };
  url: string | null;
  status: RefStatus;
  target: { projectId?: string; projectSlug?: string; branchId?: string; branchName?: string; serviceId: string; isDefaultBranch?: boolean };
  reason?: string;
}

interface ReferenceItem {
  profileId: string;
  key: string;
  kind: RefKind;
  value: string;
  rawValue: string;
  source: string;
  detail?: string;
  resolved?: ResolvedRef[];
  matchedBranch?: { branchId: string; projectId: string; branchName: string; status: string } | null;
  suggestion?: string;
}

interface ReferencesResponse { branchId: string; projectId: string; references: ReferenceItem[]; broken: Array<{ rule: string; severity: string; message: string }> }
interface BranchRow { id: string; projectId: string; branch: string; status: string }

const SOURCE_LABEL: Record<string, string> = {
  'cds-builtin': 'CDS 内置', 'cds-derived': 'CDS 派生', mirror: '镜像', global: '全局', project: '项目', branch: '分支',
  profile: '项目根', 'extra-service': '临时服务', 'branch-override': '分支覆盖', 'deploy-mode': '部署模式',
  'platform-injected': '平台注入', 'per-branch-db': '分支库',
};
const KIND_LABEL: Record<RefKind, string> = { 'cds-ref': '引用变量', url: '手写网址', 'name-hint': '疑似地址', platform: '平台注入' };

function StatusChip({ status }: { status: RefStatus | string }): JSX.Element {
  const ok = status === 'running';
  const warn = status === 'building' || status === 'stopped';
  const cls = ok ? 'border-ok/50 bg-ok-soft text-ok' : warn ? 'border-warn/60 bg-warn-soft text-warn' : 'border-destructive/60 bg-[hsl(var(--bad-soft))] text-destructive';
  const label = ({ running: '运行中', stopped: '已停止', building: '构建中', error: '异常', 'missing-service': '没有该服务', 'missing-branch': '没有该分支', 'missing-project': '没有该项目' } as Record<string, string>)[status] ?? status;
  return <span className={`inline-flex h-[18px] items-center rounded-full border px-1.5 text-[10px] font-semibold ${cls}`}>{label}</span>;
}

export function ReferencesPanel({ branchId, onToast }: { branchId: string; onToast?: (message: string) => void }): JSX.Element {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ok'; data: ReferencesResponse } | { status: 'error'; message: string }>({ status: 'loading' });
  const [picker, setPicker] = useState<{ item: ReferenceItem; ref: ResolvedRef; branches: BranchRow[] | null } | null>(null);
  const [pendingRedeploy, setPendingRedeploy] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const data = await apiRequest<ReferencesResponse>(`/api/branches/${encodeURIComponent(branchId)}/references`);
      setState({ status: 'ok', data });
    } catch (err) {
      setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [branchId]);
  useEffect(() => { void load(); }, [load]);

  const openPicker = async (item: ReferenceItem, ref: ResolvedRef): Promise<void> => {
    setPicker({ item, ref, branches: null });
    try {
      const res = await apiRequest<{ branches: BranchRow[] }>('/api/branches');
      const rows = (res.branches || []).filter((b) => b.projectId === ref.target.projectId).sort((a, b) => a.branch.localeCompare(b.branch));
      setPicker({ item, ref, branches: rows });
    } catch (err) {
      onToast?.(`读取目标项目分支失败：${err instanceof ApiError ? err.message : String(err)}`);
      setPicker(null);
    }
  };

  // 切换后的引用要进容器必须重建容器：逐个走单服务部署（SSE），每个服务成功一个就从待办里划掉，
  // 中途失败停在失败的那个，剩下的仍留在待办里可再点。
  const redeployProfiles = async (ids: string[]): Promise<boolean> => {
    if (ids.length === 0) return true;
    const done: string[] = [];
    try {
      for (const profileId of ids) {
        setProgress(`正在重新部署 ${profileId}（${done.length + 1}/${ids.length}）…`);
        let ok = true;
        await postSse(`/api/branches/${encodeURIComponent(branchId)}/deploy/${encodeURIComponent(profileId)}`, {}, (event, data) => {
          if (event === 'error') ok = false;
          if (event === 'complete' && data && typeof data === 'object' && 'ok' in data) ok = Boolean((data as { ok?: unknown }).ok);
          setProgress(`${profileId}（${done.length + 1}/${ids.length}）：${sseEventText(event, data)}`);
        });
        if (!ok) throw new Error(`${profileId} 重新部署失败，请看分支日志`);
        done.push(profileId);
        setPendingRedeploy((prev) => { const next = new Set(prev); next.delete(profileId); return next; });
      }
      onToast?.(`已重新部署 ${done.join('、')}，新的引用已进入容器`);
      return true;
    } catch (err) {
      onToast?.(`重新部署失败：${err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err)}，容器里仍是旧的引用值`);
      return false;
    } finally {
      setProgress(null);
    }
  };

  // 切换与生效是一个动作：写完分支覆盖立刻重建该服务的容器。分开两步的话「已切换但没生效」
  // 只存在于本页内存里，刷新就看不出来了（Codex 三轮 P1）。部署失败时保留待办按钮可重试。
  const switchTo = async (branchName: string | null): Promise<void> => {
    if (!picker) return;
    setBusy(true);
    try {
      await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/references/${encodeURIComponent(picker.item.key)}`, {
        method: 'PUT',
        // raw = 被替换的那个引用 token 原文：值里嵌了前后缀或有多个引用时，服务端只换这一个
        body: { profileId: picker.item.profileId, projectRef: picker.ref.ref.projectRef, serviceId: picker.ref.ref.serviceId, raw: picker.ref.ref.raw, ...(branchName ? { branchRef: branchName } : {}) },
      });
      const profileId = picker.item.profileId;
      setPendingRedeploy((prev) => new Set(prev).add(profileId));
      setPicker(null);
      onToast?.(`${picker.item.key} 已指向 ${picker.ref.ref.projectRef}/${picker.ref.ref.serviceId}${branchName ? `@${branchName}` : '（默认分支）'}，正在重新部署 ${profileId}`);
      await redeployProfiles([profileId]);
      await load();
    } catch (err) {
      onToast?.(`切换失败：${err instanceof ApiError ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const redeploy = async (): Promise<void> => {
    setBusy(true);
    try {
      if (await redeployProfiles(Array.from(pendingRedeploy))) await load();
    } finally {
      setBusy(false);
    }
  };

  if (state.status === 'loading') {
    return <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在从环境变量里抽出地址类引用…</div>;
  }
  if (state.status === 'error') {
    return <div className="text-xs text-destructive">读取引用失败：{state.message} <Button size="sm" variant="ghost" onClick={() => void load()}>重试</Button></div>;
  }
  const { references, broken } = state.data;
  return (
    <section className="space-y-3" data-testid="references-panel">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">引用</span>
        <span className="text-xs text-muted-foreground">指向别的服务、分支或项目的地址，从全部环境变量里单独抽出来</span>
        {broken.length > 0 ? <span className="inline-flex h-[18px] items-center rounded-full border border-destructive/60 px-1.5 text-[10px] font-semibold text-destructive">{broken.length} 条断裂</span> : null}
        <span className="flex-1" />
        {progress ? <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="references-redeploy-progress"><Loader2 className="h-3.5 w-3.5 animate-spin" />{progress}</span> : null}
        {pendingRedeploy.size > 0 ? (
          <Button size="sm" onClick={() => void redeploy()} disabled={busy} title={`重新部署 ${Array.from(pendingRedeploy).join('、')} 让新的引用进入容器（原地重启不会刷新环境变量）`}>
            重新部署受影响服务 ({pendingRedeploy.size})
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => void load()} title="刷新"><RefreshCw /></Button>
      </div>
      {references.length === 0 ? (
        <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-4 text-xs text-muted-foreground">
          这个分支的环境变量里没有地址类引用。跨项目调用时写 <code className="font-mono">{'${CDS_REF:项目/服务}'}</code>，平台会在部署时换成目标公网入口，并能在这里切换目标分支。
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-[hsl(var(--hairline))]">
          <table className="w-full text-xs">
            <thead className="bg-[hsl(var(--surface-sunken))] text-[10px] font-bold text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">服务 · 键</th>
                <th className="px-3 py-2 text-left">值</th>
                <th className="px-3 py-2 text-left">指向</th>
                <th className="px-3 py-2 text-left">目标状态</th>
                <th className="px-3 py-2 text-left">来源层</th>
                <th className="px-3 py-2 text-left">动作</th>
              </tr>
            </thead>
            <tbody>
              {references.map((item) => {
                // 一个值里可能有多个引用（`${CDS_REF:a/x}|${CDS_REF:a/y}`）：每个 token 各自展示指向、状态与切换
                const resolvedList = item.resolved ?? [];
                const r = resolvedList[0];
                const rowBad = resolvedList.some((x) => x.status !== 'running');
                return (
                  <tr key={`${item.profileId}:${item.key}`} className={`border-t border-[hsl(var(--hairline))] ${rowBad ? 'bg-[hsl(var(--bad-soft))]/40' : ''}`} data-ref-kind={item.kind}>
                    <td className="px-3 py-2 align-top">
                      <div className="font-mono">{item.key}</div>
                      <div className="text-[10px] text-muted-foreground">{item.profileId} · {KIND_LABEL[item.kind]}</div>
                    </td>
                    <td className="max-w-[320px] truncate px-3 py-2 align-top font-mono text-muted-foreground" title={item.rawValue}>
                      {item.kind === 'cds-ref' ? item.rawValue : item.value}
                      {resolvedList.filter((x) => x.url).map((x) => <div key={x.ref.raw} className="truncate text-[10px]" title={x.url ?? ''}>{resolvedList.length > 1 ? `${x.ref.raw} = ` : '= '}{x.url}</div>)}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {r ? resolvedList.map((x) => (
                        <div key={x.ref.raw}>{x.target.projectSlug ?? x.ref.projectRef} / <b>{x.target.branchName ?? '?'}</b>{x.target.isDefaultBranch ? <span className="text-[10px] text-muted-foreground">（默认）</span> : null} / {x.ref.serviceId}{x.reason ? <div className="text-[10px] text-destructive">{x.reason}</div> : null}</div>
                      )) : item.matchedBranch ? (
                        <span>CDS 分支 <b>{item.matchedBranch.branchName}</b>{item.matchedBranch.branchId === branchId ? '（本分支）' : ''}</span>
                      ) : item.kind === 'platform' ? <span className="text-muted-foreground">本分支已发布入口表</span> : <span className="text-muted-foreground">CDS 外部或同分支内网</span>}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {r ? <div className="flex flex-col gap-1">{resolvedList.map((x) => <StatusChip key={x.ref.raw} status={x.status} />)}</div> : item.matchedBranch ? <StatusChip status={item.matchedBranch.status} /> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2 align-top text-muted-foreground">{SOURCE_LABEL[item.source] ?? item.source}{item.detail === 'cds-ref' ? '' : item.detail ? ` · ${item.detail}` : ''}</td>
                    <td className="px-3 py-2 align-top">
                      {r ? (
                        <div className="flex flex-col gap-1">
                          {resolvedList.map((x) => x.status !== 'missing-project' ? (
                            <Button key={x.ref.raw} size="sm" variant="outline" className="h-6 text-[11px]" disabled={busy} onClick={() => void openPicker(item, x)} title={resolvedList.length > 1 ? `切换 ${x.ref.raw}` : undefined}>
                              切换分支{resolvedList.length > 1 ? <span className="font-mono text-[10px] text-muted-foreground">{x.ref.serviceId}{x.ref.branchRef ? `@${x.ref.branchRef}` : ''}</span> : null}
                            </Button>
                          ) : null)}
                        </div>
                      ) : item.suggestion ? (
                        <span className="text-[10px] text-warn" title={item.suggestion}>建议改成引用变量</span>
                      ) : item.kind === 'platform' ? <span className="text-[10px] text-muted-foreground">只读</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {picker ? (
        <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] p-3" data-testid="reference-branch-picker">
          <div className="mb-2 flex items-center gap-2 text-xs">
            <span className="font-semibold">切换分支</span>
            <span className="text-muted-foreground"><span className="font-mono">{picker.item.key}</span> 指向 {picker.ref.target.projectSlug ?? picker.ref.ref.projectRef} 的</span>
            <span className="flex-1" />
            <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setPicker(null)}>取消</Button>
          </div>
          {picker.branches === null ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />读取目标项目的分支…</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy} onClick={() => void switchTo(null)} title="不钉分支，跟随目标项目的默认分支">默认分支</Button>
              {picker.branches.map((b) => (
                <Button key={b.id} size="sm" variant={b.branch === picker.ref.target.branchName && !picker.ref.target.isDefaultBranch ? 'default' : 'outline'} className="h-7 gap-1.5 text-[11px]" disabled={busy} onClick={() => void switchTo(b.branch)}>
                  <span className="font-mono">{b.branch}</span>
                  <StatusChip status={b.status} />
                </Button>
              ))}
            </div>
          )}
          <div className="mt-2 text-[10px] text-muted-foreground">改动写入该服务的分支覆盖，不动项目根；选定后立即重新部署该服务（重建容器）让新地址生效。</div>
        </div>
      ) : null}
    </section>
  );
}
