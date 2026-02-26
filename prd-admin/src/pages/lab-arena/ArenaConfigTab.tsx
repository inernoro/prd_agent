import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Edit3, Plus, Trash2, Power } from 'lucide-react';

import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { ConfirmTip } from '@/components/ui/ConfirmTip';
import { PrdLoader } from '@/components/ui/PrdLoader';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/cn';
import {
  listArenaGroups,
  createArenaGroup,
  updateArenaGroup,
  deleteArenaGroup,
  createArenaSlot,
  updateArenaSlot,
  deleteArenaSlot,
  toggleArenaSlot,
  getPlatforms,
} from '@/services';

// ── Types ──

interface ArenaSlot {
  id: string;
  displayName: string;
  platformId: string;
  modelId: string;
  group: string;
  sortOrder: number;
  enabled: boolean;
  avatarColor?: string;
  description?: string;
}

interface ArenaGroup {
  id: string;
  key: string;
  name: string;
  description?: string;
  icon?: string;
  sortOrder: number;
  slots: ArenaSlot[];
}

interface PlatformItem {
  id: string;
  name: string;
}

// ── Form state types ──

interface GroupForm {
  key: string;
  name: string;
  description: string;
  sortOrder: number;
}

interface SlotForm {
  displayName: string;
  platformId: string;
  modelId: string;
  avatarColor: string;
  description: string;
  sortOrder: number;
  enabled: boolean;
}

const EMPTY_GROUP_FORM: GroupForm = { key: '', name: '', description: '', sortOrder: 0 };
const EMPTY_SLOT_FORM: SlotForm = { displayName: '', platformId: '', modelId: '', avatarColor: '', description: '', sortOrder: 0, enabled: true };

// ── Component ──

