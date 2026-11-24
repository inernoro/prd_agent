import { useState, type FormEvent } from 'react';
import { BadgeCheck, CircleAlert, ExternalLink, Link2 } from 'lucide-react';
import {
  planningAnchorTypes, planningVerificationMethods, planningVerificationPeriods, planningVerificationState,
  type PlanningAnchorTarget, type PlanningDebt, type PlanningDebtDetail, type PlanningEvidence, type PlanningVerification,
} from '../../../../src/shared/engineering-planning';
import { closedDebt, dateLabel, type PlanningInput } from './planning-ui';
import './planning-debt-health.css';

export type DebtHealthMode = 'verify' | 'anchor' | 'anchor-missing' | 'anchor-confirm';
type DebtHealthInput = Extract<PlanningInput, { type: 'debt.verify' | 'debt.anchor' | 'debt.anchor-missing' | 'debt.anchor-confirm' }>;
type VerificationState = ReturnType<typeof planningVerificationState>;

const verificationLabels: Record<PlanningVerification['method'], string> = {
  reproduce: '复现确认', test: '自动化用例失败', monitor: '线上日志或监控', review: '代码检查',
};
const verificationEvidenceTypes: Record<PlanningVerification['method'], PlanningEvidence['type']> = {
  reproduce: 'acceptance', test: 'test', monitor: 'log', review: 'change',
};
const anchorLabels: Record<PlanningAnchorTarget['type'], string> = {
  feature: '功能模块', route: '路由', file: '文件', flag: '功能开关', dep: '依赖版本', api: '接口',
};
const verificationStateLabels: Record<VerificationState, string> = {
  unverified: '未认证', verified: '已认证', expired: '认证已过期',
};

export const debtHealthTitle = (debt: PlanningDebt, mode: DebtHealthMode) => {
  if (mode === 'verify') return '认证债务';
  if (mode === 'anchor-missing') return '记录功能消失';
  if (mode === 'anchor-confirm') return '确认功能消失';
  if (debt.anchor?.status === 'missing') return '保留债务';
  return debt.anchor ? '更改功能绑定' : '绑定功能';
};

export function DebtHealthBadge({ debt, at = Date.now(), state }: { debt: PlanningDebt; at?: number; state?: VerificationState }) {
  if (closedDebt(debt.status)) return null;
  if (debt.anchor?.status === 'missing') return <span className="ep-health-badge" data-health="missing">
    <CircleAlert aria-hidden="true" />疑似消灭
  </span>;
  const current = state ?? planningVerificationState(debt.verify, at);
  return current === 'unverified' ? null : <span className="ep-health-badge" data-health={current}>
    <BadgeCheck aria-hidden="true" />{verificationStateLabels[current]}
  </span>;
}

function HealthEvidence({ rows }: { rows: PlanningEvidence[] }) {
  if (!rows.length) return null;
  return <ul className="ep-health-evidence">
    {rows.map((row, index) => <li key={`${row.type}:${row.label}:${index}`}>
      {row.url ? <a href={row.url} target="_blank" rel="noreferrer">{row.label}<ExternalLink aria-hidden="true" /></a> : row.label}
    </li>)}
  </ul>;
}

export function DebtHealthSection({ debt, health, canWrite, disabled, onAction }: {
  debt: PlanningDebt;
  health?: PlanningDebtDetail['health'];
  canWrite: boolean;
  disabled?: boolean;
  onAction: (mode: DebtHealthMode) => void;
}) {
  const anchor = debt.anchor;
  const verify = debt.verify;
  const active = !closedDebt(debt.status);
  const verified = health?.verification ?? planningVerificationState(verify, Date.now());
  const missing = active && anchor?.status === 'missing';
  if (!anchor && !verify && !active) return null;

  return <section className="ep-health" aria-label="债务认证与功能绑定">
    <div className="ep-health-row">
      <div><h3>债务认证</h3><p>{verificationStateLabels[verified]}{verify && ` · ${verificationLabels[verify.method]}`}</p></div>
      {active && canWrite && !missing && <button type="button" className="ep-button" disabled={disabled} onClick={() => onAction('verify')}>
        {verify ? '重新认证' : '认证债务'}
      </button>}
    </div>
    {verify && <div className="ep-health-details">
      <p>{verify.note}</p>
      <p className="ep-health-meta">{verify.by.label} · <time dateTime={verify.at}>{dateLabel(verify.at)}</time> · 有效 {verify.validDays} 天</p>
      <HealthEvidence rows={verify.evidence} />
    </div>}
    <div className="ep-health-row">
      <div><h3>功能绑定</h3><p>{anchor ? `${anchorLabels[anchor.type]} · ${anchor.ref}` : '未绑定功能'}</p></div>
      {active && canWrite && !missing && <button type="button" className="ep-button" disabled={disabled} onClick={() => onAction('anchor')}>
        <Link2 aria-hidden="true" />{anchor ? '更改绑定' : '绑定功能'}
      </button>}
    </div>
    {anchor?.status === 'alive' && active && canWrite && <div className="ep-health-actions">
      <button type="button" className="ep-button" disabled={disabled} onClick={() => onAction('anchor-missing')}>记录功能消失</button>
    </div>}
    {anchor?.status === 'missing' && missing && <div className="ep-health-removal">
      <h4>疑似随功能消失</h4>
      <p>{anchor.note}</p>
      <p>缓冲期至 <time dateTime={anchor.closeAt}>{dateLabel(anchor.closeAt)}</time>
        {health?.daysUntilClosure !== undefined && <>{health.daysUntilClosure > 0 ? ` · 还剩 ${health.daysUntilClosure} 天` : ' · 已到期待巡检'}</>}</p>
      <HealthEvidence rows={anchor.evidence} />
      {canWrite && <div className="ep-health-actions">
        <button type="button" className="ep-button" disabled={disabled} onClick={() => onAction('anchor-confirm')}>确认功能消失</button>
        <button type="button" className="ep-button" disabled={disabled} onClick={() => onAction('anchor')}>保留债务</button>
      </div>}
    </div>}
    {anchor?.status === 'gone' && <div className="ep-health-details">
      <p>随功能消失 · <time dateTime={anchor.closedAt}>{dateLabel(anchor.closedAt)}</time></p>
      <HealthEvidence rows={anchor.evidence} />
    </div>}
  </section>;
}

