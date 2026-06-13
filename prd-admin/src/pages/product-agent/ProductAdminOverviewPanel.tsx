/**
 * 各产品负责人 / 产品管理员管理（可编辑）。
 * 展示在「应用 → 应用配置」的「产品管理员」标签：每个产品一行，
 * 负责人(owner) 带皇冠不可删；产品管理员(admin) 以标签展示，可快速撤销，
 * 支持内联搜索用户「设为管理员」，允许多位。指派权限不足的产品仅只读。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Crown, Plus, ShieldOff, X } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { toast } from '@/lib/toast';
import {
  addProductMembers,
  listProductMembers,
  listProducts,
  setProductMemberRole,
} from '@/services/real/productAgent';
import type { ProductMember } from './types';

interface AdminRow {
  productId: string;
  productName: string;
  members: ProductMember[];
  canManageAdmins: boolean;
}

export function ProductAdminOverviewPanel() {
  const [rows, setRows] = useState<AdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [pickUserId, setPickUserId] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    const productsResult = await listProducts({ pageSize: 200 });
    if (!productsResult.success) {
      setMessage(productsResult.error?.message ?? '产品列表加载失败');
      setLoading(false);
      return;
    }
    const nextRows = await Promise.all(
      productsResult.data.items.map(async (product): Promise<AdminRow> => {
        const memberResult = await listProductMembers(product.id);
        return {
          productId: product.id,
          productName: product.name,
          members: memberResult.success ? memberResult.data.members : [],
          canManageAdmins: memberResult.success ? memberResult.data.canManageAdmins : false,
        };
      }),
    );
    setRows(nextRows);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const reloadProduct = useCallback(async (productId: string) => {
    const memberResult = await listProductMembers(productId);
    if (!memberResult.success) return;
    setRows((prev) =>
      prev.map((row) =>
        row.productId === productId
          ? { ...row, members: memberResult.data.members, canManageAdmins: memberResult.data.canManageAdmins }
          : row,
      ),
    );
  }, []);

  const assignAdmin = async (productId: string, userId: string) => {
    if (!userId) return;
    setBusyKey(productId);
    const added = await addProductMembers(productId, [userId]);
    if (!added.success) {
      setBusyKey(null);
      toast.error(added.error?.message ?? '添加成员失败');
      return;
    }
    const roleRes = await setProductMemberRole(productId, userId, 'admin');
    setBusyKey(null);
    if (!roleRes.success) {
      toast.error(roleRes.error?.message ?? '设为管理员失败');
      return;
    }
    setAddingFor(null);
    setPickUserId('');
    toast.success('已设为产品管理员');
    await reloadProduct(productId);
  };

  const revokeAdmin = async (productId: string, userId: string) => {
    setBusyKey(`${productId}:${userId}`);
    const res = await setProductMemberRole(productId, userId, 'member');
    setBusyKey(null);
    if (!res.success) {
      toast.error(res.error?.message ?? '撤销管理员失败');
      return;
    }
    toast.success('已撤销产品管理员');
    await reloadProduct(productId);
  };

  if (loading) return <MapSectionLoader text="正在加载产品管理员…" />;

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
        <div className="text-sm font-medium text-white/75">产品管理员</div>
        <div className="mt-1 text-xs leading-5 text-white/40">
          管理各产品的负责人与产品管理员。负责人带皇冠不可在此移除；产品管理员可多位，支持快速增删。无指派权限的产品仅展示名单。
        </div>
        {message && <div className="mt-2 text-xs text-rose-300/80">{message}</div>}
      </div>

      <div className="overflow-hidden rounded-xl border border-white/10">
        <div className="grid grid-cols-[minmax(140px,1fr)_minmax(0,2.4fr)] bg-white/[0.03] text-xs text-white/45">
          <div className="px-4 py-2.5 font-medium">产品</div>
          <div className="px-4 py-2.5 font-medium">管理员</div>
        </div>
        {rows.map((row) => (
          <ProductAdminRow
            key={row.productId}
            row={row}
            busyKey={busyKey}
            isAdding={addingFor === row.productId}
            pickUserId={addingFor === row.productId ? pickUserId : ''}
            onPick={setPickUserId}
            onToggleAdd={() => {
              setAddingFor((prev) => (prev === row.productId ? null : row.productId));
              setPickUserId('');
            }}
            onAssign={(userId) => void assignAdmin(row.productId, userId)}
            onRevoke={(userId) => void revokeAdmin(row.productId, userId)}
          />
        ))}
        {rows.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-white/35">暂无产品。</div>
        )}
      </div>
    </div>
  );
}

function ProductAdminRow({
  row,
  busyKey,
  isAdding,
  pickUserId,
  onPick,
  onToggleAdd,
  onAssign,
  onRevoke,
}: {
  row: AdminRow;
  busyKey: string | null;
  isAdding: boolean;
  pickUserId: string;
  onPick: (userId: string) => void;
  onToggleAdd: () => void;
  onAssign: (userId: string) => void;
  onRevoke: (userId: string) => void;
}) {
  const owners = useMemo(() => row.members.filter((m) => m.role === 'owner'), [row.members]);
  const admins = useMemo(() => row.members.filter((m) => m.role === 'admin'), [row.members]);
  const rowBusy = busyKey === row.productId;

  return (
    <div className="grid grid-cols-[minmax(140px,1fr)_minmax(0,2.4fr)] border-t border-white/5">
      <div className="px-4 py-3 text-sm text-white/80">{row.productName}</div>
      <div className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {owners.map((m) => (
            <span
              key={m.userId}
              className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/12 px-2 py-0.5 text-[11px] text-amber-200"
              title="负责人（在单产品「团队」tab 变更）"
            >
              <Crown size={11} /> {m.displayName}
            </span>
          ))}
          {admins.map((m) => {
            const chipBusy = busyKey === `${row.productId}:${m.userId}`;
            return (
              <span
                key={m.userId}
                className="inline-flex items-center gap-1 rounded-full border border-purple-500/30 bg-purple-500/12 px-2 py-0.5 text-[11px] text-purple-200"
              >
                {m.displayName}
                {row.canManageAdmins && (
                  <button
                    type="button"
                    onClick={() => onRevoke(m.userId)}
                    disabled={chipBusy}
                    className="ml-0.5 rounded-full p-0.5 text-purple-200/70 hover:bg-purple-500/25 hover:text-purple-100 disabled:opacity-40"
                    title="撤销产品管理员"
                  >
                    {chipBusy ? <MapSpinner size={11} /> : <X size={11} />}
                  </button>
                )}
              </span>
            );
          })}
          {owners.length === 0 && admins.length === 0 && (
            <span className="text-[11px] text-white/35">未配置</span>
          )}
          {row.canManageAdmins && !isAdding && (
            <button
              type="button"
              onClick={onToggleAdd}
              className="inline-flex items-center gap-1 rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-white/55 hover:bg-white/5 hover:text-white/80"
            >
              <Plus size={11} /> 添加管理员
            </button>
          )}
          {!row.canManageAdmins && (
            <span className="inline-flex items-center gap-1 text-[10px] text-white/30" title="需负责人或 MAP 管理员">
              <ShieldOff size={11} /> 无指派权限
            </span>
          )}
        </div>

        {row.canManageAdmins && isAdding && (
          <div className="mt-2 flex items-center gap-2">
            <div className="min-w-0 flex-1 max-w-sm">
              <UserSearchSelect
                value={pickUserId}
                onChange={onPick}
                placeholder="搜索用户昵称 / 用户名，设为管理员"
                uiSize="sm"
                showAllOption={false}
              />
            </div>
            <button
              type="button"
              onClick={() => onAssign(pickUserId)}
              disabled={!pickUserId || rowBusy}
              className="flex items-center gap-1 rounded-lg border border-purple-500/30 bg-purple-500/15 px-2.5 py-1.5 text-xs text-purple-200 hover:bg-purple-500/25 disabled:opacity-40"
            >
              {rowBusy ? <MapSpinner size={13} /> : <Plus size={13} />} 设为管理员
            </button>
            <button
              type="button"
              onClick={onToggleAdd}
              className="rounded-lg px-2 py-1.5 text-xs text-white/45 hover:bg-white/5 hover:text-white/70"
            >
              取消
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
