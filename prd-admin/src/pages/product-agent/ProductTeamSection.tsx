/**
 * 产品团队 tab — 成员管理 + 产品管理员指派。
 *
 * 角色三级：负责人(owner) / 产品管理员(admin) / 成员(member)。
 * - canManageMembers：可增删普通成员（全局管理 / 负责人 / 产品管理员）。
 * - canManageAdmins：可指派/撤销产品管理员（仅全局管理 / 负责人）。
 * 后端按角色再次校验（ProductAgentController），前端仅据标志显隐操作入口。
 */
import { useCallback, useEffect, useState } from 'react';
import { UserPlus, ShieldCheck, ShieldOff, Trash2, Crown } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { SelectionActionBar, SelectableRow, useSelectableListExport } from './selectableList';
import './product-cards.css';
import {
  listProductMembers,
  addProductMembers,
  removeProductMember,
  setProductMemberRole,
} from '@/services/real/productAgent';
import type { ProductMember, ProductMembersResult } from './types';

const ROLE_LABEL: Record<ProductMember['role'], string> = {
  owner: '负责人',
  admin: '产品管理员',
  member: '成员',
};

const ROLE_BADGE: Record<ProductMember['role'], string> = {
  owner: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  admin: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
  member: 'bg-white/5 text-white/50 border-white/10',
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

  const onSetRole = async (userId: string, role: 'admin' | 'member') => {
    setBusyId(userId);
    const res = await setProductMemberRole(productId, userId, role);
    setBusyId(null);
    if (res.success) await reload();
  };

  const members = data?.members ?? [];
  const canManageMembers = data?.canManageMembers ?? false;
  const canManageAdmins = data?.canManageAdmins ?? false;
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
  if (!data) return <div className="text-white/40 text-sm">团队信息加载失败</div>;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[12px] text-white/40 leading-relaxed">
        管理本产品的团队成员与产品管理员。
        {canManageAdmins
          ? '你可以增删成员，并指派/撤销产品管理员。'
          : canManageMembers
            ? '你可以增删普通成员；指派产品管理员需负责人或 MAP 管理员。'
            : '你当前为只读权限，仅查看成员名单。'}
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
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 disabled:opacity-40 text-sm"
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
          const isAdmin = m.role === 'admin';
          const busy = busyId === m.userId;
          const canRemove = !isOwner && (isAdmin ? canManageAdmins : canManageMembers);
          return (
            <SelectableRow
              key={m.userId}
              id={m.userId}
              selection={selection}
              className="pa-row flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/5"
              trailing={
                <div className="flex items-center gap-1.5 shrink-0">
                  {busy && <MapSpinner size={14} />}
                  {!isOwner && canManageAdmins && !isAdmin && (
                    <button
                      onClick={() => onSetRole(m.userId, 'admin')}
                      disabled={busy}
                      className="flex items-center gap-1 px-2 py-1 rounded-md text-[12px] text-purple-300 hover:bg-purple-500/15 disabled:opacity-40"
                      title="指派为产品管理员"
                    >
                      <ShieldCheck size={13} /> 设为管理员
                    </button>
                  )}
                  {!isOwner && canManageAdmins && isAdmin && (
                    <button
                      onClick={() => onSetRole(m.userId, 'member')}
                      disabled={busy}
                      className="flex items-center gap-1 px-2 py-1 rounded-md text-[12px] text-white/50 hover:bg-white/10 disabled:opacity-40"
                      title="撤销产品管理员"
                    >
                      <ShieldOff size={13} /> 取消管理员
                    </button>
                  )}
                  {canRemove && (
                    <button
                      onClick={() => onRemove(m.userId)}
                      disabled={busy}
                      className="flex items-center gap-1 px-2 py-1 rounded-md text-[12px] text-red-300/70 hover:bg-red-500/15 disabled:opacity-40"
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
                <span className="text-sm text-white/85 truncate">{m.displayName}</span>
                <span className={`shrink-0 px-1.5 py-0.5 rounded text-[11px] border ${ROLE_BADGE[m.role]}`}>
                  {ROLE_LABEL[m.role]}
                </span>
              </div>
            </SelectableRow>
          );
        })}
      </div>
      {members.length <= 1 && (
        <p className="text-[12px] text-white/30">
          目前只有负责人。{canManageMembers ? '通过上方搜索框添加协作成员。' : ''}
        </p>
      )}
    </div>
  );
}
