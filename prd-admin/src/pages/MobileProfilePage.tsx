import { useNavigate } from 'react-router-dom';
import {
  Palette,
  Bell,
  ScrollText,
  GraduationCap,
  FolderOpen,
  LogOut,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react';
import { useMemo } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { resolveAvatarUrl } from '@/lib/avatar';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { iconFor } from '@/lib/agentAccent';
import { buildStaticInfra, deriveLauncherPerms } from '@/lib/homeLauncherItems';
import { AS_COLOR, AS_FONT_FAMILY } from '@/lib/appStoreTokens';
import { useAppStoreColors } from '@/hooks/useAppStoreColors';

/** 平台能力图标的轮转配色（iOS 系统色，视觉有层次但不刺眼） */
const INFRA_COLORS = [
  AS_COLOR.blue, AS_COLOR.green, AS_COLOR.orange, AS_COLOR.purple,
  AS_COLOR.teal, AS_COLOR.indigo, AS_COLOR.pink, AS_COLOR.yellow,
];

/* ── 菜单项 ── */
interface MenuItem {
  key: string;
  label: string;
  desc?: string;
  icon: LucideIcon;
  color: string;
  path?: string;
  action?: () => void;
}

/* ── 固定菜单：只保留用户真正需要的功能 ── */
const MENU_ITEMS: MenuItem[] = [
  { key: 'assets', label: '我的资产', desc: '图片、文档、附件、网页产出物', icon: FolderOpen, color: AS_COLOR.orange, path: '/my-assets' },
  { key: 'learn',  label: '学习中心', desc: '全部教程与新手引导',    icon: GraduationCap, color: AS_COLOR.blue, path: '/learning-center' },
  { key: 'theme',  label: '主题设置', desc: '皮肤、配色、玻璃效果',  icon: Palette,    color: AS_COLOR.indigo, path: '/settings?tab=skin' },
  { key: 'notify', label: '系统通知', desc: '查看与处理系统消息',    icon: Bell,       color: AS_COLOR.orange, path: '/notifications' },
  { key: 'logs',   label: '请求日志', desc: '查看 LLM 调用记录',     icon: ScrollText, color: AS_COLOR.green, path: '/logs' },
];

/**
 * 移动端「我的」个人中心页 —— App Store 设计系统（纯黑/白双皮肤 + iOS 系统色 + SF）。
 *
 * 精简原则：只放用户级功能（主题/通知/日志），
 * 管理功能（权限/资源/数据/导航顺序）保留在左上角抽屉导航中。
 */
export default function MobileProfilePage() {
  const C = useAppStoreColors();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const isRoot = useAuthStore((s) => s.isRoot);
  const permissions = useAuthStore((s) => s.permissions ?? []);

  // 平台能力快捷入口（知识库置首）—— 与首页、桌面同一数据源
  const infra = useMemo(() => buildStaticInfra(deriveLauncherPerms(permissions)), [permissions]);

  const avatarUrl = user ? resolveAvatarUrl(user) : null;

  const roleLabel = (() => {
    if (isRoot) return '超级管理员';
    switch (user?.role) {
      case 'ADMIN': return '管理员';
      case 'PM': return '产品经理';
      case 'DEV': return '开发者';
      case 'QA': return '测试';
      default: return user?.role ?? '用户';
    }
  })();

  const handleLogout = () => {
    logout();
    navigate('/home', { replace: true });
  };

  // 分组卡：白卡（浅）/ 悬浮灰（暗），iOS grouped 观感
  const cardStyle = { background: C.card, border: `1px solid ${C.hairline}` } as const;

  return (
    <div
      className="h-full min-h-0 overflow-auto"
      style={{ background: C.bg, fontFamily: AS_FONT_FAMILY }}
    >
      <div className="px-5 pt-8 pb-28">

        {/* ── 用户卡片 ── */}
        <div className="flex items-center gap-4 p-5 rounded-2xl mb-6" style={cardStyle}>
          {avatarUrl ? (
            <UserAvatar src={avatarUrl} className="w-14 h-14 rounded-full object-cover" />
          ) : (
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center text-lg font-semibold"
              style={{ background: C.surface, color: C.label }}
            >
              {(user?.displayName || user?.username || '?')[0]}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-lg font-semibold truncate" style={{ color: C.label }}>
              {user?.displayName || user?.username}
            </div>
            <div
              className="inline-block mt-1 px-2 py-0.5 rounded-md text-[11px] font-medium"
              style={{ background: `${C.indigo}26`, color: C.indigo }}
            >
              {roleLabel}
            </div>
          </div>
        </div>

        {/* ── 平台能力（知识库等基础设施快捷入口，与首页/桌面同源） ── */}
        {infra.length > 0 && (
          <div className="rounded-2xl overflow-hidden mb-6" style={cardStyle}>
            <div
              className="px-4 pt-3.5 pb-1.5 text-[11px] font-semibold tracking-wide"
              style={{ color: C.labelTertiary }}
            >
              平台能力
            </div>
            {infra.map((it, i) => {
              const InfraIcon = iconFor(it.icon);
              const color = INFRA_COLORS[i % INFRA_COLORS.length];
              return (
                <button
                  key={it.id}
                  onClick={() => it.routePath && navigate(it.routePath)}
                  className="w-full flex items-center gap-3 px-4 py-3.5 text-left transition-opacity active:opacity-60"
                  style={{ borderBottom: i < infra.length - 1 ? `1px solid ${C.separator}` : 'none' }}
                >
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                    style={{ background: `${color}26` }}
                  >
                    <InfraIcon size={16} style={{ color }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm" style={{ color: C.label }}>
                      {it.name}
                    </div>
                    <div className="text-[11px] mt-0.5 truncate" style={{ color: C.labelSecondary }}>
                      {it.description}
                    </div>
                  </div>
                  <ChevronRight size={16} style={{ color: C.labelTertiary }} />
                </button>
              );
            })}
          </div>
        )}

        {/* ── 菜单列表 ── */}
        <div className="rounded-2xl overflow-hidden mb-6" style={cardStyle}>
          {MENU_ITEMS.map((item, i) => {
            const MenuIcon = item.icon;
            return (
              <button
                key={item.key}
                onClick={() => item.path ? navigate(item.path) : item.action?.()}
                className="w-full flex items-center gap-3 px-4 py-3.5 text-left transition-opacity active:opacity-60"
                style={{
                  borderBottom: i < MENU_ITEMS.length - 1 ? `1px solid ${C.separator}` : 'none',
                }}
              >
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: `${item.color}26` }}
                >
                  <MenuIcon size={16} style={{ color: item.color }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm" style={{ color: C.label }}>
                    {item.label}
                  </div>
                  {item.desc && (
                    <div className="text-[11px] mt-0.5" style={{ color: C.labelSecondary }}>
                      {item.desc}
                    </div>
                  )}
                </div>
                <ChevronRight size={16} style={{ color: C.labelTertiary }} />
              </button>
            );
          })}
        </div>

        {/* ── 退出登录 ── */}
        <button
          onClick={handleLogout}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl transition-transform active:scale-[0.98]"
          style={{
            background: `${C.red}14`,
            border: `1px solid ${C.red}26`,
            color: C.red,
          }}
        >
          <LogOut size={16} />
          <span className="text-sm font-medium">退出登录</span>
        </button>
      </div>
    </div>
  );
}
