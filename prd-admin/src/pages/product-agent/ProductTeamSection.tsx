import { useCallback, useEffect, useState } from 'react';
import { UserPlus, Trash2, Crown } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { SelectionActionBar, SelectableRow, useSelectableListExport } from './selectableList';
import './product-cards.css';
import {
  listProductMembers,
  addProductMembers,
  removeProductMember,
} from '@/services/real/productAgent';
import type { ProductMember, ProductMembersResult } from './types';

const ROLE_LABEL: Record<ProductMember['role'], string> = {
  owner: '负责人',
  member: '成员',
};

const ROLE_BADGE: Record<ProductMember['role'], string> = {
  owner: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  member: 'bg-token-nested text-token-secondary border-token-subtle',
};

export function ProductTeamTab({ productId }: { productId: string }) {
  const [data, setData] = useState<ProductMembersResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [pickUserId, setPickUserId] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    const res = await listProductMembers(productId);
    if (res.success) setData(res.data);
    setLoading(false);
  }, [productId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onAdd = async () => {
    if (!pickUserId) return;
    setAdding(true);
    const res = await addProductMembers(productId, [pickUserId]);
    setAdding(false);
    if (res.success) {
      setPickUserId('');
      await reload();
    }
  };

  const onRemove = async (userId: string) => {
    setBusyId(userId);
    const res = await removeProductMember(productId, userId);
    setBusyId(null);
    if (res.success) await reload();
  };

  const members = data?.members ?? [];
  const canManageMembers = data?.canManageMembers ?? false;
  const { selection, exportSelected } = useSelectableListExport(
    members,
    (m) => m.userId,
    {
      filename: `team-${productId}.csv`,
      headers: ['姓名', '角色'],
      mapRow: (m) => [m.displayName, ROLE_LABEL[m.role]],
    },
  );
  const removeSelected = async () => {
    if (!window.confirm(`确认移除选中的 ${selection.count} 名成员？`)) return;
    for (const userId of selection.selectedIds) {
      if (members.find((m) => m.userId === userId)?.role === 'owner') continue;
      const res = await removeProductMember(productId, userId);
      if (!res.success) return;
    }
    selection.clear();
    await reload();
  };

  if (loading) return <MapSectionLoader text="正在加载团队…" />;
  if (!data) return <div className="text-token-muted text-sm">团队信息加载失败</div>;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[12px] text-token-muted leading-relaxed">
        维护产品负责人和协作成员名单。
      </p>

      {canManageMembers && (
        <div className="flex items-center gap-2">
          <div className="flex-1 max-w-md">
            <UserSearchSelect
              value={pickUserId}
              onChange={setPickUserId}
              placeholder="搜索用户昵称 / 用户名，添加为成员"
            />
          </div>
          <button
            onClick={onAdd}
            disabled={!pickUserId || adding}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/15 text-[color:var(--accent-fg-blue)] border border-cyan-500/30 hover:bg-cyan-500/25 disabled:opacity-40 text-sm"
          >
            {adding ? <MapSpinner size={14} /> : <UserPlus size={15} />} 添加成员
          </button>
        </div>
      )}

      <SelectionActionBar
        mode="export"
        selection={selection}
        onExport={exportSelected}
        onDelete={canManageMembers ? removeSelected : undefined}
        deleteLabel="移除选中成员"
      />

      <div className="flex flex-col gap-2">
        {members.map((m) => {
          const isOwner = m.role === 'owner';
          const busy = busyId === m.userId;
          const canRemove = !isOwner && canManageMembers;
          return (
            <SelectableRow
              key={m.userId}
              id={m.userId}
              selection={selection}
              className="pa-row flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-token-nested border border-token-subtle"
              trailing={
                <div className="flex items-center gap-1.5 shrink-0">
                  {busy && <MapSpinner size={14} />}
                  {canRemove && (
                    <button
                      onClick={() => onRemove(m.userId)}
                      disabled={busy}
                      className="flex items-center gap-1 px-2 py-1 rounded-md text-[12px] text-[color:var(--accent-fg-danger)] hover:bg-red-500/15 disabled:opacity-40"
                      title="移除成员"
                    >
                      <Trash2 size={13} /> 移除
                    </button>
                  )}
                </div>
              }
            >
              <div className="flex items-center gap-2.5 min-w-0">
                {isOwner && <Crown size={14} className="text-amber-300 shrink-0" />}
                <span className="text-sm text-token-primary truncate">{m.displayName}</span>
                <span className={`shrink-0 px-1.5 py-0.5 rounded text-[11px] border ${ROLE_BADGE[m.role]}`}>
                  {ROLE_LABEL[m.role]}
                </span>
              </div>
            </SelectableRow>
          );
        })}
      </div>
      {members.length <= 1 && (
        <p className="text-[12px] text-token-muted">
          目前只有负责人。{canManageMembers ? '通过上方搜索框添加协作成员。' : ''}
        </p>
      )}
    </div>
  );
}
