import { useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { apiRequest } from '@/lib/api';
import type { PlanningCheckup, PlanningCheckupRead } from '../../../../src/shared/engineering-planning';
import { dateLabel, planningError, planningPath, usePlanningRead } from './planning-ui';

export function PlanningCheckupMenu({ projectId, data, onRefresh, onDebt }: {
  projectId: string; data?: PlanningCheckup; onRefresh: () => void; onDebt: (id: string) => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const count = data?.unread ?? 0;
  async function markRead(input: PlanningCheckupRead, debtId?: string) {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await apiRequest(`${planningPath(projectId)}/checkup/read`, { method: 'POST', body: input });
      onRefresh();
      if (debtId && menu.current) { menu.current.open = false; onDebt(debtId); }
    } catch (failure) { setError(planningError(failure)); }
    finally { setSaving(false); }
  }
  return <details className="ep-new ep-checkup" ref={menu} onToggle={event => { if (event.currentTarget.open) onRefresh(); }}>
    <summary className="ep-button ep-checkup-toggle" aria-label={`巡检通知${count ? `，${count} 条未读` : ''}`}>
      <Bell aria-hidden="true" />{count > 0 && <small aria-hidden="true">{count > 99 ? '99+' : count}</small>}
    </summary>
    <div className="ep-checkup-pop">
      <header><strong>巡检通知</strong>{count > 0 && <button type="button" disabled={saving} onClick={() => void markRead({ all: true })}>全部标为已读</button>}</header>
      {error && <p role="alert" className="ep-error">{error}</p>}
      {!data?.notices?.length ? <p className="ep-caption">暂无巡检通知</p> : <ul>
        {data.notices.map(row => <li key={row.id}>
          <button type="button" disabled={saving} data-unread={!row.readAt} onClick={() => {
            if (!row.readAt) { void markRead({ id: row.id }, row.debtIds[0]); return; }
            if (row.debtIds[0]) { if (menu.current) menu.current.open = false; onDebt(row.debtIds[0]); }
          }}><strong>{row.title}</strong><span>{row.detail}</span><time dateTime={row.at}>{dateLabel(row.at)}</time></button>
        </li>)}
      </ul>}
    </div>
  </details>;
}

export function usePlanningCheckup(target: string | null, reload: number) {
  const [refresh, setRefresh] = useState(0);
  const checkup = usePlanningRead<PlanningCheckup>(target && `${target}/checkup`, reload + refresh);
  return { checkup: checkup.data, refreshCheckup: () => setRefresh(value => value + 1) };
}
