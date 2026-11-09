import { useEffect, useState } from 'react';
import { apiRequest } from '@/lib/api';
import type { ReviewKeyUsage as Usage } from '../../../../src/shared/code-review-user-key';
import type { CodeReviewTask } from '@/lib/codeReviews';
import { ReviewButton } from './ReviewUi';
export function ReviewKeyUsage({ task }: { task: CodeReviewTask }): JSX.Element | null {
  const [usage, setUsage] = useState<Usage | null>(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const active = ['queued', 'preparing', 'running', 'archiving'].includes(task.status);
  useEffect(() => {
    if (!task.modelCredential) return;
    const controller = new AbortController(); let running = false;
    const read = async () => { if (running) return; running = true; try { const value = await apiRequest<Usage>(`/api/code-reviews/${encodeURIComponent(task.id)}/usage`, { signal: controller.signal }); if (!controller.signal.aborted) { setUsage(value); setError(''); } } catch { if (!controller.signal.aborted) setError('用量暂时无法读取，或当前账号不是此 Key 的所有者。'); } finally { running = false; } };
    void read(); const timer = active ? setInterval(() => void read(), 10000) : undefined;
    return () => { controller.abort(); if (timer) clearInterval(timer); };
  }, [task.id, Boolean(task.modelCredential), active, attempt]);
  if (!task.modelCredential) return null;
  const number = (value: number | null | undefined) => value == null ? '尚未提供' : value.toLocaleString();
  return <section className="cr-surface cr-progress-summary" aria-label="用户 Key 用量"><h3>使用自己的 Key</h3><p className="cr-form-note">{task.modelCredential.provider} · {task.modelCredential.model} · 标识 {task.modelCredential.fingerprint}</p>
    {usage ? <dl className="cr-facts"><dt>本次输入 / 输出</dt><dd>{number(usage.task.inputTokens)} / {number(usage.task.outputTokens)} Token</dd><dt>本次请求数</dt><dd>{number(usage.task.requests)}</dd><dt>本次费用</dt><dd>{usage.task.providerActualUsd != null ? `USD ${usage.task.providerActualUsd.toFixed(6)}（供应商返回）` : usage.task.estimatedCostUsd == null ? '未知（无可靠单价）' : `USD ${usage.task.estimatedCostUsd.toFixed(6)}（估算）`}</dd><dt>此 Key 累计输入 / 输出</dt><dd>{number(usage.key.inputTokens)} / {number(usage.key.outputTokens)} Token</dd><dt>保护额度预留</dt><dd>{number(usage.reservedTokens)} / {number(usage.tokenLimit)} Token</dd></dl> : <p role="status" className="cr-form-note">{error || '正在读取网关用量…'}</p>}
    {error && usage ? <p role="status">{error}</p> : null}<p className="cr-form-note">与网关共享用量记录，记录写入可能延迟数秒。累计仅含当前账号在此项目中经本系统使用该 Key 的消耗；保护额度预留不等于实际用量或账号余额。</p><ReviewButton tone="ghost" onClick={() => setAttempt(v => v + 1)}>刷新用量</ReviewButton>
  </section>;
}
