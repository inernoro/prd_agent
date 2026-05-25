import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { useTeamStore } from '@/stores/teamStore';

/**
 * 把内容（网页 / 知识库）分享到我的团队。
 * 勾选的团队成为分享目标（覆盖原有团队分享）；全不选则撤销团队分享。
 */
export function ShareToTeamDialog({
  title,
  initialTeamIds,
  onConfirm,
  onClose,
}: {
  title: string;
  initialTeamIds?: string[];
  onConfirm: (teamIds: string[]) => void | Promise<void>;
  onClose: () => void;
}) {
  const { teams, loadTeams } = useTeamStore();
  const [picked, setPicked] = useState<Set<string>>(new Set(initialTeamIds ?? []));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadTeams();
  }, [loadTeams]);

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={title}
      content={
        <div className="space-y-3">
          {teams.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              你还没有团队，请先在「管理团队」里创建或加入一个团队。
            </p>
          ) : (
            <div className="space-y-1.5 max-h-[300px] overflow-auto" style={{ overscrollBehavior: 'contain' }}>
              {teams.map((t) => (
                <label
                  key={t.team.id}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer"
                  style={{
                    background: picked.has(t.team.id) ? 'rgba(212,175,55,0.1)' : 'var(--bg-input)',
                    border: '1px solid rgba(255,255,255,0.1)',
                  }}
                >
                  <input type="checkbox" checked={picked.has(t.team.id)} onChange={() => toggle(t.team.id)} />
                  <span className="text-sm flex-1" style={{ color: 'var(--text-primary)' }}>
                    {t.team.name}
                  </span>
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {t.memberCount} 人
                  </span>
                </label>
              ))}
            </div>
          )}
          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            说明：勾选的团队将成为分享目标（会覆盖原有团队分享）；取消全部勾选则撤销团队分享。
          </p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={saving || teams.length === 0}
              onClick={async () => {
                setSaving(true);
                await onConfirm([...picked]);
                setSaving(false);
              }}
            >
              确认分享
            </Button>
          </div>
        </div>
      }
    />
  );
}
