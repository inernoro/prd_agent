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
  Grid3X3,
} from 'lucide-react';
import { menuList, canAccessMenu } from '@/lib/authzMenuMapping';

const iconMap: Record<string, React.ReactNode> = {
  LayoutDashboard: <LayoutDashboard size={14} />,
  Users: <Users size={14} />,
  Users2: <Users2 size={14} />,
  Cpu: <Cpu size={14} />,
  FileText: <FileText size={14} />,
  MessagesSquare: <MessagesSquare size={14} />,
  Wand2: <Wand2 size={14} />,
  PenLine: <PenLine size={14} />,
  Image: <Image size={14} />,
  ScrollText: <ScrollText size={14} />,
  Database: <Database size={14} />,
  Plug: <Plug size={14} />,
  UserCog: <UserCog size={14} />,
  FlaskConical: <FlaskConical size={14} />,
};

interface AuthzMenuColumnProps {
  activeAppKey: string | null;
  onSelect: (appKey: string | null) => void;
  rolePermissions: string[]; // 当前选中角色的权限，用于高亮可访问的菜单
  loading?: boolean;
}

export function AuthzMenuColumn({ activeAppKey, onSelect, rolePermissions, loading }: AuthzMenuColumnProps) {
  const isAllSelected = activeAppKey === null;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-white/5">
        <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          菜单
        </div>
      </div>

      {/* 全部按钮 */}
      <div className="px-2 py-2">
        <button
          type="button"
          className="w-full text-left rounded-xl px-3 py-2.5 transition-all duration-200"
          style={{
            background: isAllSelected
              ? 'linear-gradient(135deg, rgba(214, 178, 106, 0.15) 0%, rgba(214, 178, 106, 0.08) 100%)'
              : 'transparent',
            border: isAllSelected ? '1px solid rgba(214, 178, 106, 0.3)' : '1px solid transparent',
          }}
          onClick={() => onSelect(null)}
        >
          <div className="flex items-center gap-2">
            <span
              className="shrink-0 inline-flex items-center justify-center rounded-lg w-7 h-7"
              style={{
                background: isAllSelected ? 'var(--gold-gradient)' : 'rgba(255,255,255,0.06)',
                color: isAllSelected ? '#1a1206' : 'var(--text-secondary)',
              }}
            >
              <Grid3X3 size={14} />
            </span>
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              全部
            </span>
          </div>
        </button>
      </div>

      {/* 菜单列表 */}
      <div className="flex-1 min-h-0 overflow-auto px-2 pb-2">
        <div className="flex flex-col gap-1">
          {menuList.map((menu) => {
            const isActive = menu.appKey === activeAppKey;
            const canAccess = canAccessMenu(rolePermissions, menu.appKey);
            const icon = iconMap[menu.icon] || <FileText size={14} />;

            return (
              <button
                key={menu.appKey}
                type="button"
                className="w-full text-left rounded-xl px-3 py-2.5 transition-all duration-200 hover:bg-white/4"
                style={{
                  background: isActive
                    ? 'linear-gradient(135deg, rgba(214, 178, 106, 0.12) 0%, rgba(214, 178, 106, 0.06) 100%)'
                    : 'transparent',
                  border: isActive ? '1px solid rgba(214, 178, 106, 0.25)' : '1px solid transparent',
                  opacity: canAccess ? 1 : 0.5,
                }}
                onClick={() => onSelect(menu.appKey)}
                disabled={loading}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="shrink-0 inline-flex items-center justify-center rounded-lg w-7 h-7"
                    style={{
                      background: canAccess ? 'rgba(214, 178, 106, 0.15)' : 'rgba(255,255,255,0.06)',
                      color: canAccess ? 'rgba(214, 178, 106, 0.9)' : 'var(--text-muted)',
                    }}
                  >
                    {icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div
                      className="text-sm font-medium truncate"
                      style={{ color: canAccess ? 'var(--text-primary)' : 'var(--text-muted)' }}
                    >
                      {menu.label}
                    </div>
                  </div>
                  {canAccess && (
                    <span
                      className="shrink-0 w-1.5 h-1.5 rounded-full"
                      style={{ background: 'rgba(214, 178, 106, 0.8)' }}
                    />
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
