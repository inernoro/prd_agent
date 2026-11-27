import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api';
type Row={identity:string;aliases?:string[];reason?:string;sizeBytesEstimate?:number;created?:string;digests?:string[];ownership?:{instanceId:string;projectId?:string;source:string};referenceSources?:Array<{kind:string;identity?:string;name?:string;instanceId?:string;reference?:string}>;referenceSourceCount?:number};
type PullBudget={reservedBytes:number;overdueCount:number;overdueReservedBytes:number;availableBytes:number|null;peakBytes:number;headroom:'normal'|'low'|'blocked'|null;activeSlotCount?:number;slotLimit?:number;reconciliationCount?:number};
type Report={catalogError?:string;scanStatus:string;enabled?:boolean;canExecute?:boolean;canAdopt?:boolean;pullBudget?:PullBudget;pullReservations?:Array<{identity:string;image:string;instanceId:string;confirmed:boolean;reservedBytesEstimate:number;reason:string;slotState?:'active'|'awaiting-reconciliation'|'reference-only';diagnostic?:{summary:string}}>;budgetBytes:number;imageBytesEstimate:number|null;protectedBytesEstimate:number|null;capacityGapEstimate:number|null;counts:Record<string,number|null>;candidates:Row[];held:Row[];unknown:Row[];filesystem?:{path:string;netAvailableBytesDelta:number|null}};
type Execution={id:string;status:string;startedAt:string;report?:Report;error?:string};
const bytes=(n:number|null|undefined)=>typeof n==='number'&&Number.isFinite(n)?n>=1024**3?`${(n/1024**3).toFixed(2)} GiB`:n>=1024**2?`${(n/1024**2).toFixed(2)} MiB`:n>=1024?`${(n/1024).toFixed(2)} KiB`:`${n} 字节`:'未知';
const reasons:Record<string,string>={'running-or-stopped-container-reference':'运行或停止容器仍引用','current-rollback-or-inflight-reference':'当前版本、必要回滚或在途部署引用','legacy-image-ownership-needs-review':'历史镜像尚无出生归属证明','other-master-has-not-published-rollback-pins':'其他实例尚未登记回滚引用','registry-recovery-reference-unconfirmed':'尚不能确认 registry 恢复来源','foreign-alias-needs-review':'新增别名归属待确认','explicit-protection':'显式保护','image-birth-identity-changed':'镜像身份变化'};
export function ImageCachePanel(){
  const [report,setReport]=useState<Report|null>(null),[job,setJob]=useState<Execution|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[seconds,setSeconds]=useState(0),[canExecute,setCanExecute]=useState(false),[canAdopt,setCanAdopt]=useState(false),[adopting,setAdopting]=useState<Row|null>(null);
  const refresh=async()=>{setBusy(true);setSeconds(0);setError('');try{const[r,s]=await Promise.all([apiRequest<Report>('/api/janitor/tasks/images'),apiRequest<{execution:Execution|null;canExecute:boolean;canAdopt:boolean}>('/api/janitor/tasks/images/state')]);setReport(r);setJob(s.execution);setCanExecute(s.canExecute);setCanAdopt(s.canAdopt);}catch(e){setReport(null);setCanExecute(false);setCanAdopt(false);setError((e as Error).message);}finally{setBusy(false);}};
  useEffect(()=>{void refresh();},[]);
  useEffect(()=>{if(!busy&&job?.status!=='running')return;const timer=setInterval(()=>setSeconds(v=>v+1),1000);return()=>clearInterval(timer);},[busy,job?.status]);
  useEffect(()=>{if(job?.status!=='running')return;const timer=setInterval(()=>void apiRequest<{execution:Execution|null}>('/api/janitor/tasks/images/state').then(r=>{setJob(r.execution);if(r.execution?.report)setReport(r.execution.report);}).catch(e=>setError((e as Error).message)),1000);return()=>clearInterval(timer);},[job?.id,job?.status]);
  return <section className="space-y-3 rounded-lg border border-border-default p-4" data-testid="image-cache-panel"><h3 className="font-medium">宿主镜像总量与引用</h3><p className="text-sm text-text-secondary">同一镜像ID只计一次；预算使用保守的逻辑大小估计，实际释放以文件系统净变化为准。执行前复核全部容器、别名与 registry 中的相同内容，保留未知归属。</p><div className="flex flex-wrap items-center gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={()=>void refresh()}>预览镜像ID与预算</Button><Button variant="outline" size="sm" disabled={busy||!canExecute||!report||Boolean(report.catalogError)||job?.status==='running'} onClick={()=>{setSeconds(0);void apiRequest<{execution:Execution}>('/api/janitor/tasks/images/reconcile',{method:'POST',body:{}}).then(r=>setJob(r.execution)).catch(e=>setError((e as Error).message));}}>回收最多2个镜像ID</Button>{job?.status==='running'&&<Button variant="outline" size="sm" onClick={()=>void apiRequest('/api/janitor/tasks/images/cancel',{method:'POST',body:{id:job.id}}).catch(e=>setError((e as Error).message))}>停止后续处理</Button>}{(busy||job?.status==='running')&&<span role="status" className="text-sm">正在核对镜像与引用 · {seconds} 秒</span>}</div>{report?.catalogError&&<p role="status" className="text-sm text-text-secondary">{report.catalogError==='docker-query-timeout'?'镜像查询超时':'镜像查询未确认'}；本次盘点不完整，占用与引用未知，相关镜像保持保护，不能执行回收。</p>}{(error||job?.error)&&<p role="alert" className="text-sm text-bad">{error||job?.error}；占用未知，相关镜像保持保留。</p>}{report&&<><p className="text-sm">策略：{report.budgetBytes>0?'已启用宿主总量预算':'预算尚未启用，需审查容量后配置'}；总量估计 {bytes(report.imageBytesEstimate)} / 预算 {report.budgetBytes?bytes(report.budgetBytes):'未设置'}；保护对象估计 {bytes(report.protectedBytesEstimate)}</p><p className="text-sm">扫描：{report.scanStatus==='complete'?'完整':'部分结果，不能判断零占用'}；候选 {report.counts?.candidates??'未知'} · 保留 {report.counts?.held??'未知'} · 未知 {report.counts?.unknown??'未知'} · 成功 {report.counts?.removed??0} · 失败 {report.counts?.failed??0} · 待处理 {report.counts?.pending??'未知'}</p>{report.pullBudget&&<ImagePullBudget budget={report.pullBudget}/>}{Boolean(report.capacityGapEstimate)&&<p className="text-sm text-bad">保护对象已超预算 {bytes(report.capacityGapEstimate)}，需调整容量或迁移；不会继续删除保护对象。</p>}<div className="max-h-56 overflow-auto text-sm">{(report.candidates||[]).map(row=><p key={row.identity} className="break-all">候选 {row.identity} · {bytes(row.sizeBytesEstimate)} · {row.aliases?.join(', ')}</p>)}{(report.held||[]).map(row=><p key={row.identity} className="break-all">{row.identity}：{reasons[row.reason||'']||row.reason} · {row.aliases?.join(', ')}{row.ownership&&<span> · 归属 {row.ownership.projectId||row.ownership.instanceId}</span>}{row.referenceSources?.slice(0,3).map((source,index)=><span key={index}> · {source.kind==='running-container'?'运行容器':source.kind==='stopped-container'?'停止容器':source.kind==='pending-artifact'?'在途产物':'实例版本与恢复记录'} {source.name||source.reference||source.identity||source.instanceId}</span>)}{Boolean(row.referenceSourceCount&&row.referenceSourceCount>3)&&<span> · 另有{row.referenceSourceCount!-3}条引用</span>}{canAdopt&&row.reason==='legacy-image-ownership-needs-review'&&row.created&&Boolean(row.digests?.length)&&<Button className="ml-2" size="sm" variant="outline" onClick={()=>setAdopting(row)}>核验历史镜像归属</Button>}</p>)}</div>{report.pullReservations?.map(row=><p key={row.identity} className="break-all text-sm">{row.image}：{row.confirmed||row.slotState==='reference-only'?'等待引用交接':row.slotState==='awaiting-reconciliation'?'等待回执对账，保留磁盘预算':'等待本次拉取结清'}；预留估计 {bytes(row.reservedBytesEstimate)}；实例 {row.instanceId}{row.diagnostic?.summary&&<span> · {row.diagnostic.summary}</span>}</p>)}{report.filesystem&&<p className="text-sm">{report.filesystem.path} 实测净可用空间变化：{typeof report.filesystem.netAvailableBytesDelta==='number'?`${report.filesystem.netAvailableBytesDelta} 字节`:'未知'}（含并发写入影响）</p>}</>}{adopting&&<ImageOwnershipForm row={adopting} onCancel={()=>setAdopting(null)} onRegistered={()=>{setAdopting(null);void refresh();}}/>}</section>;
}


