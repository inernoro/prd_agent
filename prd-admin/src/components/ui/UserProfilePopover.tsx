import { useState, useRef, useEffect, useCallback } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { glassPanel } from '@/lib/glassStyles';
import { getUserProfile, getUserAuthz, getSystemRoles } from '@/services';
import type { UserProfileResponse } from '@/services/contracts/adminUsers';
import type { AdminUserAuthzSnapshot, SystemRoleDto } from '@/services/contracts/authz';
import { resolveAvatarUrl, resolveNoHeadAvatarUrl } from '@/lib/avatar';
import { Users2, Zap, Clock, Image, Eye, ChevronDown, ChevronUp, Shield, Pencil, Bug, Palette, BookOpen, FileText, LayoutDashboard, Settings, Database, ScrollText, Store, Droplets, Type, ImageIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';

type UserProfilePopoverProps = {
  userId: string;
  username: string;
  userType?: string;
  botKind?: string;
  avatarFileName?: string | null;
  avatarUrl?: string | null;
  role?: 'PM' | 'DEV' | 'QA' | 'ADMIN' | string;
  onChangeAvatar?: () => void;
  children: React.ReactNode;
};

// Agent 名称映射
const agentLabels: Record<string, string> = {
  'prd-agent': 'PRD Agent',
  'visual-agent': '视觉创作',
  'literary-agent': '文学创作',
  'defect-agent': '缺陷管理',
  dashboard: '仪表盘',
  users: '用户管理',
  groups: '群组管理',
  mds: '模型管理',
  logs: '日志',
  settings: '设置',
};

// Agent 图标映射
const agentIcons: Record<string, React.ReactNode> = {
  'prd-agent': <FileText size={10} />,
  'visual-agent': <Palette size={10} />,
  'literary-agent': <BookOpen size={10} />,
  'defect-agent': <Bug size={10} />,
  dashboard: <LayoutDashboard size={10} />,
  users: <Users2 size={10} />,
  groups: <Users2 size={10} />,
  mds: <Database size={10} />,
  logs: <ScrollText size={10} />,
  settings: <Settings size={10} />,
};

// 角色图标配置
const roleIconConfig: Record<string, { bg: string; color: string; label: string; icon: React.ReactNode }> = {
  PM: {
    bg: 'rgba(59,130,246,0.9)',
    color: '#fff',
    label: '产品经理',
    icon: <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>,
  },
  DEV: {
    bg: 'rgba(34,197,94,0.9)',
    color: '#fff',
    label: '开发',
    icon: <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6" /></svg>,
  },
  QA: {
    bg: 'rgba(168,85,247,0.9)',
    color: '#fff',
    label: '测试',
    icon: <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" /></svg>,
  },
  ADMIN: {
    bg: 'rgba(99,102,241,0.95)',
    color: '#000',
    label: '管理员',
    icon: <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 2l7 4v6c0 5-3 9-7 10-4-1-7-5-7-10V6l7-4z" /></svg>,
  },
};

function formatRelativeTime(v?: string | null) {
  if (!v) return '';
  const d = new Date(v);
  const t = d.getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const abs = Math.abs(diff);

  const sec = Math.floor(abs / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);

  const suffix = diff >= 0 ? '前' : '后';
  if (sec < 60) return `${sec} 秒${suffix}`;
  if (min < 60) return `${min} 分钟${suffix}`;
  if (hr < 24) return `${hr} 小时${suffix}`;
  if (day < 30) return `${day} 天${suffix}`;
  return '';
}

export function UserProfilePopover({
  userId,
  username,
  userType,
  botKind,
  avatarFileName,
  avatarUrl,
  role,
  onChangeAvatar,
  children,
}: UserProfilePopoverProps) {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<UserProfileResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // 权限相关状态
  const [authz, setAuthz] = useState<AdminUserAuthzSnapshot | null>(null);
  const [systemRoles, setSystemRoles] = useState<SystemRoleDto[]>([]);
  const [authzLoading, setAuthzLoading] = useState(false);
  const [authzExpanded, setAuthzExpanded] = useState(false);
  
  // Popover 控制状态
  const [open, setOpen] = useState(false);
  const [isClicked, setIsClicked] = useState(false);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  const canAuthzManage = useAuthStore((s) => Array.isArray(s.permissions) && s.permissions.includes('authz.manage'));

  const loadProfile = useCallback(async () => {
    if (profile || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await getUserProfile(userId);
      if (res.success) {
        setProfile(res.data);
      } else {
        setError(res.error?.message || '加载失败');
      }
    } catch {
      setError('加载失败');
    } finally {
      setLoading(false);
    }
  }, [userId, profile, loading]);
  
  const loadAuthz = async () => {
    if (authz || authzLoading || !canAuthzManage) return;
    setAuthzLoading(true);
    try {
      const [authzRes, rolesRes] = await Promise.all([
        getUserAuthz(userId),
        getSystemRoles(),
      ]);
      if (authzRes.success) {
        setAuthz(authzRes.data);
      }
      if (rolesRes.success) {
        setSystemRoles(rolesRes.data);
      }
    } finally {
      setAuthzLoading(false);
    }
  };

  // 清理定时器
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
      if (leaveTimeoutRef.current) clearTimeout(leaveTimeoutRef.current);
    };
  }, []);

  // 处理鼠标进入
  const handleMouseEnter = useCallback(() => {
    if (leaveTimeoutRef.current) {
      clearTimeout(leaveTimeoutRef.current);
      leaveTimeoutRef.current = null;
    }
    
    // 延迟打开，给用户反应时间
    if (!open && !isClicked) {
      hoverTimeoutRef.current = setTimeout(() => {
        setOpen(true);
        void loadProfile();
      }, 400);
    }
  }, [open, isClicked, loadProfile]);

  // 处理鼠标离开
  const handleMouseLeave = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    
    // 如果不是点击锁定状态，延迟关闭
    if (!isClicked) {
      leaveTimeoutRef.current = setTimeout(() => {
        setOpen(false);
      }, 150);
    }
  }, [isClicked]);

  // 处理点击打开/关闭
  const handleTriggerClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    if (leaveTimeoutRef.current) {
      clearTimeout(leaveTimeoutRef.current);
      leaveTimeoutRef.current = null;
    }
    
    if (open && isClicked) {
      // 已经是点击打开状态，再次点击关闭
      setOpen(false);
      setIsClicked(false);
    } else {
      // 点击打开，并锁定（不因鼠标离开而关闭）
      setOpen(true);
      setIsClicked(true);
      void loadProfile();
    }
  }, [open, isClicked, loadProfile]);

  // 处理 Popover 关闭（点击外部或按 Escape）
  const handleOpenChange = useCallback((newOpen: boolean) => {
    if (!newOpen) {
      setOpen(false);
      setIsClicked(false);
    }
  }, []);

  // 处理内容区域的鼠标事件（保持悬浮时打开）
  const handleContentMouseEnter = useCallback(() => {
    if (leaveTimeoutRef.current) {
      clearTimeout(leaveTimeoutRef.current);
      leaveTimeoutRef.current = null;
    }
  }, []);

  const handleContentMouseLeave = useCallback(() => {
    if (!isClicked) {
      leaveTimeoutRef.current = setTimeout(() => {
        setOpen(false);
      }, 150);
    }
  }, [isClicked]);

  const avatarSrc = resolveAvatarUrl({
    username,
    userType,
    botKind,
    avatarFileName: avatarFileName ?? null,
    avatarUrl,
  });
  const fallbackSrc = resolveNoHeadAvatarUrl();
  
  const currentRole = profile?.role || role || 'DEV';
  const roleCfg = roleIconConfig[currentRole] || roleIconConfig.DEV;
  
  // 获取系统角色名称
  const getSystemRoleName = (key: string | null | undefined) => {
    if (!key || key === 'none') return '无角色';
    const found = systemRoles.find((r) => r.key === key);
    return found?.name || key;
  };

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <div
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onClick={handleTriggerClick}
        >
          {children}
        </div>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="start"
          sideOffset={8}
          className="rounded-[12px] p-3 w-[260px] z-[100] outline-none"
          style={glassPanel}
          onMouseEnter={handleContentMouseEnter}
          onMouseLeave={handleContentMouseLeave}
        >
          {loading && !profile && (
            <div className="text-center py-4 text-[12px]" style={{ color: 'var(--text-muted)' }}>
              加载中...
            </div>
          )}

          {error && !profile && (
            <div className="text-center py-4 text-[12px]" style={{ color: 'rgba(239,68,68,0.9)' }}>
              {error}
            </div>
          )}

          {profile && (
            <div className="space-y-3">
              {/* 头部信息 */}
              <div className="flex items-center gap-2.5">
                {/* 头像（点击可修改） */}
                <div 
                  className="relative h-10 w-10 rounded-[10px] overflow-hidden shrink-0 ring-1 ring-white/10 cursor-pointer group"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    setIsClicked(false);
                    onChangeAvatar?.();
                  }}
                  title="点击修改头像"
                >
                  <img
                    src={avatarSrc}
                    alt="avatar"
                    className="h-full w-full object-cover transition-opacity group-hover:opacity-80"
                    onError={(e) => {
                      const el = e.currentTarget;
                      if (el.getAttribute('data-fallback-applied') === '1') return;
                      if (!fallbackSrc) return;
                      el.setAttribute('data-fallback-applied', '1');
                      el.src = fallbackSrc;
                    }}
                  />
                  {/* 编辑悬浮层 */}
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Pencil size={14} className="text-white" />
                  </div>
                  {/* 角色图标（右下角） */}
                  <span
                    className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full flex items-center justify-center border-2"
                    style={{ background: roleCfg.bg, borderColor: 'rgba(0,0,0,0.5)', color: roleCfg.color }}
                    title={roleCfg.label}
                  >
                    {roleCfg.icon}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                      {profile.displayName}
                    </span>
                    <span
                      className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-[4px]"
                      style={{
                        background: currentRole === 'ADMIN' ? 'rgba(99,102,241,0.12)' : 'rgba(59,130,246,0.12)',
                        border: `1px solid ${currentRole === 'ADMIN' ? 'rgba(99,102,241,0.25)' : 'rgba(59,130,246,0.25)'}`,
                        color: currentRole === 'ADMIN' ? 'var(--accent-gold)' : 'rgba(59,130,246,0.95)',
                      }}
                    >
                      {currentRole}
                    </span>
                  </div>
                  <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                    @{profile.username}
                  </div>
                </div>
              </div>

              {/* 最后活跃 */}
              {profile.lastActiveAt && (
                <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  <Clock size={12} />
                  <span>最后活跃：{formatRelativeTime(profile.lastActiveAt)}</span>
                </div>
              )}

              {/* 创作统计（近30天） */}
              {(profile.totalImageCount > 0 || profile.totalRunCount > 0) && (
                <div className="flex items-center gap-3 px-2 py-1.5 rounded-[8px]" style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <div className="flex items-center gap-1.5">
                    <Image size={12} style={{ color: 'var(--accent-gold)' }} />
                    <span className="text-[11px]" style={{ color: 'var(--text-primary)' }}>
                      {profile.totalImageCount}
                    </span>
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>张图</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Zap size={12} style={{ color: 'var(--accent-gold)' }} />
                    <span className="text-[11px]" style={{ color: 'var(--text-primary)' }}>
                      {profile.totalRunCount}
                    </span>
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>次任务</span>
                  </div>
                </div>
              )}

              {/* 群组列表 */}
              {profile.groups.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <Users2 size={12} style={{ color: 'var(--text-muted)' }} />
                    <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                      已加入群组
                    </span>
                  </div>
                  <div className="space-y-1">
                    {profile.groups.slice(0, 5).map((g) => (
                      <div
                        key={g.groupId}
                        className="flex items-center justify-between px-2 py-1 rounded-[6px]"
                        style={{ background: 'rgba(255,255,255,0.03)' }}
                      >
                        <span className="text-[11px] truncate" style={{ color: 'var(--text-primary)' }}>
                          {g.name}
                        </span>
                        <span className="text-[10px] shrink-0 ml-2" style={{ color: 'var(--text-muted)' }}>
                          {g.memberCount}人
                        </span>
                      </div>
                    ))}
                    {profile.groups.length > 5 && (
                      <div className="text-[10px] text-center" style={{ color: 'var(--text-muted)' }}>
                        +{profile.groups.length - 5} 个群组
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Agent 使用统计（可点击跳转日志） */}
              {(profile.agentUsage.length > 0 || profile.defectStats) && (
                <div>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <Zap size={12} style={{ color: 'var(--text-muted)' }} />
                    <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                      常用功能 (近30天)
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {profile.agentUsage.map((a) => (
                      <button
                        key={a.appKey}
                        type="button"
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] transition-colors hover:bg-white/10 cursor-pointer"
                        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpen(false);
                          setIsClicked(false);
                          navigate(`/logs?tab=llm&userId=${encodeURIComponent(profile.userId)}&appKey=${encodeURIComponent(a.appKey)}`);
                        }}
                        title={`查看 ${agentLabels[a.appKey] || a.appKey} 日志`}
                      >
                        {agentIcons[a.appKey] && (
                          <span style={{ color: 'var(--text-muted)' }}>{agentIcons[a.appKey]}</span>
                        )}
                        <span className="text-[10px]" style={{ color: 'var(--text-primary)' }}>
                          {agentLabels[a.appKey] || a.appKey}
                        </span>
                        <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                          {a.usageCount}
                        </span>
                      </button>
                    ))}
                    {/* 缺陷管理统计 */}
                    {profile.defectStats && (
                      <button
                        type="button"
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] transition-colors hover:bg-white/10 cursor-pointer"
                        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpen(false);
                          setIsClicked(false);
                          navigate('/defect-agent');
                        }}
                        title="缺陷管理：收到/提交"
                      >
                        <Bug size={10} style={{ color: 'var(--text-muted)' }} />
                        <span className="text-[10px]" style={{ color: 'var(--text-primary)' }}>
                          缺陷管理
                        </span>
                        <span className="text-[9px] flex items-center gap-0.5">
                          <span style={{ color: 'rgba(239,68,68,0.9)' }}>{profile.defectStats.receivedCount}</span>
                          <span style={{ color: 'var(--text-muted)' }}>/</span>
                          <span style={{ color: 'rgba(59,130,246,0.9)' }}>{profile.defectStats.submittedCount}</span>
                        </span>
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* 海鲜市场统计 */}
              {profile.marketplaceStats && profile.marketplaceStats.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <Store size={12} style={{ color: 'var(--text-muted)' }} />
                    <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                      海鲜市场
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {profile.marketplaceStats.map((item) => {
                      const typeConfig = {
                        watermark: { label: '水印', icon: <Droplets size={10} /> },
                        prompt: { label: '提示词', icon: <Type size={10} /> },
                        refImage: { label: '风格', icon: <ImageIcon size={10} /> },
                      }[item.configType] || { label: item.configType, icon: null };
                      return (
                        <div
                          key={item.configType}
                          className="flex items-center gap-1 px-1.5 py-0.5 rounded-[4px]"
                          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
                          title={`${typeConfig.label}：发布量/下载量`}
                        >
                          <span style={{ color: 'var(--text-muted)' }}>{typeConfig.icon}</span>
                          <span className="text-[10px]" style={{ color: 'var(--text-primary)' }}>
                            {typeConfig.label}
                          </span>
                          <span className="text-[9px] flex items-center gap-0.5">
                            <span style={{ color: 'rgba(59,130,246,0.9)' }}>{item.publishedCount}</span>
                            <span style={{ color: 'var(--text-muted)' }}>/</span>
                            <span style={{ color: 'rgba(239,68,68,0.9)' }}>{item.downloadedCount}</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 权限系统角色（仅管理员可见） */}
              {canAuthzManage && (
                <div className="pt-2 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                  <button
                    type="button"
                    className="flex items-center justify-between w-full px-2 py-1.5 rounded-[6px] text-[11px] transition-colors hover:bg-white/5"
                    style={{ color: 'var(--text-secondary)' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!authz && !authzLoading) {
                        void loadAuthz();
                      }
                      setAuthzExpanded(!authzExpanded);
                    }}
                  >
                    <div className="flex items-center gap-1.5">
                      <Shield size={12} />
                      <span>权限系统角色</span>
                    </div>
                    {authzExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  </button>
                  
                  {authzExpanded && (
                    <div className="mt-2 px-2 space-y-2">
                      {authzLoading ? (
                        <div className="text-[10px] py-2" style={{ color: 'var(--text-muted)' }}>
                          加载中...
                        </div>
                      ) : authz ? (
                        <>
                          {/* 系统角色 */}
                          <div className="flex items-center justify-between">
                            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>系统角色：</span>
                            <span 
                              className="text-[10px] font-medium px-1.5 py-0.5 rounded-[4px]"
                              style={{ 
                                background: authz.effectiveSystemRoleKey && authz.effectiveSystemRoleKey !== 'none' 
                                  ? 'rgba(99,102,241,0.12)' 
                                  : 'rgba(255,255,255,0.04)',
                                color: authz.effectiveSystemRoleKey && authz.effectiveSystemRoleKey !== 'none'
                                  ? 'var(--accent-gold)'
                                  : 'var(--text-muted)',
                              }}
                            >
                              {getSystemRoleName(authz.effectiveSystemRoleKey)}
                            </span>
                          </div>
                          
                          {/* 权限数量统计 */}
                          <div className="flex items-center gap-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            {authz.permAllow.length > 0 && (
                              <span style={{ color: 'rgba(34,197,94,0.9)' }}>
                                +{authz.permAllow.length} 允许
                              </span>
                            )}
                            {authz.permDeny.length > 0 && (
                              <span style={{ color: 'rgba(239,68,68,0.9)' }}>
                                -{authz.permDeny.length} 禁止
                              </span>
                            )}
                            {authz.permAllow.length === 0 && authz.permDeny.length === 0 && (
                              <span>无额外权限配置</span>
                            )}
                          </div>
                          
                          {/* 显示角色包含的权限（前5个） */}
                          {(() => {
                            const roleData = systemRoles.find((r) => r.key === authz.effectiveSystemRoleKey);
                            if (!roleData || roleData.permissions.length === 0) return null;
                            return (
                              <div className="mt-1">
                                <div className="text-[9px] mb-1" style={{ color: 'var(--text-muted)' }}>
                                  角色权限 ({roleData.permissions.length})：
                                </div>
                                <div className="flex flex-wrap gap-1">
                                  {roleData.permissions.slice(0, 6).map((p) => (
                                    <span
                                      key={p}
                                      className="text-[9px] px-1 py-0.5 rounded-[3px]"
                                      style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)' }}
                                    >
                                      {p}
                                    </span>
                                  ))}
                                  {roleData.permissions.length > 6 && (
                                    <span
                                      className="text-[9px] px-1 py-0.5"
                                      style={{ color: 'var(--text-muted)' }}
                                    >
                                      +{roleData.permissions.length - 6}
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          })()}
                        </>
                      ) : (
                        <div className="text-[10px] py-2" style={{ color: 'var(--text-muted)' }}>
                          无法加载权限信息
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* 空状态 */}
              {profile.groups.length === 0 && profile.agentUsage.length === 0 && profile.totalImageCount === 0 && (
                <div className="text-center py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  暂无使用记录
                </div>
              )}

              {/* 底部操作：查看日志 */}
              <div className="pt-2 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                <button
                  type="button"
                  className="flex items-center gap-1.5 w-full px-2 py-1.5 rounded-[6px] text-[11px] transition-colors hover:bg-white/5"
                  style={{ color: 'var(--text-secondary)' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    setIsClicked(false);
                    navigate(`/logs?userId=${profile.userId}`);
                  }}
                >
                  <Eye size={12} />
                  <span>查看用户日志</span>
                </button>
              </div>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
