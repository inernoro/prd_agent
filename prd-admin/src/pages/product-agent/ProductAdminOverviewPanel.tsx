/**
 * 各产品负责人 / 产品管理员一览（只读）。
 * 展示在「应用 → 应用配置」的「产品管理员」标签；指派操作在单产品「团队」tab。
 */
import { useCallback, useEffect, useState } from 'react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { listProductMembers, listProducts } from '@/services/real/productAgent';

export function ProductAdminOverviewPanel() {
  const [rows, setRows] = useState<Array<{ productId: string; productName: string; admins: string[] }>>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    const productsResult = await listProducts({ pageSize: 200 });
    if (!productsResult.success) {
      setMessage(productsResult.error?.message ?? '产品列表加载失败');
      setLoading(false);
      return;
    }
    const nextRows = await Promise.all(productsResult.data.items.map(async (product) => {
      const memberResult = await listProductMembers(product.id);
      const admins = memberResult.success
        ? memberResult.data.members
          .filter((member) => member.role === 'owner' || member.role === 'admin')
          .map((member) => member.displayName)
        : [];
      return { productId: product.id, productName: product.name, admins };
    }));
    setRows(nextRows);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading) return <MapSectionLoader text="正在加载产品管理员…" />;

  return (
    <div className="overflow-hidden rounded-xl border border-white/10">
      <div className="border-b border-white/10 px-4 py-3">
        <div className="text-sm font-medium text-white/75">产品管理员</div>
        <div className="mt-1 text-xs leading-5 text-white/40">
          各产品负责人与产品管理员一览；在单产品页「团队」tab 指派或撤销。
        </div>
        {message && <div className="mt-2 text-xs text-white/50">{message}</div>}
      </div>
      <table className="w-full text-left text-sm">
        <thead className="bg-white/[0.03] text-xs text-white/45">
          <tr>
            <th className="px-4 py-2.5 font-medium">产品</th>
            <th className="px-4 py-2.5 font-medium">管理员</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.productId} className="border-t border-white/5">
              <td className="px-4 py-3 text-white/80">{row.productName}</td>
              <td className="px-4 py-3 text-xs text-white/55">{row.admins.length > 0 ? row.admins.join('；') : '未配置'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
