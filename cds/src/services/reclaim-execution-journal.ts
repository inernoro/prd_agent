/** Bounded, durable status; native catalogs remain the authority for object retirement. */
export interface ReclaimExecutionJournal {
  read(): any;
  write(value: any): void;
}
export function resumedReclaimExecution(journal?: ReclaimExecutionJournal): any {
  const previous = journal?.read();
  if (!previous) return null;
  return previous.status === 'running'
    ? { ...previous, status: 'interrupted', error: '服务已重启；上次执行未确认结束。资源清单会继续对账，请刷新候选。' }
    : previous;
}
export function recordReclaimExecution(journal: ReclaimExecutionJournal | undefined, execution: any) {
  if (!journal) return;
  // Do not place an unbounded host inventory inside the control-plane global document.
  const bounded = JSON.parse(JSON.stringify(execution, (_key, value) => Array.isArray(value) && value.length > 20 ? value.slice(0, 20) : value));
  if (JSON.stringify(bounded).length > 64 * 1024) bounded.report = { counts: execution.report?.counts, scanStatus: execution.report?.scanStatus, detailsAvailableInFreshPreview: true };
  journal.write(bounded);
}
