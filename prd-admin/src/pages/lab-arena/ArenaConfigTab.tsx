import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Edit3, Plus, Trash2, Power } from 'lucide-react';

import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { ConfirmTip } from '@/components/ui/ConfirmTip';
import { PrdLoader } from '@/components/ui/PrdLoader';
import { ArenaModelPickerDialog } from '@/components/model/ArenaModelPickerDialog';
import { ModelReferenceStatus } from '@/components/model/ModelReferenceStatus';
import type { ArenaSlot, ArenaGroup } from '@/services/contracts/arena';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/cn';
import type { Platform } from '@/types/admin';
import {
  listArenaGroups,
  createArenaGroup,
  updateArenaGroup,
  deleteArenaGroup,
  updateArenaSlot,
  deleteArenaSlot,
  toggleArenaSlot,
  getPlatforms,
} from '@/services';

// ── Types ──

// ── Form state types ──

interface GroupForm {
  key: string;
  name: string;
  description: string;
  sortOrder: number;
}

const EMPTY_GROUP_FORM: GroupForm = { key: '', name: '', description: '', sortOrder: 0 };

// ── Component ──

export default function ArenaConfigTab() {
  // ── Data state ──
  const [groups, setGroups] = useState<ArenaGroup[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [loading, setLoading] = useState(true);

  // ── Expand state ──
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // ── Group dialog state ──
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupForm, setGroupForm] = useState<GroupForm>(EMPTY_GROUP_FORM);
  const [groupSaving, setGroupSaving] = useState(false);

  // ── Model picker state (for batch-adding slots) ──
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelPickerTargetGroup, setModelPickerTargetGroup] = useState('');
  const [repairingSlot, setRepairingSlot] = useState<ArenaSlot | null>(null);

  // ── Slot edit dialog state ──
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingSlot, setEditingSlot] = useState<ArenaSlot | null>(null);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  // ── Platform name lookup ──
  const platformMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of platforms) map.set(p.id, p.name);
    return map;
  }, [platforms]);

  // ── Load data ──
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [groupsRes, platformsRes] = await Promise.all([
        listArenaGroups(),
        getPlatforms(),
      ]);
      if (groupsRes.success && groupsRes.data?.items) {
        const items = groupsRes.data.items as ArenaGroup[];
        setGroups(items);
        setExpandedGroups((prev) => {
          const next = new Set(prev);
          for (const g of items) {
            if (!next.has(g.id)) next.add(g.id);
          }
          return next;
        });
      }
      if (platformsRes.success) {
        setPlatforms((platformsRes.data as Platform[]) ?? []);
      }
    } catch {
      toast.error('加载 Arena 配置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ── Toggle group expand ──
  const toggleExpand = useCallback((groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  // ── Group CRUD ──
  const openCreateGroup = useCallback(() => {
    setEditingGroupId(null);
    setGroupForm(EMPTY_GROUP_FORM);
    setGroupDialogOpen(true);
  }, []);

  const openEditGroup = useCallback((group: ArenaGroup) => {
    setEditingGroupId(group.id);
    setGroupForm({
      key: group.key,
      name: group.name,
      description: group.description ?? '',
      sortOrder: group.sortOrder ?? 0,
    });
    setGroupDialogOpen(true);
  }, []);

  const handleSaveGroup = useCallback(async () => {
    if (!groupForm.name.trim()) {
      toast.warning('请填写分组名称');
      return;
    }
    if (!editingGroupId && !groupForm.key.trim()) {
      toast.warning('请填写分组 Key');
      return;
    }

    setGroupSaving(true);
    try {
      if (editingGroupId) {
        const res = await updateArenaGroup(editingGroupId, {
          name: groupForm.name.trim(),
          description: groupForm.description.trim() || undefined,
          sortOrder: groupForm.sortOrder,
        });
        if (!res.success) throw new Error(res.error?.message || '更新失败');
        toast.success('分组已更新');
      } else {
        const res = await createArenaGroup({
          key: groupForm.key.trim(),
          name: groupForm.name.trim(),
          description: groupForm.description.trim() || undefined,
          sortOrder: groupForm.sortOrder,
        });
        if (!res.success) throw new Error(res.error?.message || '创建失败');
        toast.success('分组已创建');
      }
      setGroupDialogOpen(false);
      await fetchData();
    } catch (err: any) {
      toast.error(editingGroupId ? '更新分组失败' : '创建分组失败', err?.message);
    } finally {
      setGroupSaving(false);
    }
  }, [editingGroupId, groupForm, fetchData]);

  const handleDeleteGroup = useCallback(async (groupId: string) => {
    try {
      const res = await deleteArenaGroup(groupId);
      if (!res.success) throw new Error(res.error?.message || '删除失败');
      toast.success('分组已删除');
      await fetchData();
    } catch (err: any) {
      toast.error('删除分组失败', err?.message);
    }
  }, [fetchData]);

  // ── Slot: open model picker for batch-adding ──
  const openAddSlots = useCallback((groupKey: string) => {
    setModelPickerTargetGroup(groupKey);
    setRepairingSlot(null);
    setModelPickerOpen(true);
  }, []);

  // ── Slot edit ──
  const openEditSlot = useCallback((slot: ArenaSlot) => {
    setEditingSlot(slot);
    setEditDisplayName(slot.displayName);
    setEditDialogOpen(true);
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!editingSlot) return;
    if (!editDisplayName.trim()) {
      toast.warning('请填写显示名称');
      return;
    }

    setEditSaving(true);
    try {
      const res = await updateArenaSlot(editingSlot.id, {
        displayName: editDisplayName.trim(),
      });
      if (!res.success) throw new Error(res.error?.message || '更新失败');
      toast.success('槽位已更新');
      setEditDialogOpen(false);
      await fetchData();
    } catch (err: any) {
      toast.error('更新槽位失败', err?.message);
    } finally {
      setEditSaving(false);
    }
  }, [editingSlot, editDisplayName, fetchData]);

  // ── Slot delete & toggle ──
  const handleDeleteSlot = useCallback(async (slotId: string) => {
    try {
      const res = await deleteArenaSlot(slotId);
      if (!res.success) throw new Error(res.error?.message || '删除失败');
      toast.success('槽位已删除');
      await fetchData();
    } catch (err: any) {
      toast.error('删除槽位失败', err?.message);
    }
  }, [fetchData]);

  const handleToggleSlot = useCallback(async (slotId: string) => {
    try {
      const res = await toggleArenaSlot(slotId);
      if (!res.success) throw new Error(res.error?.message || '切换失败');
      await fetchData();
    } catch (err: any) {
      toast.error('切换槽位状态失败', err?.message);
    }
  }, [fetchData]);

  // ── Loading state ──
  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <PrdLoader size={36} />
      </div>
    );
  }

  // ── Render ──
  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
            Arena 分组 & 槽位管理
          </h2>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
            管理 Arena 对战中可用的模型分组和槽位配置
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={openCreateGroup}>
          <Plus size={14} />
          新建分组
        </Button>
      </div>

      {/* Groups */}
      {groups.length === 0 ? (
        <GlassCard>
          <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>
            <p className="text-sm">暂无分组，点击"新建分组"开始配置</p>
          </div>
        </GlassCard>
      ) : (
        groups.map((group) => {
          const isExpanded = expandedGroups.has(group.id);
          return (
            <GlassCard key={group.id} padding="none">
              {/* Group header */}
              <div
                className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
                style={{ borderBottom: isExpanded ? '1px solid var(--border-default)' : 'none' }}
                onClick={() => toggleExpand(group.id)}
              >
                <span style={{ color: 'var(--text-secondary)' }}>
                  {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                      {group.name}
                    </span>
                    <span
                      className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-token-nested"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {group.key}
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      ({group.slots.length} 个槽位)
                    </span>
                  </div>
                  {group.description && (
                    <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
                      {group.description}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  <Button variant="ghost" size="xs" onClick={() => openAddSlots(group.key)} title="添加槽位">
                    <Plus size={14} />
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => openEditGroup(group)} title="编辑分组">
                    <Edit3 size={14} />
                  </Button>
                  <ConfirmTip
                    title="确认删除该分组？"
                    description="删除后该分组下的所有槽位也会被清除，此操作不可恢复。"
                    onConfirm={() => handleDeleteGroup(group.id)}
                  >
                    <Button variant="ghost" size="xs" title="删除分组">
                      <Trash2 size={14} />
                    </Button>
                  </ConfirmTip>
                </div>
              </div>

              {/* Slot cards grid */}
              {isExpanded && (
                <div className="p-4">
                  {group.slots.length === 0 ? (
                    <div className="text-center py-6" style={{ color: 'var(--text-muted)' }}>
                      <p className="text-xs">暂无槽位</p>
                      <Button
                        variant="secondary"
                        size="xs"
                        className="mt-2"
                        onClick={() => openAddSlots(group.key)}
                      >
                        <Plus size={12} />
                        添加模型
                      </Button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                      {group.slots.map((slot) => (
                        <SlotCard
                          key={slot.id}
                          slot={slot}
                          platformName={platformMap.get(slot.platformId)}
                          onEdit={() => openEditSlot(slot)}
                          onRepair={() => { setRepairingSlot(slot); setModelPickerTargetGroup(group.key); setModelPickerOpen(true); }}
                          onDelete={() => handleDeleteSlot(slot.id)}
                          onToggle={() => handleToggleSlot(slot.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </GlassCard>
          );
        })
      )}

      {/* Tip */}
      <div
        className="text-xs px-4 py-3 rounded-xl bg-token-nested"
        style={{ color: 'var(--text-muted)', border: '1px solid var(--border-default)' }}
      >
        提示：用户在 /arena 页面对战时，模型名称以匿名方式展示（助手 A / B / C ...），用户手动点击后才揭晓真实身份。
      </div>

      {/* ── Group Dialog ── */}
      <Dialog
        open={groupDialogOpen}
        onOpenChange={setGroupDialogOpen}
        title={editingGroupId ? '编辑分组' : '新建分组'}
        content={
          <div className="space-y-4 pt-1">
            {/* Key (create only) */}
            {!editingGroupId && (
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                  Key <span style={{ color: 'rgba(239,68,68,0.8)' }}>*</span>
                </label>
                <input
                  className="w-full px-3 py-2 rounded-[12px] text-sm outline-none prd-field font-mono"
                  placeholder="例如: general-chat"
                  value={groupForm.key}
                  onChange={(e) => setGroupForm((f) => ({ ...f, key: e.target.value }))}
                />
                <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  唯一标识，创建后不可修改，建议使用 kebab-case
                </p>
              </div>
            )}

            {/* Name */}
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                名称 <span style={{ color: 'rgba(239,68,68,0.8)' }}>*</span>
              </label>
              <input
                className="w-full px-3 py-2 rounded-[12px] text-sm outline-none prd-field"
                placeholder="例如: 通用对话"
                value={groupForm.name}
                onChange={(e) => setGroupForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                描述
              </label>
              <input
                className="w-full px-3 py-2 rounded-[12px] text-sm outline-none prd-field"
                placeholder="可选描述信息"
                value={groupForm.description}
                onChange={(e) => setGroupForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>

            {/* SortOrder */}
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                排序
              </label>
              <input
                type="number"
                className="w-full px-3 py-2 rounded-[12px] text-sm outline-none prd-field"
                value={groupForm.sortOrder}
                onChange={(e) => setGroupForm((f) => ({ ...f, sortOrder: Number(e.target.value) || 0 }))}
              />
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" size="sm" onClick={() => setGroupDialogOpen(false)}>
                取消
              </Button>
              <Button variant="primary" size="sm" onClick={handleSaveGroup} disabled={groupSaving}>
                {groupSaving ? '保存中...' : editingGroupId ? '保存' : '创建'}
              </Button>
            </div>
          </div>
        }
      />

      {/* ── Model Picker Dialog (batch add slots) ── */}
      <ArenaModelPickerDialog open={modelPickerOpen} onOpenChange={setModelPickerOpen}
        group={groups.find(group => group.key === modelPickerTargetGroup)} repairingSlot={repairingSlot} onSaved={fetchData} />

      {/* ── Slot Edit Dialog ── */}
      <Dialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        title="编辑槽位"
        content={
          editingSlot && (
            <div className="space-y-4 pt-1">
              {/* Read-only: platform + model */}
              <div
                className="rounded-[12px] px-3 py-2.5 text-sm bg-token-nested"
                style={{ border: '1px solid var(--border-subtle)' }}
              >
                <div style={{ color: 'var(--text-secondary)' }}>
                  {editingSlot.logicalModelId ? '授权模型' : platformMap.get(editingSlot.platformId) || editingSlot.platformId}
                </div>
                <div className="font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  {editingSlot.modelId}
                </div>
              </div>

              {/* Display Name */}
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                  显示名称
                </label>
                <input
                  className="w-full px-3 py-2 rounded-[12px] text-sm outline-none prd-field"
                  value={editDisplayName}
                  onChange={(e) => setEditDisplayName(e.target.value)}
                />
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="secondary" size="sm" onClick={() => setEditDialogOpen(false)}>
                  取消
                </Button>
                <Button variant="primary" size="sm" onClick={handleSaveEdit} disabled={editSaving}>
                  {editSaving ? '保存中...' : '保存'}
                </Button>
              </div>
            </div>
          )
        }
      />
    </div>
  );
}

// ── SlotCard sub-component ──

function SlotCard({
  slot,
  platformName,
  onEdit,
  onDelete,
  onToggle,
  onRepair,
}: {
  slot: ArenaSlot;
  platformName?: string;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  onRepair: () => void;
}) {
  return (
    <GlassCard
      variant="subtle"
      padding="sm"
      className={cn(
        'group transition-opacity duration-200',
        !slot.enabled && 'opacity-50',
      )}
    >
      {/* Name */}
      <div
        className="text-sm font-semibold truncate mb-1.5"
        style={{ color: 'var(--text-primary)' }}
        title={slot.displayName}
      >
        {slot.displayName}
      </div>

      {/* Platform */}
      <div className="text-[11px] mb-0.5" style={{ color: 'var(--text-secondary)' }}>
        {slot.logicalModelId ? '授权模型' : platformName || slot.platformId}
      </div>

      {/* Model ID */}
      <div
        className="text-[11px] font-mono truncate mb-3"
        style={{ color: 'var(--text-muted)' }}
        title={slot.modelId}
      >
        {slot.modelId}
      </div>

      <ModelReferenceStatus reference={slot} />
      {slot.modelReferenceStatus !== 'available' ? <Button variant="ghost" size="xs" onClick={onRepair}>修复模型引用</Button> : null}

      {/* Actions row */}
      <div className="flex items-center justify-between">
        {/* Enabled toggle */}
        <button
          type="button"
          className={cn(
            'flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg transition-colors',
            slot.enabled
              ? 'text-emerald-400 hover:bg-emerald-500/10'
              : 'hover-bg-soft',
          )}
          style={{ color: slot.enabled ? undefined : 'var(--text-muted)' }}
          onClick={onToggle}
          title={slot.enabled ? '点击禁用' : '点击启用'}
        >
          <Power size={12} />
          <span>{slot.enabled ? '已启用' : '已禁用'}</span>
        </button>

        {/* Edit + Delete */}
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button variant="ghost" size="xs" onClick={onEdit} title="编辑">
            <Edit3 size={13} />
          </Button>
          <ConfirmTip
            title="确认删除该槽位？"
            description="此操作不可恢复。"
            onConfirm={onDelete}
          >
            <Button variant="ghost" size="xs" title="删除">
              <Trash2 size={13} />
            </Button>
          </ConfirmTip>
        </div>
      </div>
    </GlassCard>
  );
}
