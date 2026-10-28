import { useRef, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { updateRelease, type ReleaseBasicUpdate } from '@/services/real/productAgent';
import type { ProductRelease } from '@/pages/product-agent/types';

type Props = { release: ProductRelease; userNames?: ReadonlyMap<string, string>; onSaved: (release: ProductRelease) => void | Promise<void> };
const TEXT_FIELDS = [
  { key: 'demandSource', label: '需求来源' }, { key: 'departmentName', label: '所属部门' },
  { key: 'planUrl', label: '方案地址' }, { key: 'contractParty', label: '合同签订方' },
  { key: 'openBrandScope', label: '当前开放品牌' },
] as const;
const dateValue = (value?: string | null) => value?.slice(0, 10) ?? '';

export function ReleaseEditAction({ release, userNames, onSaved }: Props) {
  const [editing, setEditing] = useState<ProductRelease | null>(null);
  return <span onClick={(event) => event.stopPropagation()}>
    <button type="button" className="text-token-secondary hover:underline" onClick={() => setEditing(release)}>编辑</button>
    {editing && <ReleaseEditor release={editing} userNames={userNames} onSaved={onSaved} onClose={() => setEditing(null)} />}
  </span>;
}

function ReleaseEditor({ release, userNames, onSaved, onClose }: Props & { onClose: () => void }) {
  const initial = {
    planName: release.planName, ownerId: release.ownerId ?? '',
    demandSource: release.demandSource ?? '', departmentName: release.departmentName ?? '',
    planUrl: release.planUrl ?? '', contractParty: release.contractParty ?? '',
    openBrandScope: release.openBrandScope ?? '', requirementDescription: release.requirementDescription ?? '', remark: release.remark ?? '',
    plannedReleaseAt: dateValue(release.plannedReleaseAt), releasedAt: dateValue(release.releasedAt),
    plannedTrainingMinutes: release.plannedTrainingMinutes == null ? '' : String(release.plannedTrainingMinutes),
    isGlobalOpen: release.isGlobalOpen == null ? '' : release.isGlobalOpen ? 'yes' : 'no',
  };
  const [draft, setDraft] = useState(initial);
  const [teamIds, setTeamIds] = useState(release.teamMemberIds);
  const [names, setNames] = useState(() => new Map(userNames));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const change = (key: keyof typeof draft, value: string) => setDraft((previous) => ({ ...previous, [key]: value }));
  const dirty = Object.keys(initial).some((key) => draft[key as keyof typeof draft] !== initial[key as keyof typeof initial])
    || JSON.stringify(teamIds) !== JSON.stringify(release.teamMemberIds);
  const save = async () => {
    if (submitting.current || !dirty) return;
    if (!draft.planName.trim()) { setError('方案名称不能为空。'); return; }
    const body: ReleaseBasicUpdate = { expectedUpdatedAt: release.updatedAt };
    for (const key of ['planName', 'ownerId', 'demandSource', 'departmentName', 'planUrl', 'contractParty', 'openBrandScope', 'requirementDescription', 'remark'] as const)
      if (draft[key] !== initial[key]) body[key] = draft[key].trim();
    if (body.ownerId === '') { setError('请选择有效的产品负责人。'); return; }
    for (const key of ['plannedReleaseAt', 'releasedAt'] as const) {
      if (draft[key] === initial[key]) continue;
      if (!draft[key]) { setError('上线日期不能清空，请选择有效日期。'); return; }
      body[key] = `${draft[key]}T00:00:00Z`;
    }
    if (draft.plannedTrainingMinutes !== initial.plannedTrainingMinutes) {
      const value = Number(draft.plannedTrainingMinutes);
      if (!draft.plannedTrainingMinutes.trim() || !Number.isInteger(value) || value < 0 || value > 2147483647) {
        setError('预计培训时长须为非负整数分钟。'); return;
      }
      body.plannedTrainingMinutes = value;
    }
    if (draft.isGlobalOpen !== initial.isGlobalOpen) {
      if (!draft.isGlobalOpen) { setError('请选择是否全域开放。'); return; }
      body.isGlobalOpen = draft.isGlobalOpen === 'yes';
    }
    if (JSON.stringify(teamIds) !== JSON.stringify(release.teamMemberIds)) {
      if (!teamIds.length) { setError('请至少选择一位项目组成员。'); return; }
      body.teamMemberIds = teamIds;
    }
    submitting.current = true; setBusy(true); setError('');
    try {
      const result = await updateRelease(release.id, body);
      if (!result.success) { setError(result.error?.message ?? '保存未成功，请稍后重试。'); return; }
      onClose(); await onSaved(result.data);
    } catch { setError('保存结果暂未确认，请刷新原记录核对后重试。'); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <Dialog open onOpenChange={(value) => { if (!value && !submitting.current) onClose(); }} title="编辑正式版本资料" maxWidth={720}
    description={`${release.vCode}${release.tCode ? ` · ${release.tCode}` : ''}；保存资料不改变版本号或关联立项，也不会重新推送通知。`}
    content={<fieldset disabled={busy} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <label className="space-y-1 text-xs text-token-secondary sm:col-span-2">产品立项方案名称 *<input value={draft.planName} onChange={(event) => change('planName', event.target.value)} className={inputClass} /></label>
      <div role="group" aria-label="产品负责人" className="space-y-1"><p className="text-xs text-token-secondary">产品负责人</p>
        <UserSearchSelect value={draft.ownerId} onChange={(id) => change('ownerId', id)} selectedUser={draft.ownerId === release.ownerId && release.ownerName ? { userId: draft.ownerId, username: '', displayName: release.ownerName } : undefined} placeholder="搜索并选择产品负责人" />
      </div>
      {TEXT_FIELDS.map(({ key, label }) => <label key={key} className="space-y-1 text-xs text-token-secondary">{label}<input value={draft[key]} onChange={(event) => change(key, event.target.value)} className={inputClass} /></label>)}
      <label className="space-y-1 text-xs text-token-secondary">计划上线日期<input type="date" value={draft.plannedReleaseAt} onChange={(event) => change('plannedReleaseAt', event.target.value)} className={inputClass} /></label>
      {release.status === 'released' && <label className="space-y-1 text-xs text-token-secondary">实际上线日期<input type="date" value={draft.releasedAt} onChange={(event) => change('releasedAt', event.target.value)} className={inputClass} /></label>}
      {release.projectType !== 'custom' && draft.isGlobalOpen === 'yes' && <label className="space-y-1 text-xs text-token-secondary">预计培训时长（分钟）<input type="number" min={0} max={2147483647} step={1} value={draft.plannedTrainingMinutes} onChange={(event) => change('plannedTrainingMinutes', event.target.value)} className={inputClass} /></label>}
      <label className="space-y-1 text-xs text-token-secondary">是否全域开放<select value={draft.isGlobalOpen} onChange={(event) => change('isGlobalOpen', event.target.value)} className={inputClass}><option value="">请选择</option><option value="yes">是</option><option value="no">否</option></select></label>
      <div role="group" aria-label="项目组成员" className="space-y-2 sm:col-span-2"><p className="text-xs text-token-secondary">项目组成员</p>
        <div className="flex flex-wrap gap-2">{teamIds.map((id) => <button type="button" key={id} aria-label={`移除成员 ${names.get(id) ?? id}`} onClick={() => setTeamIds((previous) => previous.filter((value) => value !== id))} className="rounded border border-token-subtle px-2 py-1 text-xs text-token-secondary">{names.get(id) ?? id} ×</button>)}</div>
        <UserSearchSelect value="" onChange={(id) => { if (id) setTeamIds((previous) => [...new Set([...previous, id])]); }} onSelectUser={(user) => setNames((previous) => new Map(previous).set(user.userId, user.displayName || user.username))} placeholder="添加项目组成员" />
      </div>
      {(['requirementDescription', 'remark'] as const).map((key) => <label key={key} className="space-y-1 text-xs text-token-secondary sm:col-span-2">{key === 'remark' ? '备注' : '项目需求描述'}<textarea rows={2} value={draft[key]} onChange={(event) => change(key, event.target.value)} className={inputClass} /></label>)}
      {error && <p role="alert" className="text-sm text-token-secondary sm:col-span-2">{error}</p>}
    </fieldset>}
    actions={<><Button size="sm" disabled={busy} onClick={onClose}>取消</Button><Button size="sm" disabled={busy || !dirty} onClick={() => void save()}>{busy ? '正在保存…' : '保存修改'}</Button></>} />;
}

const inputClass = 'block w-full rounded-md border border-token-subtle bg-token-nested px-3 py-2 text-sm text-token-primary';
