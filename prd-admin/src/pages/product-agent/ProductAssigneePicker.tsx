import { useEffect, useMemo, useState } from 'react';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import {
  listProductApplicationAdmins,
  listProductMembers,
  type ProductApplicationAdmin,
} from '@/services/real/productAgent';
import type { ProductMember } from './types';

type QuickAssignee = {
  userId: string;
  displayName: string;
  tag: 'owner' | 'admin' | 'app-admin';
};

const TAG_LABEL: Record<QuickAssignee['tag'], string> = {
  owner: '负责人',
  admin: '产品管理员',
  'app-admin': '应用管理员',
};

const TAG_CLASS: Record<QuickAssignee['tag'], string> = {
  owner: 'border-amber-400/35 bg-amber-400/12 text-amber-200',
  admin: 'border-violet-400/35 bg-violet-400/12 text-violet-200',
  'app-admin': 'border-cyan-400/35 bg-cyan-400/12 text-cyan-200',
};

export function ProductAssigneePicker({
  productId,
  value,
  onChange,
  placeholder = '搜索用户名或昵称...',
  uiSize = 'md',
}: {
  productId: string;
  value: string;
  onChange: (userId: string) => void;
  placeholder?: string;
  uiSize?: 'sm' | 'md';
}) {
  const [members, setMembers] = useState<ProductMember[]>([]);
  const [appAdmins, setAppAdmins] = useState<ProductApplicationAdmin[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!productId) return;
    void Promise.all([
      listProductMembers(productId),
      listProductApplicationAdmins(),
    ]).then(([memberRes, appRes]) => {
      if (cancelled) return;
      if (memberRes.success) setMembers(memberRes.data.members);
      if (appRes.success) setAppAdmins(appRes.data.items);
    });
    return () => {
      cancelled = true;
    };
  }, [productId]);

  const quickAssignees = useMemo<QuickAssignee[]>(() => {
    const picked = new Map<string, QuickAssignee>();
    for (const item of members) {
      if (item.role !== 'owner' && item.role !== 'admin') continue;
      picked.set(item.userId, {
        userId: item.userId,
        displayName: item.displayName,
        tag: item.role,
      });
    }
    for (const item of appAdmins) {
      if (picked.has(item.userId)) continue;
      picked.set(item.userId, {
        userId: item.userId,
        displayName: item.displayName,
        tag: 'app-admin',
      });
    }
    return [...picked.values()];
  }, [appAdmins, members]);

  const appAdminText = useMemo(() => {
    const names = appAdmins.map((item) => item.displayName).filter(Boolean);
    return names.join('；');
  }, [appAdmins]);

  return (
    <div className="flex flex-col gap-1.5">
      {quickAssignees.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {quickAssignees.map((item) => (
            <button
              key={item.userId}
              type="button"
              onClick={() => onChange(item.userId)}
              className={`rounded-full border px-2 py-0.5 text-[11px] transition hover:opacity-90 ${TAG_CLASS[item.tag]} ${
                value === item.userId ? 'ring-1 ring-white/35' : ''
              }`}
              title={`${TAG_LABEL[item.tag]} · ${item.displayName}`}
            >
              {item.displayName}
            </button>
          ))}
        </div>
      )}
      {appAdminText && (
        <div className="text-[10px] text-white/35">应用管理员：{appAdminText}</div>
      )}
      <UserSearchSelect
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        uiSize={uiSize}
      />
    </div>
  );
}
