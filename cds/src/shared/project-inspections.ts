/** 前后端共用的巡检数据与截止判据；不引入服务端状态、存储或运行时。 */
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
/** 服务端的常设监督和页面共用截止判据；回填空结果不能刷新未执行项的期限。 */
export function inspectionOverdue(inspection: ProjectInspection, now = Date.now()): boolean {
  if (!inspection.enabled) return false;
  const start = inspection.registeredAt;
  const times = [inspection.lastCompletedAt || start, ...inspection.checks.filter(c => c.outcome !== 'skipped').map(c => c.checkedAt || start)];
  return times.some(at => !Number.isFinite(Date.parse(at)) || now - Date.parse(at) > inspection.intervalSeconds * 1000 + 300_000);
}
