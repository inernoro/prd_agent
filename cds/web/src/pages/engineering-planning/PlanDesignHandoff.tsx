import { useContext, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ConsoleAuthContext } from '@/components/layout/AppShell';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { apiRequest } from '@/lib/api';
import type { DesignIntake } from '../../../../src/shared/design-workspace';
import type { PlanningPlan } from '../../../../src/shared/engineering-planning';
import { usePlanningRead } from './planning-ui';

export function PlanDesignHandoff({ plan, original }: { plan: PlanningPlan; original: string }) {
  const owner = useContext(ConsoleAuthContext).status?.user?.isSystemOwner === true;
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [receipt, setReceipt] = useState('');
  const [issue, setIssue] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ version: number; key: string; requestId: string }>();
  const base = `/api/projects/${encodeURIComponent(plan.projectId)}/design`;
  const intake = usePlanningRead<DesignIntake>(owner ? `${base}/intake` : null, 0);
  const existing = intake.data?.projectId === plan.projectId ? intake.data.requirements?.find(row => row.planId === plan.id) : undefined;
  const selected = existing?.designKey ?? key.trim();
  const valid = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(selected);
  if (!owner) return null;

  const share = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setIssue('');
    if (pending.current?.key !== selected || pending.current.version !== plan.version) {
      pending.current = { key: selected, version: plan.version, requestId: crypto.randomUUID() };
    }
    try {
      const result = await apiRequest<{ projectId: string; result: { planId: string; designKey: string } }>(`${base}/commands`, {
        method: 'POST', body: { type: 'brief.share', requestId: pending.current.requestId, planId: plan.id, designKey: selected, expectedVersion: plan.version },
      });
      if (result.projectId !== plan.projectId || result.result.planId !== plan.id || result.result.designKey !== selected) {
        throw new Error('交接回执和当前计划不符');
      }
      pending.current = undefined;
      setReceipt(selected);
      setOpen(false);
    } catch (error) {
      setIssue(error instanceof Error ? error.message : '暂时无法交给设计，请沿用当前计划重试');
    } finally { setBusy(false); }
  };
  return <div className="ep-row">
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogTrigger asChild><button type="button" className="ep-button">交给设计</button></DialogTrigger>
      <DialogContent className="ep-dialog" frame>
        <DialogHeader>
          <DialogTitle>交给设计</DialogTitle>
          <DialogDescription>当前项目中已获授权的设计智能体可在接入清单读取这段已确认原文。</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form id="plan-design-handoff" onSubmit={event => { event.preventDefault(); void share(); }}>
            <p className="ep-record-callout"><span>{original}</span></p>
            <label className="ep-field">设计接入标识
              <input value={selected} onChange={event => setKey(event.target.value)} readOnly={!!existing}
                placeholder="例如 product/account-access" maxLength={129} required />
            </label>
            <p className="ep-caption">同一模块的稿件和后续修订沿用这个标识。</p>
            {(issue || intake.error) && <p role="alert" className="ep-error">{issue || intake.error}</p>}
          </form>
        </DialogBody>
        <DialogFooter>
          <button type="button" className="ep-button" onClick={() => setOpen(false)} disabled={busy}>取消</button>
          <button type="submit" form="plan-design-handoff" className="ep-button ep-button--primary" disabled={!valid || busy || intake.loading || !!intake.error}>确认交接</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {(receipt || existing) && <Link className="ep-link" to={`/design?${new URLSearchParams({ project: plan.projectId, brief: receipt || existing!.designKey })}`}>查看已交接需求</Link>}
  </div>;
}
