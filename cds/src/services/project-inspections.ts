/** 外部巡检只回填事实，不创建另一个调度器。与常设探测分别标注证据来源。 */
export interface ProjectInspectionCheck {
  id: string;
  name: string;
  purpose: string;
  outcome: 'pass' | 'fail' | 'unknown' | 'skipped';
  result: string;
  evidenceUrl?: string;
  checkedAt?: string;
}
export interface ProjectInspection {
  id: string;
  name: string;
  executor: string;
  enabled: boolean;
  intervalSeconds: number;
  lastCompletedAt: string | null;
  runKind: 'manual' | 'scheduled';
  reportUrl?: string;
  checks: ProjectInspectionCheck[];
  notification: {
    channel: string;
    recipient: string;
    policy: string;
    outcome: 'not-triggered' | 'accepted' | 'failed' | 'unknown';
    at?: string;
    evidenceUrl?: string;
  };
  registeredAt: string;
  receivedAt: string;
  reportedBy: string;
}
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('巡检记录格式不正确');
  return v as Record<string, unknown>;
};
function text(v: unknown, field: string, max = 500): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) throw Error(`${field}不能为空或超出长度限制`);
  return v.trim();
}
function link(v: unknown): string | undefined {
  if (v === undefined || v === '') return undefined;
  const s = text(v, '证据链接', 2048);
  const url = new URL(s, 'https://cds.invalid');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || s.startsWith('//') || [...url.searchParams.keys()].some(k => /^(token|api[-_]?key|access[-_]?key|authorization|secret)$/i.test(k))) throw Error('证据链接不能包含凭据或不安全协议');
  return s;
}
function timestamp(v: unknown, field: string, now: number): string {
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v)) || Date.parse(v) > now + 300_000) throw Error(`${field}不是有效时间或超前于当前时间`);
  return new Date(v).toISOString();
}
export function parseProjectInspection(id: string, value: unknown, actor: string, now = Date.now()): ProjectInspection {
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(id)) throw Error('巡检标识不正确');
  const b = object(value), notice = object(b.notification);
  if (typeof b.enabled !== 'boolean' || !Number.isInteger(b.intervalSeconds) || Number(b.intervalSeconds) < 60 || Number(b.intervalSeconds) > 31_536_000) throw Error('须明确是否启用和检查间隔');
  if (!['manual', 'scheduled'].includes(String(b.runKind))) throw Error('须明确手动或定时执行');
  if (!Array.isArray(b.checks) || !b.checks.length || b.checks.length > 200) throw Error('须回填 1 至 200 项检查');
  const checks = b.checks.map(value => {
    const c = object(value), checkId = text(c.id, '检查标识', 160);
    if (!['pass', 'fail', 'unknown', 'skipped'].includes(String(c.outcome))) throw Error('检查结论不正确');
    return { id: checkId, name: text(c.name, '检查名称', 160), purpose: text(c.purpose, '检查目的'), outcome: c.outcome as ProjectInspectionCheck['outcome'], result: text(c.result, '检查结果'), evidenceUrl: link(c.evidenceUrl), checkedAt: c.checkedAt === undefined ? undefined : timestamp(c.checkedAt, '检查时间', now) };
  });
  if (checks.some(c => (c.outcome === 'pass' || c.outcome === 'fail') && !c.checkedAt)) throw Error('实际检查结果必须填写逐项检查时间');
  if (b.lastCompletedAt === null && checks.some(c => c.outcome === 'pass' || c.outcome === 'fail')) throw Error('实际检查结果必须填写完成时间');
  if (new Set(checks.map(c => c.id)).size !== checks.length) throw Error('同一巡检不能重复登记检查标识');
  if (!['not-triggered', 'accepted', 'failed', 'unknown'].includes(String(notice.outcome))) throw Error('通知结论不正确');
  if (notice.outcome === 'accepted' && !notice.evidenceUrl) throw Error('通知已送出必须附回执证据');
  return { id, name: text(b.name, '巡检名称', 160), executor: text(b.executor, '执行方', 160), enabled: b.enabled, intervalSeconds: Number(b.intervalSeconds), lastCompletedAt: b.lastCompletedAt === null ? null : timestamp(b.lastCompletedAt, '完成时间', now), runKind: b.runKind as ProjectInspection['runKind'], reportUrl: link(b.reportUrl), checks,
    notification: { channel: text(notice.channel, '通知渠道', 160), recipient: text(notice.recipient, '接收人', 160), policy: text(notice.policy, '通知条件'), outcome: notice.outcome as ProjectInspection['notification']['outcome'], at: notice.at === undefined ? undefined : timestamp(notice.at, '通知时间', now), evidenceUrl: link(notice.evidenceUrl) }, registeredAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString(), reportedBy: actor };
}

/** 服务端的常设监督和页面共用截止判据；回填空结果不能刷新未执行项的期限。 */
export function inspectionOverdue(inspection: ProjectInspection, now = Date.now()): boolean {
  if (!inspection.enabled) return false;
  const start = inspection.registeredAt;
  const times = [inspection.lastCompletedAt || start, ...inspection.checks.filter(c => c.outcome !== 'skipped').map(c => c.checkedAt || start)];
  return times.some(at => !Number.isFinite(Date.parse(at)) || now - Date.parse(at) > inspection.intervalSeconds * 1000 + 300_000);
}
export function inspectionHealthDocument(inspections: ProjectInspection[], now = Date.now()) {
  const checks = Object.fromEntries(inspections.filter(i => i.enabled).map(i => {
    const overdue = inspectionOverdue(i, now), componentId = `inspection.freshness.${i.id}`;
    return [componentId, [{ componentId, componentType: 'system', observedValue: overdue ? 1 : 0, observedUnit: 'count', status: overdue ? 'fail' : 'pass', time: new Date(now).toISOString(), output: overdue ? '巡检或其中的检查项未按时回填，请确认执行器是否正常运行' : '尚未超过本轮检查完成期限；业务是否通过请看逐项实测结果', 'cds:monitor': { name: `${i.name}是否按时完成`, field: 'observedValue', op: 'eq', value: 0, intervalSeconds: 21600, failuresToAlarm: 1, severity: 'P1', environment: 'production', publicVisible: false } }]];
  }));
  return { status: inspections.some(i => inspectionOverdue(i, now)) ? 'fail' : 'pass', serviceId: 'project-inspection-supervision', checks };
}