export default function ArenaConfigTab() {
  // ── Data state ──
  const [groups, setGroups] = useState<ArenaGroup[]>([]);
  const [platforms, setPlatforms] = useState<PlatformItem[]>([]);
  const [loading, setLoading] = useState(true);

  // ── Expand state ──
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // ── Group dialog state ──
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupForm, setGroupForm] = useState<GroupForm>(EMPTY_GROUP_FORM);
  const [groupSaving, setGroupSaving] = useState(false);

  // ── Slot dialog state ──
  const [slotDialogOpen, setSlotDialogOpen] = useState(false);
  const [editingSlotId, setEditingSlotId] = useState<string | null>(null);
  const [slotTargetGroup, setSlotTargetGroup] = useState<string>('');
  const [slotForm, setSlotForm] = useState<SlotForm>(EMPTY_SLOT_FORM);
  const [slotSaving, setSlotSaving] = useState(false);

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
        // Default: all expanded
        setExpandedGroups((prev) => {
          const next = new Set(prev);
          for (const g of items) {
            if (!next.has(g.id)) next.add(g.id);
          }
          return next;
        });
      }
      if (platformsRes.success && platformsRes.data?.items) {
        setPlatforms(platformsRes.data.items as PlatformItem[]);
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
      sortOrder: group.sortOrder,
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
        if (!res.success) throw new Error(res.message || '更新失败');
        toast.success('分组已更新');
      } else {
        const res = await createArenaGroup({
          key: groupForm.key.trim(),
          name: groupForm.name.trim(),
          description: groupForm.description.trim() || undefined,
          sortOrder: groupForm.sortOrder,
        });
        if (!res.success) throw new Error(res.message || '创建失败');
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
      if (!res.success) throw new Error(res.message || '删除失败');
      toast.success('分组已删除');
      await fetchData();
    } catch (err: any) {
      toast.error('删除分组失败', err?.message);
    }
  }, [fetchData]);

  // ── Slot CRUD ──
  const openCreateSlot = useCallback((groupKey: string) => {
    setEditingSlotId(null);
    setSlotTargetGroup(groupKey);
    setSlotForm({ ...EMPTY_SLOT_FORM, platformId: platforms[0]?.id ?? '' });
    setSlotDialogOpen(true);
  }, [platforms]);

  const openEditSlot = useCallback((slot: ArenaSlot) => {
    setEditingSlotId(slot.id);
    setSlotTargetGroup(slot.group);
    setSlotForm({
      displayName: slot.displayName,
      platformId: slot.platformId,
      modelId: slot.modelId,
      avatarColor: slot.avatarColor ?? '',
      description: slot.description ?? '',
      sortOrder: slot.sortOrder,
      enabled: slot.enabled,
    });
    setSlotDialogOpen(true);
  }, []);

  const handleSaveSlot = useCallback(async () => {
    if (!slotForm.displayName.trim()) {
      toast.warning('请填写显示名称');
      return;
    }
    if (!slotForm.platformId) {
      toast.warning('请选择平台');
      return;
    }
    if (!slotForm.modelId.trim()) {
      toast.warning('请填写模型 ID');
      return;
    }

    setSlotSaving(true);
    try {
      if (editingSlotId) {
        const res = await updateArenaSlot(editingSlotId, {
          displayName: slotForm.displayName.trim(),
          platformId: slotForm.platformId,
          modelId: slotForm.modelId.trim(),
          sortOrder: slotForm.sortOrder,
          avatarColor: slotForm.avatarColor.trim() || undefined,
          description: slotForm.description.trim() || undefined,
        });
        if (!res.success) throw new Error(res.message || '更新失败');
        toast.success('槽位已更新');
      } else {
        const res = await createArenaSlot({
          displayName: slotForm.displayName.trim(),
          platformId: slotForm.platformId,
          modelId: slotForm.modelId.trim(),
          group: slotTargetGroup,
          sortOrder: slotForm.sortOrder,
          enabled: slotForm.enabled,
          avatarColor: slotForm.avatarColor.trim() || undefined,
          description: slotForm.description.trim() || undefined,
        });
        if (!res.success) throw new Error(res.message || '创建失败');
        toast.success('槽位已创建');
      }
      setSlotDialogOpen(false);
      await fetchData();
    } catch (err: any) {
      toast.error(editingSlotId ? '更新槽位失败' : '创建槽位失败', err?.message);
    } finally {
      setSlotSaving(false);
    }
  }, [editingSlotId, slotForm, slotTargetGroup, fetchData]);

  const handleDeleteSlot = useCallback(async (slotId: string) => {
    try {
      const res = await deleteArenaSlot(slotId);
      if (!res.success) throw new Error(res.message || '删除失败');
      toast.success('槽位已删除');
      await fetchData();
    } catch (err: any) {
      toast.error('删除槽位失败', err?.message);
    }
  }, [fetchData]);

  const handleToggleSlot = useCallback(async (slotId: string) => {
    try {
      const res = await toggleArenaSlot(slotId);
      if (!res.success) throw new Error(res.message || '切换失败');
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
                      className="text-[11px] font-mono px-1.5 py-0.5 rounded"
                      style={{
                        color: 'var(--text-muted)',
                        background: 'rgba(255,255,255,0.05)',
                      }}
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
                  <Button variant="ghost" size="xs" onClick={() => openCreateSlot(group.key)} title="添加槽位">
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
                        onClick={() => openCreateSlot(group.key)}
                      >
                        <Plus size={12} />
                        添加
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
        className="text-xs px-4 py-3 rounded-xl"
        style={{
          color: 'var(--text-muted)',
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid var(--border-default)',
        }}
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

      {/* ── Slot Dialog ── */}
      <Dialog
        open={slotDialogOpen}
        onOpenChange={setSlotDialogOpen}
        title={editingSlotId ? '编辑槽位' : '添加槽位'}
        content={
          <div className="space-y-4 pt-1">
            {/* Display Name */}
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                显示名称 <span style={{ color: 'rgba(239,68,68,0.8)' }}>*</span>
              </label>
              <input
                className="w-full px-3 py-2 rounded-[12px] text-sm outline-none prd-field"
                placeholder="例如: GPT-4o"
                value={slotForm.displayName}
                onChange={(e) => setSlotForm((f) => ({ ...f, displayName: e.target.value }))}
              />
            </div>

            {/* Platform + Model row */}
            <div className="grid grid-cols-2 gap-3">
              {/* Platform */}
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                  平台 <span style={{ color: 'rgba(239,68,68,0.8)' }}>*</span>
                </label>
                <select
                  className="w-full px-3 py-2 rounded-[12px] text-sm outline-none prd-field"
                  value={slotForm.platformId}
                  onChange={(e) => setSlotForm((f) => ({ ...f, platformId: e.target.value }))}
                >
                  <option value="">-- 选择平台 --</option>
                  {platforms.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Model ID */}
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                  模型 ID <span style={{ color: 'rgba(239,68,68,0.8)' }}>*</span>
                </label>
                <input
                  className="w-full px-3 py-2 rounded-[12px] text-sm outline-none prd-field font-mono"
                  placeholder="例如: gpt-4o"
                  value={slotForm.modelId}
                  onChange={(e) => setSlotForm((f) => ({ ...f, modelId: e.target.value }))}
                />
              </div>
            </div>

            {/* Avatar Color */}
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                头像颜色
              </label>
              <div className="flex items-center gap-2">
                <input
                  className="flex-1 px-3 py-2 rounded-[12px] text-sm outline-none prd-field"
                  placeholder="例如: #6366f1 或 rgb(99,102,241)"
                  value={slotForm.avatarColor}
                  onChange={(e) => setSlotForm((f) => ({ ...f, avatarColor: e.target.value }))}
                />
                {slotForm.avatarColor && (
                  <div
                    className="w-8 h-8 rounded-lg shrink-0"
                    style={{
                      background: slotForm.avatarColor,
                      border: '1px solid var(--border-default)',
                    }}
                    title={slotForm.avatarColor}
                  />
                )}
              </div>
            </div>

            {/* Description */}
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                描述
              </label>
              <input
                className="w-full px-3 py-2 rounded-[12px] text-sm outline-none prd-field"
                placeholder="可选描述信息"
                value={slotForm.description}
                onChange={(e) => setSlotForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>

            {/* Sort order */}
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                排序
              </label>
              <input
                type="number"
                className="w-full px-3 py-2 rounded-[12px] text-sm outline-none prd-field"
                value={slotForm.sortOrder}
                onChange={(e) => setSlotForm((f) => ({ ...f, sortOrder: Number(e.target.value) || 0 }))}
              />
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" size="sm" onClick={() => setSlotDialogOpen(false)}>
                取消
              </Button>
              <Button variant="primary" size="sm" onClick={handleSaveSlot} disabled={slotSaving}>
                {slotSaving ? '保存中...' : editingSlotId ? '保存' : '创建'}
              </Button>
            </div>
          </div>
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
}: {
  slot: ArenaSlot;
  platformName?: string;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
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
      {/* Header: color dot + name */}
      <div className="flex items-center gap-2 mb-2">
        <div
          className="w-3 h-3 rounded-full shrink-0"
          style={{
            background: slot.avatarColor || 'var(--text-muted)',
            boxShadow: slot.avatarColor
              ? `0 0 6px ${slot.avatarColor}40`
              : 'none',
          }}
        />
        <span
          className="text-sm font-semibold truncate"
          style={{ color: 'var(--text-primary)' }}
          title={slot.displayName}
        >
          {slot.displayName}
        </span>
      </div>

      {/* Platform */}
      <div className="text-[11px] mb-1" style={{ color: 'var(--text-secondary)' }}>
        {platformName || slot.platformId}
      </div>

      {/* Model ID */}
      <div
        className="text-[11px] font-mono truncate mb-3"
        style={{ color: 'var(--text-muted)' }}
        title={slot.modelId}
      >
        {slot.modelId}
      </div>

      {/* Description */}
      {slot.description && (
        <div
          className="text-[11px] truncate mb-2"
          style={{ color: 'var(--text-muted)' }}
          title={slot.description}
        >
          {slot.description}
        </div>
      )}

      {/* Actions row */}
      <div className="flex items-center justify-between">
        {/* Enabled toggle */}
        <button
          type="button"
          className={cn(
            'flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg transition-colors',
            slot.enabled
              ? 'text-emerald-400 hover:bg-emerald-500/10'
              : 'hover:bg-white/5',
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
