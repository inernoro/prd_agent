import { useMemo } from 'react';
import { LogicalModelPickerDialog } from './LogicalModelPickerDialog';
import type { ArenaGroup, ArenaSlot } from '@/services/contracts/arena';
import type { LogicalModelOption } from '@/services/contracts/modelReferences';
import { createArenaSlot, getArenaModelOptions, updateArenaSlot } from '@/services';

/** 添加与原位修复共用一条逻辑身份写入路径，不删除重建已有槽位。 */
export function ArenaModelPickerDialog({ open, onOpenChange, group, repairingSlot, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group?: ArenaGroup;
  repairingSlot?: ArenaSlot | null;
  onSaved: () => void | Promise<void>;
}) {
  const selected = useMemo(() => repairingSlot?.logicalModelId ? [repairingSlot.logicalModelId] : [], [repairingSlot?.logicalModelId]);

  async function save(models: LogicalModelOption[]) {
    if (repairingSlot) {
      const result = await updateArenaSlot(repairingSlot.id, { logicalModelId: models[0].logicalModelId });
      if (!result.success) throw new Error(result.error?.message || '模型引用未修复，请重试。');
      await onSaved();
      return;
    }
    if (!group) throw new Error('阵容已变化，请关闭后重新打开。');
    const additions = models.filter(model => !group.slots.some(slot => slot.logicalModelId === model.logicalModelId));
    let failed = 0;
    for (const model of additions) {
      try {
        const result = await createArenaSlot({ group: group.key, logicalModelId: model.logicalModelId, displayName: model.name, enabled: true });
        if (!result.success) failed++;
      } catch { failed++; }
    }
    await onSaved();
    if (failed) throw new Error(`${failed} 个模型未添加，请核对阵容后重试。已添加的模型会保留。`);
  }

  return <LogicalModelPickerDialog open={open} onOpenChange={onOpenChange} loadOptions={getArenaModelOptions} selectedModelIds={selected} single={!!repairingSlot}
    title={repairingSlot ? '修复模型引用' : '添加竞技场模型'}
    description={repairingSlot ? `为「${repairingSlot.displayName || '当前槽位'}」明确选择模型，保留原槽位、名称和顺序。` : '选择已授权模型加入阵容。已有模型会保留，不会自动更换。'}
    confirmText={repairingSlot ? '保存模型引用' : '确认添加'} onConfirm={save} />;
}
