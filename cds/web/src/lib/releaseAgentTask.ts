/**
 * 「把发布现场交给智能体」的任务文本（纯函数，可单测）。
 *
 * 为什么单独成模块而不是写在页面里：这段文本是要被人**原样粘给另一个 agent**
 * 去动生产发布链路的，它的每一句都得站得住。写在 JSX 里就只能靠肉眼审，
 * 而肉眼审不出「结论其实是编的」这种事。
 *
 * 三条纪律（与 releaseDiagnosis 同源，见 no-rootless-tree）：
 *
 * - **结论只转述，不生成。** headline / 门禁判据 / error 行全部来自
 *   `diagnoseReleaseFailure` 从真实日志里提取的内容。提不出来它会写
 *   「未能从日志中提取到结构化判据」，这里就原样带上那句话，不替它补一个像样的原因。
 * - **影响面必须由数据推出。** 只有「目标当前跑的 commit ≠ 本次这一版」才敢说
 *   生产未受影响；拿不到目标当前版本时写「待确认」，不默认它没事。
 * - **要求段是给收件 agent 的护栏**，防止它拿着一句猜测就去改发布流程。
 */

import { diagnoseReleaseFailure, type ReleaseDiagnosisLogLike } from './releaseDiagnosis';

export interface ReleaseAgentTaskInput {
  run: {
    releaseId: string;
    commitSha: string;
    status: string;
    startedAt: string;
    finishedAt?: string;
  };
  target: { name: string; host?: string };
  /** 目标当前线上跑的 commit。空串表示拿不到，此时不下「未受影响」的结论。 */
  currentCommit: string;
  logs: ReleaseDiagnosisLogLike[];
  /** 状态是否属于失败终态，由调用方按 isReleaseFailed 判定后传入。 */
  failed: boolean;
  /** 时间格式化交给调用方，保持与页面上其它地方同一种写法。 */
  formatDateTime: (value?: string) => string;
  formatDuration: (start?: string, end?: string) => string;
}

export function buildReleaseAgentTask(input: ReleaseAgentTaskInput): string {
  const { run, target, currentCommit, logs, failed } = input;
  const diag = diagnoseReleaseFailure(logs);
  const duration = input.formatDuration(run.startedAt, run.finishedAt);
  // 「未受影响」是个强结论：目标当前版本拿不到，或它就等于本次这一版，都不能说。
  const untouched = Boolean(currentCommit) && currentCommit !== run.commitSha;

  const lines: string[] = [
    failed ? 'CDS 发布失败，请定位并修复。' : 'CDS 发布现场，请核对。',
    '',
    `目标  ${target.name}${target.host ? `（${target.host}）` : ''}`,
    `记录  ${run.releaseId} · commit ${run.commitSha.slice(0, 7)} · ${input.formatDateTime(run.startedAt)}`,
    `状态  ${run.status}${duration ? ` · 耗时 ${duration}` : ''}`,
    `结论  ${diag.headline}`,
    untouched
      ? `影响  生产未受影响，${target.name}仍在 ${currentCommit.slice(0, 7)}`
      : '影响  待确认：目标当前版本与本次相同，或未能取到目标当前版本',
    '',
  ];

  if (diag.report) {
    lines.push(`门禁  ${diag.report.totalCount} 项检查，未通过 ${diag.report.failCount} 项`);
    diag.failedChecks.forEach((check) => lines.push(`- ${check.name}  ${check.detail || ''}`.trimEnd()));
    lines.push('');
  }

  if (diag.errorGroups.length > 0) {
    lines.push('error 级日志（取自本次运行，非推测）');
    diag.errorGroups.forEach((group) => {
      lines.push(`- ${group.text}${group.count > 1 ? `（× ${group.count}）` : ''}`);
    });
    lines.push('');
  }

  // 噪音要点名，否则收件 agent 大概率会追着 `context canceled` 查一整轮。
  if (diag.noiseGroups.length > 0) {
    lines.push('以下是已知噪音，不是失败原因，不要从这里入手');
    diag.noiseGroups.forEach((group) => lines.push(`- ${group.text}`));
    lines.push('');
  }

  if (diag.humanHint) lines.push(`人话  ${diag.humanHint}`, '');

  lines.push(
    '要求',
    '- 先证实再改，证实不了就把结论收回，不要顺着上面的措辞往下编',
    '- 只动本次失败那一步涉及的逻辑，不顺手改发布流程其他部分',
  );

  return lines.join('\n');
}
