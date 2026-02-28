import { useMemo, useState } from 'react';
import {
  LayoutDashboard,
  Users,
  Users2,
  Cpu,
  FileText,
  MessagesSquare,
  Wand2,
  PenLine,
  Image,
  ScrollText,
  Database,
  Plug,
  UserCog,
  FlaskConical,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { menuList, type MenuDef } from '@/lib/authzMenuMapping';
import type { SystemRoleDto } from '@/services/contracts/authz';
import { PermissionCell } from './PermissionCell';
import { PermissionPopover } from './PermissionPopover';

// 图标映射
const iconMap: Record<string, LucideIcon> = {
  LayoutDashboard,
  Users,
  Users2,
  Cpu,
  FileText,
  MessagesSquare,
  Wand2,
  PenLine,
  Image,
  ScrollText,
  Database,
  Plug,
  UserCog,
  FlaskConical,
  Settings,
};

interface PermissionMatrixProps {
  roles: SystemRoleDto[];
  highlightRoleKey?: string | null;
  onUpdateRole: (roleKey: string, permissions: string[]) => Promise<void>;
  onDeleteRole: (roleKey: string) => void;
  onMenuClick?: (menuAppKey: string) => void;
  loading?: boolean;
  saving?: boolean;
  readOnly?: boolean;
}

export function PermissionMatrix({
  roles,
  highlightRoleKey,
  onUpdateRole,
  onDeleteRole,
  onMenuClick,
  loading,
  saving,
  readOnly,
}: PermissionMatrixProps) {
  // 当前编辑的单元格 { roleKey, menuAppKey }
  const [editingCell, setEditingCell] = useState<{ roleKey: string; menuAppKey: string } | null>(null);
  // 当前悬停的行
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);

  // 计算单元格状态：完全访问 / 部分访问 / 无权限
  const getCellStatus = (role: SystemRoleDto, menu: MenuDef): 'full' | 'partial' | 'none' => {
    const rolePerms = new Set(role.permissions || []);
    const menuPerms = menu.permissions;

    if (menuPerms.length === 0) return 'none';

    const hasCount = menuPerms.filter((p) => rolePerms.has(p)).length;

    if (hasCount === 0) return 'none';
    if (hasCount === menuPerms.length) return 'full';
    return 'partial';
  };

  // 获取角色在某菜单下的已有权限
  const getRoleMenuPermissions = (role: SystemRoleDto, menu: MenuDef): string[] => {
    const rolePerms = new Set(role.permissions || []);
    return menu.permissions.filter((p) => rolePerms.has(p));
  };

  // 当前编辑的角色和菜单
  const editingRole = useMemo(
    () => (editingCell ? roles.find((r) => r.key === editingCell.roleKey) : null),
    [editingCell, roles]
  );

  const editingMenu = useMemo(
    () => (editingCell ? menuList.find((m) => m.appKey === editingCell.menuAppKey) : null),
    [editingCell]
  );

  // 处理权限保存
  const handleSavePermissions = async (roleKey: string, menuAppKey: string, newMenuPerms: string[]) => {
    const role = roles.find((r) => r.key === roleKey);
    const menu = menuList.find((m) => m.appKey === menuAppKey);
    if (!role || !menu) return;

    // 计算新的完整权限列表
    const currentPerms = new Set(role.permissions || []);

    // 移除该菜单的所有权限
    for (const p of menu.permissions) {
      currentPerms.delete(p);
    }

    // 添加新勾选的权限
    for (const p of newMenuPerms) {
      currentPerms.add(p);
    }

    await onUpdateRole(roleKey, Array.from(currentPerms).sort());
    setEditingCell(null);
  };

  const handleCellClick = (roleKey: string, menuAppKey: string) => {
    if (readOnly || loading) return;
    const role = roles.find((r) => r.key === roleKey);
    if (role?.isBuiltIn) return; // 内置角色不可编辑
    setEditingCell({ roleKey, menuAppKey });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
          加载中...
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden rounded-2xl">
      {/* 表格区域 */}
      <div className="flex-1 min-h-0 overflow-auto rounded-t-2xl">
      <table className="w-full border-collapse text-sm">
        {/* 表头：角色列 */}
        <thead>
          <tr>
            {/* 空白角落 */}
            <th
              className="sticky left-0 z-20 p-3 text-left"
              style={{
                background: 'var(--bg-card)',
                width: 168,
                minWidth: 168,
                maxWidth: 168,
                borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
              }}
            >
              <span
                className="text-[11px] font-medium px-2 py-1 rounded-md"
                style={{
                  color: 'var(--text-muted)',
                  background: 'var(--nested-block-bg)',
                }}
              >
                菜单 / 角色
              </span>
            </th>

            {/* 角色列头 */}
            {roles.map((role) => (
              <th
                key={role.key}
                className="p-2.5 text-center font-medium whitespace-nowrap"
                style={{
                  background:
                    highlightRoleKey === role.key
                      ? 'rgba(99, 102, 241, 0.12)'
                      : role.isBuiltIn
                        ? 'var(--bg-card, rgba(255, 255, 255, 0.03))'
                        : 'transparent',
                  color: highlightRoleKey === role.key ? 'rgba(99, 102, 241, 0.95)' : 'var(--text-primary)',
                  minWidth: 88,
                  borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                }}
              >
                <div className="flex flex-col items-center gap-1">
                  <div
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg"
                    style={{
                      background: role.isBuiltIn ? 'rgba(99, 102, 241, 0.08)' : 'var(--bg-input)',
                    }}
                  >
                    {role.isBuiltIn && <ShieldCheck size={11} style={{ color: 'rgba(99, 102, 241, 0.7)' }} />}
                    <span className="text-[12px] font-semibold">{role.name}</span>
                  </div>
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded-md"
                    style={{
                      color: 'var(--text-muted)',
                      background: 'var(--nested-block-bg)',
                    }}
                  >
                    {role.permissions?.length || 0} 项
                  </span>
                </div>
              </th>
            ))}
          </tr>
        </thead>

        {/* 表体：菜单行 */}
        <tbody>
          {menuList.map((menu) => {
            const Icon = iconMap[menu.icon] || LayoutDashboard;

            return (
              <tr
                key={menu.appKey}
                className="transition-colors duration-150"
                onMouseEnter={() => setHoveredRow(menu.appKey)}
                onMouseLeave={() => setHoveredRow(null)}
                style={{
                  background: hoveredRow === menu.appKey ? 'var(--bg-input)' : 'transparent',
                }}
              >
                {/* 菜单行头 - 可点击查看权限详情 */}
                <td
                  className="sticky left-0 z-10 px-3 py-2 transition-all duration-250 ease-out"
                  style={{
                    background: hoveredRow === menu.appKey ? 'rgba(38, 38, 44, 0.98)' : 'var(--bg-card)',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.03)',
                    borderRight: hoveredRow === menu.appKey ? '2px solid rgba(99, 102, 241, 0.35)' : '1px solid transparent',
                    width: 168,
                    minWidth: 168,
                    maxWidth: 168,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onMenuClick?.(menu.appKey)}
                    className="flex items-center gap-2.5 w-full transition-all duration-250 ease-out"
                    title="点击查看权限详情"
                  >
                    <div
                      className="w-8 h-8 rounded-[10px] flex items-center justify-center transition-all duration-250 ease-out shrink-0"
                      style={{
                        background: hoveredRow === menu.appKey ? 'rgba(99, 102, 241, 0.18)' : 'var(--bg-card-hover)',
                        transform: hoveredRow === menu.appKey ? 'scale(1.08)' : 'scale(1)',
                        boxShadow: hoveredRow === menu.appKey ? '0 4px 16px rgba(99, 102, 241, 0.25)' : '0 2px 8px rgba(0, 0, 0, 0.1)',
                        border: hoveredRow === menu.appKey ? '1px solid rgba(99, 102, 241, 0.25)' : '1px solid var(--nested-block-border)',
                      }}
                    >
                      <Icon
                        size={16}
                        style={{
                          color: hoveredRow === menu.appKey ? 'rgba(99, 102, 241, 1)' : 'var(--text-muted)',
                          transition: 'color 0.25s ease-out',
                        }}
                      />
                    </div>
                    <span
                      className="transition-all duration-250 ease-out text-[13px] truncate"
                      style={{
                        color: hoveredRow === menu.appKey ? 'rgba(255, 255, 255, 1)' : 'var(--text-secondary)',
                        fontWeight: hoveredRow === menu.appKey ? 500 : 400,
                        letterSpacing: hoveredRow === menu.appKey ? '0.01em' : '0',
                      }}
                    >
                      {menu.label}
                    </span>
                  </button>
                </td>

                {/* 权限单元格 */}
                {roles.map((role) => {
                  const status = getCellStatus(role, menu);
                  const isHighlighted = highlightRoleKey === role.key;
                  const isEditing = editingCell?.roleKey === role.key && editingCell?.menuAppKey === menu.appKey;
                  const isRowHovered = hoveredRow === menu.appKey;

                  return (
                    <td
                      key={`${role.key}-${menu.appKey}`}
                      className="p-1 text-center transition-colors duration-150"
                      style={{
                        background: isHighlighted
                          ? 'rgba(99, 102, 241, 0.08)'
                          : isRowHovered
                            ? 'var(--nested-block-bg)'
                            : 'transparent',
                        borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
                      }}
                    >
                      <PermissionCell
                        status={status}
                        isBuiltIn={role.isBuiltIn}
                        isHighlighted={isHighlighted}
                        isEditing={isEditing}
                        isRowHovered={isRowHovered}
                        onClick={() => handleCellClick(role.key, menu.appKey)}
                        disabled={readOnly || role.isBuiltIn}
                      />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>

      {/* 底部图例 */}
      <div
        className="shrink-0 flex items-center gap-6 px-5 py-3 text-xs rounded-b-2xl"
        style={{
          color: 'var(--text-muted)',
          background: 'linear-gradient(180deg, rgba(0, 0, 0, 0.15) 0%, rgba(0, 0, 0, 0.25) 100%)',
          borderTop: '1px solid rgba(255, 255, 255, 0.04)',
        }}
      >
        <span className="flex items-center gap-2">
          <span
            className="w-5 h-5 rounded-md flex items-center justify-center"
            style={{ background: 'rgba(99, 102, 241, 0.1)' }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="5" stroke="rgba(99, 102, 241, 0.8)" strokeWidth="1.5" />
              <circle cx="8" cy="8" r="2.5" fill="rgba(99, 102, 241, 0.8)" />
            </svg>
          </span>
          <span style={{ color: 'var(--text-secondary)' }}>完全访问</span>
        </span>
        <span className="flex items-center gap-2">
          <span
            className="w-5 h-5 rounded-md flex items-center justify-center"
            style={{ background: 'rgba(99, 102, 241, 0.06)' }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="5" stroke="rgba(99, 102, 241, 0.5)" strokeWidth="1.5" />
              <circle cx="8" cy="8" r="1.5" fill="rgba(99, 102, 241, 0.5)" />
            </svg>
          </span>
          <span style={{ color: 'var(--text-secondary)' }}>部分访问</span>
        </span>
        <span className="flex items-center gap-2">
          <span
            className="w-5 h-5 rounded-md flex items-center justify-center"
            style={{ background: 'var(--nested-block-bg)' }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="5" stroke="rgba(255, 255, 255, 0.25)" strokeWidth="1.5" />
              <line x1="4.5" y1="11.5" x2="11.5" y2="4.5" stroke="rgba(255, 255, 255, 0.25)" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </span>
          <span>无权限</span>
        </span>
        <span className="opacity-40 ml-auto text-[11px]">点击菜单名称查看权限详情，点击单元格编辑权限</span>
      </div>

      {/* 权限编辑 Popover */}
      {editingCell && editingRole && editingMenu && (
        <PermissionPopover
          open={!!editingCell}
          onOpenChange={(open) => {
            if (!open) setEditingCell(null);
          }}
          roleName={editingRole.name}
          menuLabel={editingMenu.label}
          menuPermissions={editingMenu.permissions}
          currentPermissions={getRoleMenuPermissions(editingRole, editingMenu)}
          onSave={(perms) => handleSavePermissions(editingCell.roleKey, editingCell.menuAppKey, perms)}
          onDelete={!editingRole.isBuiltIn ? () => onDeleteRole(editingRole.key) : undefined}
          saving={saving}
          isBuiltIn={editingRole.isBuiltIn}
        />
      )}
    </div>
  );
}