export function DebtHealthForm({ debt, mode, busy, error, onCancel, onSubmit }: {
  debt: PlanningDebt; mode: DebtHealthMode; busy: boolean; error?: string; onCancel: () => void; onSubmit: (input: DebtHealthInput) => void;
}) {
  const [method, setMethod] = useState<PlanningVerification['method']>('reproduce');
  const [validDays, setValidDays] = useState<PlanningVerification['validDays']>(30);
  const [note, setNote] = useState('');
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [target, setTarget] = useState<PlanningAnchorTarget>(() => ({
    type: debt.anchor?.type ?? 'feature', ref: debt.anchor?.ref ?? '',
  }));
  const [unbind, setUnbind] = useState(false);
  const verification = mode === 'verify';
  const reporting = mode === 'anchor-missing';
  const confirmation = mode === 'anchor-confirm';
  const title = debtHealthTitle(debt, mode);
  const ready = confirmation || (note.trim() && (mode !== 'anchor' || unbind || target.ref.trim())
    && (!reporting || (url.trim() && label.trim())));
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || busy) return;
    const row = { debtId: debt.id, expectedVersion: debt.version };
    const trimmedNote = note.trim();
    if (mode === 'verify') {
      const proof = label.trim() || url.trim() ? [{ type: verificationEvidenceTypes[method],
        label: label.trim() || verificationLabels[method], ...(url.trim() ? { url: url.trim() } : {}) }] : [];
      onSubmit({ ...row, type: 'debt.verify', method, validDays, note: trimmedNote, evidence: proof });
    } else if (mode === 'anchor') {
      onSubmit({ ...row, type: 'debt.anchor', anchor: unbind ? null : { ...target, ref: target.ref.trim() }, reason: trimmedNote });
    } else if (mode === 'anchor-missing') {
      onSubmit({ ...row, type: 'debt.anchor-missing', note: trimmedNote, evidence: [{ type: 'change', label: label.trim(), url: url.trim() }] });
    } else {
      onSubmit({ ...row, type: 'debt.anchor-confirm', ...(trimmedNote ? { note: trimmedNote } : {}) });
    }
  }

  return <form className="ep-health-form" onSubmit={submit}>
    {verification && <>
      <label className="ep-field"><span>认证方式</span><select value={method} onChange={event => setMethod(event.target.value as typeof method)}>
        {planningVerificationMethods.map(value => <option key={value} value={value}>{verificationLabels[value]}</option>)}
      </select></label>
      <label className="ep-field"><span>有效期</span><select value={validDays} onChange={event => setValidDays(Number(event.target.value) as typeof validDays)}>
        {planningVerificationPeriods.map(value => <option key={value} value={value}>{value} 天</option>)}
      </select></label>
    </>}
    {mode === 'anchor' && <>
      {debt.anchor && <label className="ep-health-toggle"><input type="checkbox" checked={unbind} onChange={event => setUnbind(event.target.checked)} />解除绑定并保留债务</label>}
      {!unbind && <>
        <label className="ep-field"><span>绑定类型</span><select value={target.type}
          onChange={event => setTarget(previous => ({ ...previous, type: event.target.value as PlanningAnchorTarget['type'] }))}>
          {planningAnchorTypes.map(value => <option key={value} value={value}>{anchorLabels[value]}</option>)}
        </select></label>
        <label className="ep-field"><span>功能位置</span><input required value={target.ref} maxLength={500}
          onChange={event => setTarget(previous => ({ ...previous, ref: event.target.value }))} /></label>
      </>}
    </>}
    {reporting && <p className="ep-health-meta">提供实际的变更链接。提交后进入 7 天缓冲期，可在期间保留债务或确认关闭。到期未处理的记录由巡检关闭。</p>}
    {confirmation && <p className="ep-health-meta">确认后会立即结案，并保留已登记的变更证据。</p>}
    <label className="ep-field"><span>{mode === 'anchor' ? '原因' : '说明'}{confirmation && '（选填）'}</span>
      <textarea value={note} required={!confirmation} maxLength={mode === 'anchor' ? 2000 : 4000}
        onChange={event => setNote(event.target.value)} />
    </label>
    {(verification || reporting) && <>
      <label className="ep-field"><span>{reporting ? '变更名称' : '证据名称（选填）'}</span>
        <input value={label} required={reporting} maxLength={500} onChange={event => setLabel(event.target.value)} />
      </label>
      <label className="ep-field"><span>{reporting ? '变更链接' : '证据链接（选填）'}</span>
        <input type="url" value={url} required={reporting} maxLength={2000} onChange={event => setUrl(event.target.value)} />
      </label>
    </>}
    {error && <p className="ep-error" role="alert">{error}</p>}
    <footer className="ep-dialog-footer"><button type="button" className="ep-button" disabled={busy} onClick={onCancel}>取消</button>
      <button type="submit" className="ep-button ep-button--primary" disabled={!ready || busy}>{busy ? '保存中' : title}</button>
    </footer>
  </form>;
}