function ImagePullBudget({budget}:{budget:PullBudget}) {
  const constrained=budget.headroom==='blocked'||budget.headroom==='low';
  return <div className="space-y-1 text-sm">
    <p>拉取预留 {bytes(budget.reservedBytes)} · 新拉取余量 {bytes(budget.availableBytes)} · 单次峰值预留 {bytes(budget.peakBytes)}</p>
    {budget.activeSlotCount!==undefined&&budget.slotLimit!==undefined&&<p>
      活动拉取名额 {budget.activeSlotCount} / {budget.slotLimit} · 待对账 {budget.reconciliationCount ?? 0} 笔
    </p>}
    {budget.overdueCount>0&&<p role="alert" className="text-bad">
      {budget.overdueCount} 笔拉取预留超时未确认，占用 {bytes(budget.overdueReservedBytes)}。请核对对应镜像的拉取回执。
    </p>}
    {constrained&&<p role="alert" className="text-bad">
      {budget.headroom==='blocked'?'预算不足以接纳一次新镜像拉取。':'余量低于两次峰值预留。'}请核对未结清预留与可回收镜像。
    </p>}
  </div>;
}

function ImageOwnershipForm({row,onCancel,onRegistered}:{row:Row;onCancel:()=>void;onRegistered:()=>void}) {
  const [projects,setProjects]=useState<Array<{id:string;name:string}>>([]);
  const [project,setProject]=useState(''),[historicalProject,setHistoricalProject]=useState('');
  const [evidence,setEvidence]=useState(''),[attested,setAttested]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState('');
  useEffect(()=>{const controller=new AbortController();void apiRequest<{projects:Array<{id:string;name:string}>}>('/api/janitor/tasks/images/owners',{signal:controller.signal}).then(result=>setProjects(result.projects)).catch(err=>{if(!controller.signal.aborted)setError((err as Error).message);});return()=>controller.abort();},[]);
  const projectId=project==='__historical__'?historicalProject.trim():project;
  async function register(){
    setSaving(true);setError('');
    try{await apiRequest('/api/janitor/tasks/images/adopt',{method:'POST',body:{identity:row.identity,created:row.created,aliases:row.aliases||[],digests:row.digests||[],projectId,ownershipEvidence:evidence,dataDisposition:'reproducible-artifact'}});onRegistered();}
    catch(err){setError((err as Error).message);}finally{setSaving(false);}
  }
  const field='min-h-11 rounded-md border border-input bg-background px-3 py-2';
  return <div className="space-y-3 rounded-md border border-border p-4">
    <h4 className="font-medium">核验历史镜像归属</h4>
    <p className="break-all font-mono text-xs">{row.identity}</p><p className="break-all text-xs">别名：{row.aliases?.join(', ')||'无'}；固定来源：{row.digests?.join(', ')}</p>
    <p className="text-sm">登记会重新核对身份、全部别名与 registry 中的相同内容，并记录审计。登记本身不删除镜像；通过后将遵循当前引用保护与保留策略。</p>
    <label className="grid gap-1">镜像所属项目<select className={field} value={project} onChange={event=>setProject(event.target.value)}><option value="">请选择项目</option>{projects.map(item=><option key={item.id} value={item.id}>{item.name||item.id}</option>)}<option value="__historical__">已退役项目</option></select></label>
    {project==='__historical__'&&<label className="grid gap-1">原项目标识<input className={field} value={historicalProject} onChange={event=>setHistoricalProject(event.target.value)} maxLength={128}/></label>}
    <label className="grid gap-1">可再生成与归属依据<textarea className={field} value={evidence} onChange={event=>setEvidence(event.target.value)} maxLength={2000}/></label>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={attested} onChange={event=>setAttested(event.target.checked)}/>已核查它是可从固定 registry 来源取回的构建产物，不含唯一业务数据或备份，允许按当前引用与保留规则回收。</label>
    {saving&&<p role="status" className="text-sm">正在重新核对镜像与 registry 内容，完成前保持保护。</p>}
    {error&&<p role="alert" className="text-sm text-bad">{error}；镜像继续保留。</p>}
    <div className="flex gap-2"><Button variant="outline" disabled={saving||!attested||!projectId||!evidence.trim()} onClick={()=>void register()}>重新核验并登记镜像</Button><Button variant="outline" disabled={saving} onClick={onCancel}>取消登记镜像</Button></div>
  </div>;
}
