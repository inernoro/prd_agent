import { useState } from 'react';
import { Check } from 'lucide-react';
import { designSlots, type DesignEntry, type DesignFeedback, type DesignFeedbackAction, type DesignFeedbackProof,
  type DesignWorkspace } from '../../../../src/shared/design-workspace';
import { checkFeedbackLanguage, feedbackActionLabels, feedbackHandover, feedbackProgramProof } from '../../../../src/shared/design-feedback';
import { designPublisherLabel, slotNames, type DesignCommand } from './design-ui';

type Handover = ReturnType<typeof feedbackHandover>;

export function DesignFeedbackHandover({ entry, row, permissions, busy, command }: {
  entry: DesignEntry; row: DesignFeedback; permissions: DesignWorkspace['permissions']; busy: boolean; command: DesignCommand;
}) {
  const hand = feedbackHandover(row);
  const proofs = row.stage ? entry.runs.slice().reverse().flatMap(run =>
    Object.keys(run.programEvidence ?? {}).flatMap(key => {
      const [screenId, value] = key.split('/');
      const slot = designSlots.find(item => item === value);
      const proof = slot && feedbackProgramProof(entry, row, run, screenId, slot);
      return proof ? [proof] : [];
    })) : [];
  const figures = row.stage === 'done' ? new Set(row.transitions?.flatMap(step => step.proof ? [step.proof.imageId] : [])).size
    : row.attachments?.length ?? 0;
  return <HandoverBar key={hand.stage} hand={hand} canAct={Boolean(row.stage && permissions.feedback)}
    human={permissions.human ?? permissions.review} actorId={permissions.actorId} busy={busy} proofs={proofs} figures={figures}
    onStage={(action, body, proof) => command('feedback.stage', { designId: entry.id, feedbackId: row.id, body, action,
      expectedStage: hand.stage, ...(proof ? { proof: { runId: proof.runId, screenId: proof.screenId, slot: proof.slot } } : {}) })} />;
}

const stageSteps: [Handover['stage'][], string][] = [[['raised'], '提出'], [['working', 'returned'], '处理'], [['review'], '待确认'], [['done'], '完结']];
function HandoverBar({ hand, canAct, human, actorId, busy, proofs, figures, onStage }: {
  hand: Handover; canAct: boolean; human: boolean; actorId?: string; busy: boolean; proofs: DesignFeedbackProof[]; figures: number;
  onStage: (action: DesignFeedbackAction, body: string, proof?: DesignFeedbackProof) => Promise<boolean>;
}) {
  const [asking, setAsking] = useState<DesignFeedbackAction>();
  const [note, setNote] = useState('');
  const [imageId, setImageId] = useState('');
  const at = stageSteps.findIndex(([stages]) => stages.includes(hand.stage));
  const actions: DesignFeedbackAction[] = canAct && hand.holder && hand.holder.id === actorId
    ? hand.stage === 'raised' ? ['take'] : hand.stage === 'review' ? (human ? ['confirm', 'return'] : ['return']) : ['deliver'] : [];
  const selection = asking && actions.includes(asking) ? asking : undefined;
  const label = (action: DesignFeedbackAction) => action === 'confirm' ? '确认完结' : feedbackActionLabels[action];
  const needProof = selection === 'confirm' || selection === 'deliver';
  const proof = proofs.find(row => row.imageId === imageId) ?? (proofs.length === 1 ? proofs[0] : undefined);
  const issue = note.trim() ? checkFeedbackLanguage(note, '').problems[0] : undefined;
  return <div className="dw-fl-handover" data-stage={hand.stage}>
    <ol className="dw-fl-steps">{stageSteps.map(([, label], index) => <li key={label} data-on={index === at || undefined} data-past={index < at || undefined}>
      <b>{index < at ? <Check size={12} aria-hidden /> : index + 1}</b>{hand.stage === 'returned' && index === 1 ? '退回重做' : label}</li>)}</ol>
    <p className="dw-fl-who-line"><span>{designPublisherLabel(hand.raiser.label)} 提出</span><span aria-hidden>→</span>
      <span>{hand.handler ? <>{designPublisherLabel(hand.handler.label)} 处理</> : '还没指定交接方'}</span>
      {hand.confirmer && <span>{designPublisherLabel(hand.confirmer.label)} 确认</span>}
      {hand.holder ? <span className="dw-fl-ball">球在 <b>{designPublisherLabel(hand.holder.label)}</b>{hand.owed > 0 && ` · 欠 ${hand.owed} 句`}</span> : <span className="dw-fl-ball">完结，只留截图为证（{figures} 张）</span>}
      {hand.stall && <span className="dw-fl-stall" data-stall={hand.stall}>{hand.stall === 'bad' ? `停了 ${hand.stalledDays} 天，需要人介入` : `停了 ${hand.stalledDays} 天`}</span>}</p>
    {actions.length > 0 && !selection && <span className="dw-fl-acts">{actions.map(action => <button key={action} type="button"
      className={action === 'return' ? 'ep-button' : 'ep-button ep-button--primary'} data-action={`stage-${action}`}
      onClick={() => { setAsking(action); setNote(''); setImageId(''); }}>{label(action)}</button>)}</span>}
    {selection && <form className="dw-fl-stage-form" onSubmit={async event => {
      event.preventDefault();
      if (issue || needProof && !proof) return;
      if (await onStage(selection, note.trim(), needProof ? proof : undefined)) { setAsking(undefined); setNote(''); }
    }}>
      <label><span className="dw-fl-lab">{selection === 'take' ? '打算怎么处理' : selection === 'return' ? '哪里还需要修改' : '一句话结论'}</span>
        <input value={note} onChange={event => setNote(event.target.value)} required maxLength={40} autoFocus /></label>
      {issue && <p className="dw-fl-hint" role="status">{issue}</p>}
      {needProof && (proofs.length ? <label>选择本次运行的程序截图<select required value={proof?.imageId ?? ''} onChange={event => setImageId(event.target.value)}>
        <option value="">选择截图</option>{proofs.map(row => <option key={row.imageId} value={row.imageId}>{row.screenId} · {slotNames[row.slot]} · {row.commit.slice(0, 8)}</option>)}
      </select></label> : <p className="dw-fl-hint" role="alert">还没有程序截图。请先到验收页为需要核对的画面取证。</p>)}
      <span className="dw-dl-compose-actions"><button type="button" className="ep-button" onClick={() => setAsking(undefined)}>取消</button>
        <button type="submit" className="ep-button ep-button--primary" disabled={busy || !note.trim() || Boolean(issue) || needProof && !proof}>{label(selection)}</button></span>
    </form>}
  </div>;
}
