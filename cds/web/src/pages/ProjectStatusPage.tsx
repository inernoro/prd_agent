import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowRight, Bell, CircleAlert, RefreshCw, ShieldCheck } from 'lucide-react';
import { AppShell, Crumb, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api';
import { cn } from '@/lib/utils';
import { type UptimeSummary, formatRelative, proberLiveness } from '@/lib/monitorCenter';
import { homeState, sortHomeTargets } from '@/lib/statusHome';
import { checkPurpose, checkTitle, EVENT_NAMES, frequency, inspectionState, inspectionCheckLabel, projectChannels, type ChannelStatus, type ProjectInspection } from '@/lib/projectStatus';
import { HomeStateBadge } from './status/BusinessHome';
import './status/status-home.css';
import './status/project-status.css';

type Delivery = { deliveryId: string; projectId: string; targetId?: string; targetName?: string; channelName?: string; eventKind?: string; status: string; at: string; reason?: string; kind?: string };
type Job = { id: string; name: string; description?: string; enabled: boolean; nextRunAt?: string; lastRunAt?: string; lastRunStatus?: string };
type Project = { id: string; name: string; aliasName?: string };
type Data = { project: Project; summary: UptimeSummary | null; inspections: ProjectInspection[] | null; jobs: Job[] | null; deliveries: Delivery[] | null; suppressed: Delivery[]; truncated: boolean; errors: string[]; loadedAt: number };
const timestamp = (value: string | number | null | undefined): string => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚无记录';
const DELIVERY = { sent: '推送服务已接收', failed: '发送失败', unknown: '结果未确认', suppressed: '本次未发送' };
const SKIP_REASON: Record<string, string> = { 'recovery-stabilizing-10m': '恢复观察中，持续稳定后再通知', 'no-data': '未获得有效检查数据，未作为新故障重复发送', 'recovery-without-delivered-alert': '本通道未送过故障通知，不单独发送恢复消息' };

export function ProjectStatusPage(): JSX.Element {
  const { projectId = '' } = useParams();
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [query, setQuery] = useState(''), [onlyIssues, setOnlyIssues] = useState(false), [now, setNow] = useState(Date.now());
  const sequence = useRef(0), controller = useRef<AbortController | null>(null);
  const load = useCallback(async (): Promise<void> => {
    const seq = ++sequence.current; controller.current?.abort(); const ctrl = new AbortController(); controller.current = ctrl; setBusy(true);
    try {
      const project = await apiRequest<Project>(`/api/projects/${encodeURIComponent(projectId)}`, { signal: ctrl.signal });
      const results = await Promise.allSettled([
        apiRequest<UptimeSummary>('/api/uptime/summary?segments=12', { signal: ctrl.signal }),
        apiRequest<{ inspections: ProjectInspection[] }>(`/api/projects/${encodeURIComponent(project.id)}/inspection-checks`, { signal: ctrl.signal }),
        apiRequest<{ jobs: Job[] }>(`/api/scheduled-jobs?projectId=${encodeURIComponent(project.id)}`, { signal: ctrl.signal }),
        apiRequest<{ deliveries: Delivery[]; suppressed: Delivery[]; truncated?: boolean }>('/api/cds-system/alarm-deliveries?hours=24', { signal: ctrl.signal }),
      ]);
      if (seq !== sequence.current) return;
      const [checks, inspections, jobs, deliveries] = results;
      const labels = ['常设检查暂时无法读取', '定期巡检暂时无法读取', '调度计划暂时无法读取', '通知记录暂时无法读取或当前账号无权查看'];
      setData({ project, summary: checks.status === 'fulfilled' ? checks.value : null, inspections: inspections.status === 'fulfilled' ? inspections.value.inspections : null, jobs: jobs.status === 'fulfilled' ? jobs.value.jobs : null, deliveries: deliveries.status === 'fulfilled' ? deliveries.value.deliveries.filter(d => d.projectId === project.id) : null, suppressed: deliveries.status === 'fulfilled' ? deliveries.value.suppressed.filter(d => d.projectId === project.id) : [], truncated: deliveries.status === 'fulfilled' && !!deliveries.value.truncated, errors: results.flatMap((r, i) => r.status === 'rejected' ? [labels[i]] : []), loadedAt: Date.now() });
      setNow(Date.now()); setError(null);
    } catch { if (seq === sequence.current) setError('项目状态暂时无法读取，请确认项目存在并检查访问权限后重试。'); }
    finally { if (seq === sequence.current) setBusy(false); }
  }, [projectId]);
  useEffect(() => { setData(null); setError(null); void load(); const timer = window.setInterval(() => void load(), 30_000); return () => { window.clearInterval(timer); sequence.current++; controller.current?.abort(); }; }, [load]);
  const targets = data?.summary?.targets.filter(t => t.projectId === data.project.id) ?? [];
  const checks = targets.filter(t => t.source !== 'branch'), previews = targets.filter(t => t.source === 'branch');
  const inspections = data?.inspections ?? [], issues = checks.filter(t => homeState(t, now) === 'down');
  const inspectionIssues = inspections.filter(i => inspectionState(i, now) === 'down');
  const uncertain = checks.filter(t => ['unknown', 'overdue'].includes(homeState(t, now))).length + inspections.filter(i => ['unknown', 'overdue'].includes(inspectionState(i, now))).length;
  const configuredChannels = projectChannels(data?.summary?.alarmChannels as ChannelStatus[] | undefined, data?.project.id ?? '');
  const legacy = data?.summary?.alarm;
  const channels = configuredChannels === undefined ? undefined : [...configuredChannels, ...(legacy && legacy.status !== 'unconfigured' ? [{ id: 'legacy-map', name: legacy.channel, kind: 'map', status: legacy.status, enabled: true, projects: [], events: ['business-down', 'business-recovered', 'infra-down', 'infra-recovered'], last: legacy.last }] : [])];
  const liveChannels = channels?.filter(c => c.enabled && c.status === 'healthy') ?? [];
  const rows = sortHomeTargets(checks, now).filter(t => (!query || `${t.name} ${checkTitle(t)} ${checkPurpose(t)}`.includes(query)) && (!onlyIssues || homeState(t, now) !== 'up'));
  const expiredProber = !!data?.summary && (!data.summary.enabled || !!proberLiveness(data.summary)?.stalled);
  const title = data?.project.aliasName || data?.project.name || projectId;
  const detailUrl = (id: string): string => `/status?target=${encodeURIComponent(id)}`;
  return <AppShell active="status" topbar={<TopBar left={<Crumb items={[{ label: '监控中心', href: '/status' }, { label: title }]} />} right={<Button variant="outline" onClick={() => void load()} disabled={busy}><RefreshCw className={busy ? 'animate-spin' : ''} />{busy ? '正在更新' : '刷新'}</Button>} />}>
    <Workspace fluid className="cds-workspace--fill"><div className="status-home project-status-page">
      {error && <div role="alert" className="status-home-guidance border-destructive">{error}<Button onClick={() => void load()}>重新读取</Button></div>}
      {!data && !error && <section className="status-home-panel animate-pulse" aria-busy="true"><h1>正在汇总项目检查与通知</h1><p>正在读取常设检查、定期实测、调度计划和通知回执。</p></section>}
      {data && <>
        <header className="status-home-panel"><div className="project-status-title"><div><p className="status-home-muted">项目运行总览</p><h1>{title} · 检查与通知</h1></div><ShieldCheck className="h-8 w-8 text-primary" /></div>
          <p>{issues.length + inspectionIssues.length ? `${issues.length + inspectionIssues.length} 项检查需要处理` : expiredProber || data.errors.length || uncertain ? '当前有检查缺少可靠的最新结论' : '已接入的检查暂未发现异常'}。{uncertain ? `还有未完成或逾期的检查，详见下方逐项结果。` : ''} 结果只覆盖下面已列出的检查。</p>
          <div className="project-status-stats"><a href="#checks"><strong>{data.summary === null ? '未知' : checks.length}</strong>常设检查</a><a href="#inspections"><strong>{data.inspections === null ? '未知' : inspections.reduce((n, i) => n + i.checks.length, 0)}</strong>定期实测项</a><a href="#notifications"><strong>{channels === undefined ? '未知' : liveChannels.length}</strong>已验证通知通道</a><a href="#delivery"><strong>{data.deliveries?.filter(d => d.status === 'failed').length ?? '未知'}</strong>近 24 小时发送失败</a></div>
          <div className="project-status-notice-summary"><strong>通知情况：</strong>{channels === undefined ? '常设通知配置未知。' : liveChannels.length ? `${liveChannels.map(c => c.name).join('、')}最近已验证投递；` : '没有已验证的常设通知通道；'}{data.deliveries === null ? '发送记录未知。' : data.deliveries.length ? `近 24 小时有 ${data.deliveries.filter(d => d.status === 'sent').length} 次被推送服务接收、${data.deliveries.filter(d => d.status === 'failed').length} 次发送失败。` : '近 24 小时没有发送记录。'}<a href="#notifications">查看通知对象与规则</a></div><p className="status-home-muted">更新于 {timestamp(data.loadedAt)}，每 30 秒刷新。暂停、逾期和未检查都不算正常。</p>
          {expiredProber && <p role="alert" className="text-destructive">常设探测器没有持续运行，旧的通过结果不能证明现在正常。</p>}
          {data.errors.map(e => <p role="alert" className="text-destructive" key={e}>{e}。</p>)}
        </header>
        <nav className="project-status-shortcuts" aria-label="项目状态章节"><a href="#checks">全部检查</a><a href="#inspections">定期实测</a><a href="#notifications">通知规则</a><a href="#delivery">发送记录</a><a href="#coverage">覆盖与缺口</a></nav>
        {(issues.length > 0 || inspectionIssues.length > 0) && <section className="status-home-panel"><h2>先处理这些异常</h2>{issues.map(t => <div className="project-status-issue" key={t.id}><CircleAlert className="h-5 w-5 text-destructive"/><div><strong>{checkTitle(t)}</strong><p>{checkPurpose(t)}</p><Link to={detailUrl(t.id)}>查看原因、检查证据与处理入口 <ArrowRight className="inline h-4 w-4" /></Link></div></div>)}{inspectionIssues.map(i => <p key={i.id}><a href="#inspections">{i.name}有未通过的实测，查看逐项结果</a></p>)}</section>}
        <section id="checks" className="status-home-panel"><div className="status-home-section-heading"><h2>全部常设检查</h2><Button variant={onlyIssues ? 'default' : 'outline'} onClick={() => setOnlyIssues(!onlyIssues)}>{onlyIssues ? '显示全部' : '只看异常与未确认'}</Button></div><p>常设检查自动执行。观察近期流量与亲自调用模型，是两种不同的证据。</p><input className="project-status-search" aria-label="搜索检查" placeholder="按业务或检查目的搜索" value={query} onChange={e => setQuery(e.target.value)} />
          {data.summary === null ? <p>常设检查读取失败，当前不能判断。</p> : !checks.length ? <p>这个项目尚未接入常设检查。</p> : <div className="project-status-table-wrap"><table><thead><tr><th>检查项目 / 检查什么</th><th>当前结果</th><th>检查频率 / 最近检查</th><th>通知与处理</th></tr></thead><tbody>{rows.map(t => <tr key={t.id}><td><strong>{checkTitle(t)}</strong><p>{checkPurpose(t)}</p><small>{t.environmentLabel} · {t.observeMode === 'passive' ? '观察真实业务记录' : '主动检查'}</small></td><td><HomeStateBadge state={homeState(t, now)} />{t.lastSample?.noData && <p>没有有效读数</p>}</td><td>{frequency(t.intervalSeconds)}<p>{t.lastSample ? timestamp(t.lastSample.t) : '尚未检查'}</p></td><td><a href="#notifications">{homeState(t, now) === 'paused' ? '本项暂停，不产生新告警' : channels === undefined ? '通知配置未知' : liveChannels.some(c => c.events.includes(t.source === 'release' || t.source === 'custom' ? 'business-down' : 'infra-down')) ? '异常时按下方规则通知' : '未发现已验证的异常通知通道'}</a><p><Link to={detailUrl(t.id)}>查看检查详情</Link></p></td></tr>)}</tbody></table></div>}
        </section>
        <section id="inspections" className="status-home-panel"><h2>定期实测与执行计划</h2><p>这里显示执行器回填的真实调用与产物结果，并标明手动核验或定时执行。结果过期后不再计为正常。</p>
          {data.inspections === null ? <p>定期巡检读取失败，不能据此判断已覆盖。</p> : !inspections.length ? <p>尚未接入定期实测结果。只配置了定时任务，不算已经检查通过。</p> : inspections.map(i => <article className="project-status-inspection" key={i.id}><div className="status-home-section-heading"><h3>{i.name}</h3><HomeStateBadge state={inspectionState(i, now)} /></div><p>{i.executor} · {frequency(i.intervalSeconds)} · 最近{ i.runKind === 'manual' ? '手动核验' : '定时执行' }：{timestamp(i.lastCompletedAt)}</p><p>通知：{i.notification.channel} → {i.notification.recipient}；{i.notification.policy}。{i.notification.outcome === 'not-triggered' ? '本次未触发通知。' : i.notification.outcome === 'accepted' ? '执行器报告已送出，可查看回执证据。' : i.notification.outcome === 'failed' ? '本次通知发送失败。' : '本次通知结果未确认。'}</p>{i.notification.evidenceUrl && <a href={i.notification.evidenceUrl}>查看通知回执</a>}{i.reportUrl && <p><a href={i.reportUrl}>查看完整巡检证据</a></p>}<div className="project-status-check-grid">{i.checks.map(c => <div className="project-status-check" key={c.id}><strong>{c.name}</strong><span className={cn('status-home-badge', c.outcome === 'fail' ? 'text-destructive bg-destructive/10' : c.outcome === 'pass' && !['overdue', 'paused', 'unknown'].includes(inspectionState(i, now)) ? 'text-ok bg-ok-soft' : 'text-muted-foreground bg-muted')}>{inspectionCheckLabel(i, c, now)}</span><p>{c.purpose}</p><p>{c.result}</p><p className="status-home-muted">最近检查：{timestamp(c.checkedAt)}</p>{c.evidenceUrl && <a href={c.evidenceUrl}>查看该项证据</a>}</div>)}</div><p className="status-home-muted">本记录由执行方回填于 {timestamp(i.receivedAt)}；它不等同于 CDS 自己重新调用了模型。</p></article>)}
          <h3 className="mt-6">CDS 中的调度计划</h3>{data.jobs === null ? <p>调度计划无法读取。</p> : !data.jobs.length ? <p>没有 CDS 托管的调度计划；上方外部执行器的计划单独列出。</p> : data.jobs.map(job => <div className="project-status-inspection" key={job.id}><strong>{job.name}</strong><p>{job.description || '按已配置计划运行'}</p><p>{job.enabled ? '计划启用' : '计划暂停'} · 最近执行：{timestamp(job.lastRunAt)} · {job.lastRunStatus === 'success' ? '成功' : job.lastRunStatus === 'failed' ? '失败' : job.lastRunStatus ? '等待确认' : '尚无结果'}</p><p>下次计划：{job.enabled ? timestamp(job.nextRunAt) : '已暂停'}</p><Link to="/task-schedule">查看任务与运行记录</Link></div>)}
        </section>
        <section id="notifications" className="status-home-panel"><h2><Bell className="inline h-5 w-5"/> 出问题时通知谁</h2><p>检查异常与通知成功分别记账。配置好了不等于送到，推送服务接收也不代表手机已展示或人已读。</p>{channels === undefined ? <p>当前无法读取通知配置，不能确认是否会有人收到。</p> : channels.length === 0 ? <p className="text-destructive">本项目没有匹配的通知通道。</p> : <div className="project-status-check-grid">{channels.map(c => <article key={c.id} className="project-status-check"><h3>{c.name}</h3><p>{c.kind === 'bark' ? '手机推送（Bark）' : c.kind === 'map' ? 'MAP 站内通知' : '已配置的 Webhook 接收端'}</p><p>{c.enabled ? c.status === 'healthy' ? '最近一次投递已被推送服务接收' : c.status === 'failing' ? '最近一次发送失败' : c.status === 'untested' ? '已配置，尚未验证投递' : '配置尚未完成' : '通道已暂停'}</p><p>通知条件：{c.events.map(e => EVENT_NAMES[e] || '其他已配置事件').join('、') || '未订阅事件'}</p><p>最近回执：{timestamp(c.last?.at)}</p></article>)}</div>}<div className="project-status-check-grid">{inspections.map(i => <article className="project-status-check" key={i.id}><h3>{i.name}的通知</h3><p>{i.notification.channel} → {i.notification.recipient}</p><p>通知条件：{i.notification.policy}</p><p>{i.notification.outcome === 'not-triggered' ? '本次未触发通知，不能据此确认投递链路已验证' : i.notification.outcome === 'accepted' ? '执行器报告已送出，回执在巡检证据中' : i.notification.outcome === 'failed' ? '本次发送失败' : '通知结果尚未确认'}</p></article>)}</div><p><Link to="/cds-settings?tab=alarm-notify">管理通知通道与接收端</Link></p></section>
        <section id="delivery" className="status-home-panel"><h2>最近 24 小时的通知记录</h2>{data.deliveries === null ? <p>通知记录无法读取或当前账号无权查看。不能把这当成没有发送失败。</p> : !data.deliveries.length ? <p>当前范围没有发送记录；不能据此证明通知链路正常。</p> : <div className="project-status-table-wrap"><table><thead><tr><th>时间 / 对应检查</th><th>发给哪个通道</th><th>结果</th></tr></thead><tbody>{data.deliveries.map(d => <tr key={d.deliveryId}><td>{timestamp(d.at)}<p>{d.targetName || '通知通道演练'}</p>{d.eventKind && <small>{EVENT_NAMES[d.eventKind] || (d.kind === 'drill' ? '通知演练' : '状态变化')}</small>}</td><td>{d.channelName || '通道名称未记录'}</td><td>{DELIVERY[d.status as keyof typeof DELIVERY] || '结果未确认'}{d.status === 'failed' && <p>请检查接收端或通知配置后重试；详细原因可在通知历史查看。</p>}</td></tr>)}</tbody></table></div>}{data.truncated && <p role="alert">历史记录达到查询上限，当前显示的是部分记录。</p>}{data.suppressed.length > 0 && <details><summary>为什么有 {data.suppressed.length} 条状态变化没有发送</summary>{data.suppressed.map(d => <p key={d.deliveryId}>{d.targetName}：{SKIP_REASON[d.reason || ''] || '按通知去重或恢复观察规则，本次未发送。'}</p>)}</details>}</section>
        <section id="coverage" className="status-home-panel"><h2>覆盖与缺口</h2><p>常设检查 {checks.length} 项，外部定期实测 {inspections.reduce((n, i) => n + i.checks.length, 0)} 项，分支预览服务 {previews.length} 项。它们检查的路径不同，不能相互代替。</p>{!inspections.length && <p className="text-destructive">定期实测尚未接入，当前看不到所有模型的实际生成能力。</p>}{data.summary?.coverage?.uncovered.filter(t => t.projectId === data.project.id).map(t => <p className="text-destructive" key={t.id}>{t.name}：{t.reason}；{t.action}</p>)}<details><summary>查看 {previews.length} 项分支预览检查</summary>{previews.map(t => <p key={t.id}><HomeStateBadge state={homeState(t, now)} /> <Link to={detailUrl(t.id)}>{t.name}</Link> · {t.measured ? '有实测' : '未实测'} · {t.lastSample ? formatRelative(t.lastSample.t, now) : '尚无样本'}</p>)}</details><p><Link to="/status?view=owner">查看完整探测覆盖与管理</Link> · <Link to={`/reports?project=${encodeURIComponent(data.project.id)}`}>查看项目全部验收报告</Link></p></section>
      </>}
    </div></Workspace>
  </AppShell>;
}
