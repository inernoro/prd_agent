import { monitorIncidentPath } from '../../../src/services/monitor-incident-link';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_SYSTEMS, NOTIFICATION_ENVIRONMENTS, NOTIFICATION_TEMPLATES, UNKNOWN_CLASSIFICATION, notificationTemplatePattern, type NotificationTemplateId, type ReportClassification } from '../../../src/shared/notification-templates';
import { apiRequest, type AcceptanceReport } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
export interface ClassificationSelection { categories: string[]; systems: string[]; environments: string[] }
const groups = [['categories', '类别', NOTIFICATION_CATEGORIES], ['systems', '系统', NOTIFICATION_SYSTEMS], ['environments', '环境', NOTIFICATION_ENVIRONMENTS]] as const;
export function ClassificationFilters({ value, onChange }: { value: ClassificationSelection; onChange: (value: ClassificationSelection) => void }) {
  return <div className="space-y-2 rounded-md border border-[hsl(var(--hairline))] bg-card p-3" aria-label="交叉分类筛选">
    {groups.map(([field, label, options]) => <fieldset key={field} className="flex flex-wrap items-center gap-1.5">
      <legend className="float-left mr-2 py-1 text-sm font-medium">{label}</legend>
      {Object.entries(options).map(([key, text]) => <button type="button" key={key} aria-pressed={value[field].includes(key)}
        onClick={() => onChange({ ...value, [field]: value[field].includes(key) ? value[field].filter(k => k !== key) : [...value[field], key] })}
        className={`rounded border px-2 py-1 text-xs ${value[field].includes(key) ? 'border-primary bg-[hsl(var(--accent))] text-foreground' : 'border-[hsl(var(--hairline))] text-muted-foreground hover:text-foreground'}`}>{text}</button>)}
    </fieldset>)}
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground"><span>同一行任选匹配，三行共同筛选；报告不重复计数。</span>
      {(value.categories.length + value.systems.length + value.environments.length) > 0 && <button type="button" className="text-primary underline" onClick={() => onChange({ categories: [], systems: [], environments: [] })}>清空交叉筛选</button>}
    </div>
  </div>;
}
export function ClassificationSummary({ report, onSaved }: { report: AcceptanceReport; onSaved?: (r: AcceptanceReport) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<ReportClassification>(report.classification || UNKNOWN_CLASSIFICATION);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const c = report.classification || UNKNOWN_CLASSIFICATION;
  async function save() {
    setSaving(true); setError('');
    try { const res = await apiRequest<{ report: AcceptanceReport }>(`/api/reports/${report.id}`, { method: 'PATCH', body: { classification: value } }); onSaved?.(res.report); setEditing(false); }
    catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  }
  return <div className="shrink-0 space-y-1 border-b border-[hsl(var(--hairline))] bg-card px-3 py-2 text-xs" aria-label="报告交叉分类">
    <p>类别：{c.categories.map(k => NOTIFICATION_CATEGORIES[k]).join('、') || '未分类'}　系统：{NOTIFICATION_SYSTEMS[c.primarySystem]}{c.relatedSystems.length ? `；关联 ${c.relatedSystems.map(k => NOTIFICATION_SYSTEMS[k]).join('、')}` : ''}　环境：{c.environments.map(k => NOTIFICATION_ENVIRONMENTS[k]).join('、')}</p>
    <div className="flex flex-wrap items-center gap-3">
      {report.monitorEvent ? <><span>事件：{report.monitorEvent.state === 'drill' ? '通知演练' : report.monitorEvent.state === 'recovered' ? '已恢复' : '检查异常'} · {report.monitorEvent.snapshots.length} 条发生与恢复记录</span>
        {report.monitorEvent.targetId && <Link className="text-primary underline" to={monitorIncidentPath(report.monitorEvent.targetId, report.monitorEvent.incidentId, report.monitorEvent.snapshots[0]?.detectedAt)}>查看同一监控目标</Link>}</>
        : <button type="button" className="text-primary underline" onClick={() => { setValue(report.classification || UNKNOWN_CLASSIFICATION); setEditing(true); }}>编辑交叉分类</button>}
    </div>
    <Dialog open={editing} onOpenChange={setEditing}><DialogContent><DialogHeader><DialogTitle>编辑报告交叉分类</DialogTitle></DialogHeader>
      <ClassificationFilters value={{ categories: value.categories, systems: [value.primarySystem, ...value.relatedSystems], environments: value.environments }} onChange={v => {
        const known = v.systems.filter(k => k !== 'unknown');
        const primarySystem = (value.primarySystem !== 'unknown' && known.includes(value.primarySystem) ? value.primarySystem : known[0] || 'unknown') as ReportClassification['primarySystem'];
        setValue({ categories: v.categories as ReportClassification['categories'], primarySystem,
          relatedSystems: known.filter(k => k !== primarySystem) as ReportClassification['relatedSystems'],
          environments: (v.environments.length ? v.environments : ['unknown']) as ReportClassification['environments'] });
      }} />
      <label className="text-sm">主体系统<select className="ml-2 rounded border bg-card p-1" value={value.primarySystem} onChange={e => { const primarySystem = e.target.value as ReportClassification['primarySystem']; setValue({ ...value, primarySystem, relatedSystems: [...new Set([...(value.primarySystem === 'unknown' ? [] : [value.primarySystem]), ...value.relatedSystems])].filter(k => k !== primarySystem && k !== 'unknown') }); }}>
        {Object.entries(NOTIFICATION_SYSTEMS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      {error && <p role="alert">{error}</p>}<Button disabled={saving} onClick={() => void save()}>{saving ? '正在保存' : '保存分类'}</Button>
    </DialogContent></Dialog>
  </div>;
}
export function NotificationTemplateCatalog() {
  const [open, setOpen] = useState(false);
  return <><Button variant="outline" size="sm" onClick={() => setOpen(true)}>通知模板</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>通知模板 · 单文件维护</DialogTitle></DialogHeader>
      <p className="text-sm text-muted-foreground">手机与手表采用同一句话：环境、系统、功能、结果。优先30字，最多40字。详情进入对应事件报告。</p>
      <p className="break-all text-xs text-muted-foreground">维护文件：cds/src/shared/notification-templates.json</p>
      <div className="space-y-2">{Object.entries(NOTIFICATION_TEMPLATES).map(([id, t]) => <div key={id} className="rounded border border-[hsl(var(--hairline))] p-2 text-sm"><p className="font-medium">{id} · {t.categories.map(k => NOTIFICATION_CATEGORIES[k]).join('、')}</p><p>{notificationTemplatePattern(id as NotificationTemplateId)}</p></div>)}</div>
    </DialogContent></Dialog></>;
}
