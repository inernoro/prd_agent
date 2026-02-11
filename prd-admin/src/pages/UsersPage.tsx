import { useEffect, useMemo, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { TabBar } from '@/components/design/TabBar';
import { Select } from '@/components/design/Select';
import { Dialog } from '@/components/ui/Dialog';
import { getUsers, createUser, updateUserPassword, updateUserRole, updateUserStatus, unlockUser, forceExpireUser, updateUserAvatar, updateUserDisplayName, initializeUsers, adminImpersonate, getSystemRoles, getUserAuthz, updateUserAuthz, getAdminPermissionCatalog, getUserRateLimit, updateUserRateLimit } from '@/services';
import { MoreVertical, Pencil, Search, UserCog, Users, Gauge } from 'lucide-react';
import { AvatarEditDialog } from '@/components/ui/AvatarEditDialog';
import { UserProfilePopover } from '@/components/ui/UserProfilePopover';
import { resolveAvatarUrl, resolveNoHeadAvatarUrl } from '@/lib/avatar';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useNavigate } from 'react-router-dom';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import { useAuthStore } from '@/stores/authStore';
import { useThemeStore } from '@/stores/themeStore';
import { glassPanel } from '@/lib/glassStyles';
import { useNavOrderStore } from '@/stores/navOrderStore';

type UserRow = {
  userId: string;
  username: string;
  displayName: string;
  role: 'PM' | 'DEV' | 'QA' | 'ADMIN';
  status: 'Active' | 'Disabled';
  userType?: 'Human' | 'Bot' | string;
  botKind?: 'PM' | 'DEV' | 'QA' | string;
  avatarFileName?: string | null;
  avatarUrl?: string | null;
  createdAt: string;
  lastLoginAt?: string;
  lastActiveAt?: string;
  isLocked?: boolean;
  lockoutRemainingSeconds?: number;
};

// 格式化相对时间（保留供 profile popover 使用）
function fmtRelativeTime(v?: string | null) {
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

// 抑制 unused warning（将在 profile popover 中使用）
void fmtRelativeTime;

export default function UsersPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<UserRow['role'] | ''>('');
  const [status, setStatus] = useState<UserRow['status'] | ''>('');

  const [createOpen, setCreateOpen] = useState(false);
  const [createUsername, setCreateUsername] = useState('');
  const [createDisplayName, setCreateDisplayName] = useState('');
  const [createDisplayNameManuallyEdited, setCreateDisplayNameManuallyEdited] = useState(false);
  const [createRole, setCreateRole] = useState<UserRow['role']>('DEV');
  const [createPwd, setCreatePwd] = useState('');
  const [createSystemRoleKey, setCreateSystemRoleKey] = useState('agent_tester');
  const [createSystemRoles, setCreateSystemRoles] = useState<Array<{ key: string; name: string }>>([]);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [pwdOpen, setPwdOpen] = useState(false);
  const [pwdUser, setPwdUser] = useState<UserRow | null>(null);
  const [pwd, setPwd] = useState('');
  const [pwdSubmitError, setPwdSubmitError] = useState<string | null>(null);
  const [pwdSubmitting, setPwdSubmitting] = useState(false);

  const [forceExpireOpen, setForceExpireOpen] = useState(false);
  const [forceExpireTargetUser, setForceExpireTargetUser] = useState<UserRow | null>(null);
  const [forceExpireSubmitting, setForceExpireSubmitting] = useState(false);
  const [forceExpireError, setForceExpireError] = useState<string | null>(null);
  const [forceTargets, setForceTargets] = useState<{ admin: boolean; desktop: boolean }>({ admin: true, desktop: true });

  const [unlockingUserId, setUnlockingUserId] = useState<string | null>(null);
  const [roleUpdatingUserId, setRoleUpdatingUserId] = useState<string | null>(null);
  const [statusUpdatingUserId, setStatusUpdatingUserId] = useState<string | null>(null);

  const [avatarOpen, setAvatarOpen] = useState(false);
  const [avatarTargetUser, setAvatarTargetUser] = useState<UserRow | null>(null);

  const [nameOpen, setNameOpen] = useState(false);
  const [nameTargetUser, setNameTargetUser] = useState<UserRow | null>(null);
  const [nameValue, setNameValue] = useState('');
  const [nameSubmitting, setNameSubmitting] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const [switchingUserId, setSwitchingUserId] = useState<string | null>(null);
  const { login: authLogin, setPermissionsLoaded, setMenuCatalogLoaded } = useAuthStore();
  const loadThemeFromServer = useThemeStore((s) => s.loadFromServer);
  const loadNavOrderFromServer = useNavOrderStore((s) => s.loadFromServer);
  const canAuthzManage = useAuthStore((s) => Array.isArray(s.permissions) && s.permissions.includes('authz.manage'));

  // 用户后台权限（systemRoleKey + allow/deny）
  const [authzOpen, setAuthzOpen] = useState(false);
  const [authzUser, setAuthzUser] = useState<UserRow | null>(null);
  const [authzLoading, setAuthzLoading] = useState(false);
  const [authzSaving, setAuthzSaving] = useState(false);
  const [authzSystemRoles, setAuthzSystemRoles] = useState<Array<{ key: string; name: string }>>([]);
  const [authzSystemRoleKey, setAuthzSystemRoleKey] = useState<string>('none');
  const [authzCatalog, setAuthzCatalog] = useState<Array<{ key: string; name: string; description?: string | null }>>([]);
  const [authzAllowSet, setAuthzAllowSet] = useState<Set<string>>(new Set());
  const [authzDenySet, setAuthzDenySet] = useState<Set<string>>(new Set());

  // 限流配置
  const [rateLimitOpen, setRateLimitOpen] = useState(false);
  const [rateLimitUser, setRateLimitUser] = useState<UserRow | null>(null);
  const [rateLimitLoading, setRateLimitLoading] = useState(false);
  const [rateLimitSaving, setRateLimitSaving] = useState(false);
  const [rateLimitIsExempt, setRateLimitIsExempt] = useState(false);
  const [rateLimitUseCustom, setRateLimitUseCustom] = useState(false);
  const [rateLimitMaxRpm, setRateLimitMaxRpm] = useState(600);
  const [rateLimitMaxConcurrent, setRateLimitMaxConcurrent] = useState(100);
  const [rateLimitGlobalMaxRpm, setRateLimitGlobalMaxRpm] = useState(600);
  const [rateLimitGlobalMaxConcurrent, setRateLimitGlobalMaxConcurrent] = useState(100);

  const createUsernameOk = useMemo(() => {
    const u = (createUsername ?? '').trim();
    if (!u) return false;
    if (u.length < 4 || u.length > 32) return false;
    return /^[a-zA-Z0-9_]+$/.test(u);
  }, [createUsername]);

  const createPwdNonEmptyOk = useMemo(() => {
    return (createPwd ?? '').trim().length > 0;
  }, [createPwd]);

  const query = useMemo(
    () => ({ page, pageSize: 50, search: search.trim() || undefined, role: role || undefined, status: status || undefined }),
    [page, search, role, status]
  );

  const load = async () => {
    setLoading(true);
    try {
      const res = await getUsers(query);
      if (res.success) {
        setItems(res.data.items);
        setTotal(res.data.total);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.page, query.search, query.role, query.status]);

  const openCreateUser = async () => {
    setCreateUsername('');
    setCreateDisplayName('');
    setCreateDisplayNameManuallyEdited(false);
    setCreateRole('DEV');
    setCreatePwd('');
    setCreateSystemRoleKey('agent_tester');
    setCreateError(null);
    setCreateSubmitting(false);
    setCreateOpen(true);
    
    // 加载系统角色列表
    try {
      const res = await getSystemRoles();
      if (res.success) {
        setCreateSystemRoles(res.data.map((r) => ({ key: r.key, name: r.name })));
      }
    } catch {
      // ignore
    }
  };

  const submitCreateUser = async () => {
    if (!createUsernameOk) return;
    if (!createPwdNonEmptyOk) return;

    setCreateSubmitting(true);
    setCreateError(null);
    try {
      const res = await createUser({
        username: createUsername.trim(),
        displayName: createDisplayName.trim() || createUsername.trim(),
        role: createRole,
        password: createPwd,
      });
      if (!res.success) {
        setCreateError(res.error?.message || '创建失败');
        return;
      }
      
      // 设置权限角色
      if (createSystemRoleKey && createSystemRoleKey !== 'none') {
        try {
          await updateUserAuthz(res.data.userId, {
            systemRoleKey: createSystemRoleKey,
            permAllow: [],
            permDeny: [],
          });
        } catch {
          // 权限设置失败不影响用户创建成功
        }
      }
      
      toast.success('创建成功', `用户 ${res.data.username} 已创建，可继续设置头像`);
      setCreateOpen(false);
      
      // 打开头像编辑对话框
      setAvatarTargetUser({
        userId: res.data.userId,
        username: res.data.username,
        displayName: res.data.displayName,
        role: res.data.role,
        status: res.data.status,
        createdAt: res.data.createdAt,
        avatarFileName: null,
        avatarUrl: null,
      });
      setAvatarOpen(true);
      
      await load();
    } finally {
      setCreateSubmitting(false);
    }
  };

  const openChangePassword = (u: UserRow) => {
    setPwdUser(u);
    setPwd('');
    setPwdSubmitError(null);
    setPwdOpen(true);
  };

  const openChangeAvatar = (u: UserRow) => {
    setAvatarTargetUser(u);
    setAvatarOpen(true);
  };

  const isHumanUser = (u: UserRow) => {
    const t = String(u?.userType ?? '').trim().toLowerCase();
    if (!t) return true; // 兼容历史数据：默认视为人类
    return t === 'human';
  };

  const openChangeDisplayName = (u: UserRow) => {
    setNameTargetUser(u);
    setNameValue(String(u.displayName ?? '').trim());
    setNameError(null);
    setNameSubmitting(false);
    setNameOpen(true);
  };

  const submitChangeDisplayName = async () => {
    const u = nameTargetUser;
    if (!u) return;
    if (!isHumanUser(u)) return;
    const v = (nameValue ?? '').trim();
    if (!v) {
      setNameError('姓名不能为空');
      return;
    }
    if (v.length > 50) {
      setNameError('姓名不能超过 50 字符');
      return;
    }

    setNameSubmitting(true);
    setNameError(null);
    try {
      const res = await updateUserDisplayName(u.userId, v);
      if (!res.success) {
        setNameError(res.error?.message || '修改失败');
        return;
      }
      setNameOpen(false);
      await load();
    } finally {
      setNameSubmitting(false);
    }
  };

  const isLockedUser = (u: UserRow) => {
    const remaining = typeof u.lockoutRemainingSeconds === 'number' ? u.lockoutRemainingSeconds : 0;
    if (remaining > 0) return true;
    return u.isLocked === true;
  };

  const onSwitchToUser = async (u: UserRow) => {
    if (!u?.userId) return;
    
    const confirmed = await systemDialog.confirm({
      title: '切换用户登录',
      message: `确定要切换到用户 "${u.displayName}" (${u.username}) 登录吗？\n\n切换后将以该用户身份进行操作，当前管理员会话将被替换。`,
      tone: 'neutral',
      confirmText: '确认切换',
      cancelText: '取消',
    });
    
    if (!confirmed) return;
    
    setSwitchingUserId(u.userId);
    try {
      const res = await adminImpersonate(u.userId, 3600); // 1小时有效期
      if (!res.success) {
        toast.error(res.error?.message || '切换用户失败');
        return;
      }
      
      // 更新认证状态
      authLogin(
        {
          userId: res.data.user.userId,
          username: res.data.user.username,
          displayName: res.data.user.displayName,
          role: res.data.user.role,
        },
        res.data.accessToken
      );

      // 重置权限和菜单，触发 App.tsx 中的 useEffect 重新加载新用户的权限
      setPermissionsLoaded(false);
      setMenuCatalogLoaded(false);

      // 重新加载新用户的主题配置和导航顺序
      void loadThemeFromServer();
      void loadNavOrderFromServer();

      // 提示并跳转到首页
      toast.info(`已切换到用户 "${res.data.user.displayName}" (${res.data.user.username})`, `会话有效期约 ${Math.floor(res.data.expiresIn / 60)} 分钟`);
      navigate('/');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '切换用户时发生错误');
    } finally {
      setSwitchingUserId(null);
    }
  };

  const openUserAuthz = async (u: UserRow) => {
    if (!canAuthzManage) {
      toast.warning('无权限：需要 authz.manage');
      return;
    }
    setAuthzUser(u);
    setAuthzOpen(true);
    setAuthzLoading(true);
    try {
      const [rolesRes, snapRes, catalogRes] = await Promise.all([getSystemRoles(), getUserAuthz(u.userId), getAdminPermissionCatalog()]);
      if (!rolesRes.success) {
        toast.error(rolesRes.error?.message || '加载系统角色失败');
        setAuthzOpen(false);
        return;
      }
      if (!snapRes.success) {
        toast.error(snapRes.error?.message || '加载用户权限失败');
        setAuthzOpen(false);
        return;
      }
      if (!catalogRes.success) {
        toast.error(catalogRes.error?.message || '加载权限清单失败');
        setAuthzOpen(false);
        return;
      }
      setAuthzSystemRoles((rolesRes.data || []).map((r) => ({ key: r.key, name: r.name })));
      setAuthzSystemRoleKey(String(snapRes.data.systemRoleKey || snapRes.data.effectiveSystemRoleKey || 'none'));
      setAuthzCatalog((catalogRes.data.items || []).map((x) => ({ key: String(x.key || ''), name: String(x.name || ''), description: x.description ?? null })));
      setAuthzAllowSet(new Set((snapRes.data.permAllow || []).map((x) => String(x || '').trim()).filter(Boolean)));
      setAuthzDenySet(new Set((snapRes.data.permDeny || []).map((x) => String(x || '').trim()).filter(Boolean)));
    } finally {
      setAuthzLoading(false);
    }
  };

  const toggleAuthzSet = (which: 'allow' | 'deny', key: string) => {
    const k = String(key || '').trim();
    if (!k) return;
    if (which === 'allow') {
      setAuthzAllowSet((prev) => {
        const n = new Set(prev);
        if (n.has(k)) n.delete(k);
        else n.add(k);
        return n;
      });
    } else {
      setAuthzDenySet((prev) => {
        const n = new Set(prev);
        if (n.has(k)) n.delete(k);
        else n.add(k);
        return n;
      });
    }
  };

  const saveUserAuthz = async () => {
    if (!authzUser) return;
    if (authzSaving) return;
    setAuthzSaving(true);
    try {
      const res = await updateUserAuthz(authzUser.userId, {
        systemRoleKey: String(authzSystemRoleKey || '').trim() || null,
        permAllow: Array.from(authzAllowSet).sort(),
        permDeny: Array.from(authzDenySet).sort(),
      });
      if (!res.success) {
        toast.error(res.error?.message || '保存失败');
        return;
      }
      toast.success('已保存该用户的后台权限');
      setAuthzOpen(false);
      await load();
    } finally {
      setAuthzSaving(false);
    }
  };

  // 限流配置相关函数
  const openRateLimitConfig = async (u: UserRow) => {
    setRateLimitUser(u);
    setRateLimitOpen(true);
    setRateLimitLoading(true);
    try {
      const res = await getUserRateLimit(u.userId);
      if (!res.success) {
        toast.error(res.error?.message || '加载限流配置失败');
        setRateLimitOpen(false);
        return;
      }
      setRateLimitIsExempt(res.data.isExempt);
      setRateLimitUseCustom(res.data.hasCustomConfig);
      setRateLimitMaxRpm(res.data.maxRequestsPerMinute);
      setRateLimitMaxConcurrent(res.data.maxConcurrentRequests);
      setRateLimitGlobalMaxRpm(res.data.globalMaxRequestsPerMinute);
      setRateLimitGlobalMaxConcurrent(res.data.globalMaxConcurrentRequests);
    } finally {
      setRateLimitLoading(false);
    }
  };

  const saveRateLimitConfig = async () => {
    if (!rateLimitUser) return;
    if (rateLimitSaving) return;
    setRateLimitSaving(true);
    try {
      const res = await updateUserRateLimit(rateLimitUser.userId, {
        isExempt: rateLimitIsExempt,
        useCustomConfig: rateLimitUseCustom,
        maxRequestsPerMinute: rateLimitUseCustom ? rateLimitMaxRpm : undefined,
        maxConcurrentRequests: rateLimitUseCustom ? rateLimitMaxConcurrent : undefined,
      });
      if (!res.success) {
        toast.error(res.error?.message || '保存失败');
        return;
      }
      toast.success('已保存用户限流配置');
      setRateLimitOpen(false);
    } finally {
      setRateLimitSaving(false);
    }
  };

  const onUnlock = async (u: UserRow) => {
    if (!u?.userId) return;
    setUnlockingUserId(u.userId);
    try {
      const res = await unlockUser(u.userId);
      if (!res.success) return;
      await load();
    } finally {
      setUnlockingUserId(null);
    }
  };

  // （原先这里给头像做了 5px 内描边圈；现已按需求移除，避免卡顿/加载阶段露出“头像内边框”）

  const confirmTwice = async (opts: { title: string; message: string; tone?: 'neutral' | 'danger' }) => {
    const ok1 = await systemDialog.confirm({
      title: opts.title,
      message: opts.message,
      tone: opts.tone ?? 'neutral',
      confirmText: '继续',
      cancelText: '取消',
    });
    if (!ok1) return false;
    const ok2 = await systemDialog.confirm({
      title: '再次确认',
      message: opts.message,
      tone: opts.tone ?? 'neutral',
      confirmText: '确认执行',
      cancelText: '取消',
    });
    return ok2;
  };

  const roleLabel = (r: UserRow['role']) => {
    if (r === 'PM') return 'PM';
    if (r === 'DEV') return 'DEV';
    if (r === 'QA') return 'QA';
    if (r === 'ADMIN') return 'ADMIN';
    return String(r);
  };

  const onToggleStatus = async (u: UserRow) => {
    if (!u?.userId) return;
    if (statusUpdatingUserId) return;
    const next: UserRow['status'] = u.status === 'Active' ? 'Disabled' : 'Active';
    const actionLabel = next === 'Disabled' ? '停用' : '启用';
    const ok = await confirmTwice({
      title: '确认修改状态',
      message: `用户：${u.username}\n操作：${actionLabel}\nuserId：${u.userId}`,
      tone: next === 'Disabled' ? 'danger' : 'neutral',
    });
    if (!ok) return;

    setStatusUpdatingUserId(u.userId);
    try {
      await updateUserStatus(u.userId, next);
      await load();
    } finally {
      setStatusUpdatingUserId(null);
    }
  };

  const onSetRole = async (u: UserRow, nextRole: UserRow['role']) => {
    if (!u?.userId) return;
    if (roleUpdatingUserId) return;
    if (u.role === nextRole) return;
    const ok = await confirmTwice({
      title: '确认切换角色',
      message: `用户：${u.username}\n角色：${roleLabel(u.role)} → ${roleLabel(nextRole)}\nuserId：${u.userId}`,
      tone: 'neutral',
    });
    if (!ok) return;

    setRoleUpdatingUserId(u.userId);
    try {
      await updateUserRole(u.userId, nextRole);
      await load();
    } finally {
      setRoleUpdatingUserId(null);
    }
  };

  const submitChangePassword = async () => {
    if (!pwdUser) return;
    if (!pwd.trim()) return;

    setPwdSubmitting(true);
    setPwdSubmitError(null);
    try {
      const res = await updateUserPassword(pwdUser.userId, pwd);
      if (!res.success) {
        setPwdSubmitError(res.error?.message || '修改失败');
        return;
      }
      setPwdOpen(false);
    } finally {
      setPwdSubmitting(false);
    }
  };

  const openForceExpire = (u: UserRow) => {
    setForceExpireTargetUser(u);
    setForceExpireError(null);
    setForceExpireSubmitting(false);
    setForceTargets({ admin: true, desktop: true });
    setForceExpireOpen(true);
  };

  const submitForceExpire = async () => {
    if (!forceExpireTargetUser) return;
    const targets: Array<'admin' | 'desktop'> = [];
    if (forceTargets.admin) targets.push('admin');
    if (forceTargets.desktop) targets.push('desktop');
    if (targets.length === 0) {
      setForceExpireError('请至少选择一个端（admin/desktop）');
      return;
    }

    setForceExpireSubmitting(true);
    setForceExpireError(null);
    try {
      const res = await forceExpireUser(forceExpireTargetUser.userId, targets);
      if (!res.success) {
        setForceExpireError(res.error?.message || '踢下线失败');
        return;
      }
      setForceExpireOpen(false);
    } finally {
      setForceExpireSubmitting(false);
    }
  };

  const handleInitializeUsers = async () => {
    const confirmed = await systemDialog.confirm({
      title: '初始化用户',
      message: '此操作将删除所有现有用户并创建默认管理员账号（admin/admin）和三个机器人账号。此操作不可撤销，确定继续吗？',
      confirmText: '确定初始化',
      cancelText: '取消',
      tone: 'danger',
    });
    if (!confirmed) return;

    const doubleConfirmed = await systemDialog.confirm({
      title: '二次确认',
      message: '再次确认：您确定要删除所有用户并重新初始化吗？',
      confirmText: '确定',
      cancelText: '取消',
      tone: 'danger',
    });
    if (!doubleConfirmed) return;

    try {
      const res = await initializeUsers();
      
      if (!res.success) {
        toast.error('初始化失败', res.error?.message || '初始化用户失败');
        return;
      }

      toast.success('初始化成功', `已删除 ${res.data.deletedCount} 个用户，创建了管理员账号（admin/admin）和 ${res.data.botUserIds.length} 个机器人账号`);

      await load();
    } catch (error) {
      console.error('Initialize users error:', error);
      toast.error('初始化失败', '初始化用户时发生错误');
    }
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-5 overflow-x-hidden">
      <TabBar
        title="用户管理"
        icon={<Users size={16} />}
      />

      <GlassCard glow className="flex-1 min-h-0 flex flex-col">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-2.5 flex-nowrap min-w-0">
            <div className="flex-1 min-w-[200px] max-w-[320px]">
              <div className="relative">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
                <input
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  className="h-[36px] w-full rounded-[10px] pl-9 pr-4 text-[13px] outline-none transition-all duration-200 focus:ring-2 focus:ring-[var(--accent-gold)]/20"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-primary)' }}
                  placeholder="搜索用户名或昵称"
                />
              </div>
            </div>

            <Select
              value={role}
              onChange={(e) => {
                setRole((e.target.value as UserRow['role'] | '') ?? '');
                setPage(1);
              }}
              uiSize="sm"
              className="min-w-[88px] font-medium"
            >
              <option value="">角色</option>
              <option value="PM">PM</option>
              <option value="DEV">DEV</option>
              <option value="QA">QA</option>
              <option value="ADMIN">ADMIN</option>
            </Select>

            <Select
              value={status}
              onChange={(e) => {
                setStatus((e.target.value as UserRow['status'] | '') ?? '');
                setPage(1);
              }}
              uiSize="sm"
              className="min-w-[88px] font-medium"
            >
              <option value="">状态</option>
              <option value="Active">正常</option>
              <option value="Disabled">禁用</option>
            </Select>
          </div>

          <div className="ml-auto flex items-center gap-2 shrink-0 flex-wrap justify-end">
            <Button variant="secondary" size="xs" onClick={openCreateUser}>
              创建用户
            </Button>
            <div className="mx-0.5 h-6 w-px bg-white/8" aria-hidden />
            <Button variant="danger" size="xs" onClick={handleInitializeUsers}>
              初始化
            </Button>
          </div>
        </div>

        <div
          className="mt-4 flex-1 min-h-0 overflow-auto rounded-[14px] p-4"
          style={{
            background: 'rgba(255,255,255,0.015)',
            border: '1px solid rgba(255,255,255,0.05)',
          }}
        >
          {loading ? (
            <div className="py-10 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              加载中...
            </div>
          ) : items.length === 0 ? (
            <div className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              暂无数据
            </div>
          ) : (
            <div className="grid gap-2 grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 items-stretch">
              {items.map((u) => {
                const displayName = (u.displayName || u.username).trim();
                const isBot = String(u.userType ?? '').toLowerCase() === 'bot';
                const roleColors: Record<string, { bg: string; border: string; text: string }> = {
                  PM: { bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.25)', text: 'rgba(59,130,246,0.95)' },
                  DEV: { bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.25)', text: 'rgba(34,197,94,0.95)' },
                  QA: { bg: 'rgba(168,85,247,0.12)', border: 'rgba(168,85,247,0.25)', text: 'rgba(168,85,247,0.95)' },
                  ADMIN: { bg: 'rgba(214,178,106,0.12)', border: 'rgba(214,178,106,0.25)', text: 'var(--accent-gold)' },
                };
                const rc = roleColors[u.role] || roleColors.DEV;
                return (
                  <div
                    key={u.userId}
                    className="group relative rounded-[10px] p-2.5 transition-all duration-150"
                    style={{
                      background: isBot ? 'rgba(34,197,94,0.03)' : 'rgba(255,255,255,0.02)',
                      border: isBot ? '1px solid rgba(34,197,94,0.15)' : '1px solid rgba(255,255,255,0.06)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = isBot ? 'rgba(34,197,94,0.06)' : 'rgba(255,255,255,0.04)';
                      e.currentTarget.style.borderColor = isBot ? 'rgba(34,197,94,0.25)' : 'rgba(255,255,255,0.1)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = isBot ? 'rgba(34,197,94,0.03)' : 'rgba(255,255,255,0.02)';
                      e.currentTarget.style.borderColor = isBot ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.06)';
                    }}
                  >
                    {/* 操作按钮：悬浮显示 */}
                    <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger asChild>
                          <button
                            type="button"
                            className="inline-flex items-center justify-center h-6 w-6 rounded-[6px] transition-colors hover:bg-white/10"
                            style={{ background: 'rgba(0,0,0,0.3)', color: 'var(--text-secondary)' }}
                            aria-label="更多操作"
                          >
                            <MoreVertical size={14} />
                          </button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content
                            side="bottom"
                            align="end"
                            sideOffset={4}
                            className="rounded-[10px] p-1 min-w-[160px]"
                            style={{
                              zIndex: 90,
                              ...glassPanel,
                            }}
                          >
                            {/* 状态切换 */}
                            <DropdownMenu.Item
                              className="flex items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-[12px] outline-none cursor-pointer hover:bg-white/5"
                              style={{ color: u.status === 'Active' ? 'rgba(239,68,68,0.9)' : 'rgba(34,197,94,0.9)' }}
                              disabled={statusUpdatingUserId === u.userId}
                              onSelect={(e) => {
                                e.preventDefault();
                                onToggleStatus(u);
                              }}
                            >
                              {statusUpdatingUserId === u.userId ? '处理中...' : u.status === 'Active' ? '停用账户' : '启用账户'}
                            </DropdownMenu.Item>

                            <DropdownMenu.Separator className="h-px my-1" style={{ background: 'rgba(255,255,255,0.06)' }} />

                            {/* 角色切换子菜单 */}
                            <DropdownMenu.Sub>
                              <DropdownMenu.SubTrigger
                                className="flex items-center justify-between gap-2 rounded-[6px] px-2.5 py-1.5 text-[12px] outline-none cursor-pointer hover:bg-white/5"
                                style={{ color: 'var(--text-primary)' }}
                              >
                                切换角色
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M9 18l6-6-6-6" />
                                </svg>
                              </DropdownMenu.SubTrigger>
                              <DropdownMenu.Portal>
                                <DropdownMenu.SubContent
                                  sideOffset={4}
                                  className="rounded-[10px] p-1 min-w-[100px]"
                                  style={{
                                    zIndex: 91,
                                    ...glassPanel,
                                  }}
                                >
                                  {(['PM', 'DEV', 'QA', 'ADMIN'] as const).map((r) => (
                                    <DropdownMenu.Item
                                      key={r}
                                      className="flex items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-[12px] outline-none cursor-pointer hover:bg-white/5"
                                      style={{ color: u.role === r ? roleColors[r].text : 'var(--text-primary)' }}
                                      disabled={roleUpdatingUserId === u.userId || u.role === r}
                                      onSelect={(e) => {
                                        e.preventDefault();
                                        onSetRole(u, r);
                                      }}
                                    >
                                      {u.role === r && <span className="w-1.5 h-1.5 rounded-full" style={{ background: roleColors[r].text }} />}
                                      {r}
                                    </DropdownMenu.Item>
                                  ))}
                                </DropdownMenu.SubContent>
                              </DropdownMenu.Portal>
                            </DropdownMenu.Sub>

                            <DropdownMenu.Separator className="h-px my-1" style={{ background: 'rgba(255,255,255,0.06)' }} />

                            {isLockedUser(u) && (
                              <DropdownMenu.Item
                                className="flex items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-[12px] outline-none cursor-pointer hover:bg-white/5"
                                style={{ color: 'var(--text-primary)' }}
                                disabled={unlockingUserId === u.userId}
                                onSelect={(e) => {
                                  e.preventDefault();
                                  onUnlock(u);
                                }}
                              >
                                {unlockingUserId === u.userId ? '解除中...' : '解除锁定'}
                              </DropdownMenu.Item>
                            )}
                            {isHumanUser(u) && (
                              <DropdownMenu.Item
                                className="flex items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-[12px] outline-none cursor-pointer hover:bg-white/5"
                                style={{ color: 'var(--text-primary)' }}
                                onSelect={(e) => {
                                  e.preventDefault();
                                  openChangeDisplayName(u);
                                }}
                              >
                                <Pencil size={12} />
                                修改姓名
                              </DropdownMenu.Item>
                            )}
                            <DropdownMenu.Item
                              className="flex items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-[12px] outline-none cursor-pointer hover:bg-white/5"
                              style={{ color: 'var(--text-primary)' }}
                              onSelect={(e) => {
                                e.preventDefault();
                                openChangeAvatar(u);
                              }}
                            >
                              修改头像
                            </DropdownMenu.Item>
                            <DropdownMenu.Item
                              className="flex items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-[12px] outline-none cursor-pointer hover:bg-white/5"
                              style={{ color: 'var(--text-primary)' }}
                              onSelect={(e) => {
                                e.preventDefault();
                                openChangePassword(u);
                              }}
                            >
                              修改密码
                            </DropdownMenu.Item>
                            <DropdownMenu.Item
                              className="flex items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-[12px] outline-none cursor-pointer hover:bg-white/5"
                              style={{ color: 'var(--text-primary)' }}
                              onSelect={(e) => {
                                e.preventDefault();
                                openForceExpire(u);
                              }}
                            >
                              一键过期
                            </DropdownMenu.Item>

                            {canAuthzManage && (
                              <DropdownMenu.Item
                                className="flex items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-[12px] outline-none cursor-pointer hover:bg-white/5"
                                style={{ color: 'var(--text-primary)' }}
                                onSelect={(e) => {
                                  e.preventDefault();
                                  void openUserAuthz(u);
                                }}
                              >
                                后台权限
                              </DropdownMenu.Item>
                            )}
                            <DropdownMenu.Item
                              className="flex items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-[12px] outline-none cursor-pointer hover:bg-white/5"
                              style={{ color: 'var(--text-primary)' }}
                              onSelect={(e) => {
                                e.preventDefault();
                                void openRateLimitConfig(u);
                              }}
                            >
                              <Gauge size={12} />
                              限流配置
                            </DropdownMenu.Item>

                            <DropdownMenu.Separator className="h-px my-1" style={{ background: 'rgba(255,255,255,0.06)' }} />

                            <DropdownMenu.Item
                              className="flex items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-[12px] outline-none cursor-pointer hover:bg-white/5"
                              style={{ color: 'var(--text-primary)' }}
                              disabled={switchingUserId === u.userId}
                              onSelect={(e) => {
                                e.preventDefault();
                                onSwitchToUser(u);
                              }}
                            >
                              <UserCog size={12} />
                              {switchingUserId === u.userId ? '切换中...' : '切换登录'}
                            </DropdownMenu.Item>

                            <DropdownMenu.Separator className="h-px my-1" style={{ background: 'rgba(255,255,255,0.06)' }} />

                            <DropdownMenu.Item
                              className="flex items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-[12px] outline-none cursor-pointer hover:bg-white/5"
                              style={{ color: 'var(--text-primary)' }}
                              onSelect={(e) => {
                                e.preventDefault();
                                navigate(`/logs?tab=llm&userId=${encodeURIComponent(u.userId)}`);
                              }}
                            >
                              LLM 日志
                            </DropdownMenu.Item>
                            <DropdownMenu.Item
                              className="flex items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-[12px] outline-none cursor-pointer hover:bg-white/5"
                              style={{ color: 'var(--text-primary)' }}
                              onSelect={(e) => {
                                e.preventDefault();
                                navigate(`/logs?tab=system&userId=${encodeURIComponent(u.userId)}`);
                              }}
                            >
                              系统日志
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
                    </div>

                    {/* 紧凑卡片内容 */}
                    <div className="flex items-center gap-2.5">
                      {/* 头像（悬浮/点击显示用户详情） */}
                      <UserProfilePopover
                        userId={u.userId}
                        username={u.username}
                        userType={u.userType}
                        botKind={u.botKind}
                        avatarFileName={u.avatarFileName}
                        avatarUrl={u.avatarUrl}
                        role={u.role}
                        onChangeAvatar={() => openChangeAvatar(u)}
                      >
                        <div
                          className="relative h-9 w-9 rounded-[8px] overflow-hidden shrink-0 cursor-pointer ring-1 ring-white/8 hover:ring-[var(--accent-gold)]/40 transition-all"
                        >
                          {(() => {
                            const url = resolveAvatarUrl({
                              username: u.username,
                              userType: u.userType,
                              botKind: u.botKind,
                              avatarFileName: u.avatarFileName ?? null,
                              avatarUrl: u.avatarUrl,
                            });
                            const fallback = resolveNoHeadAvatarUrl();
                            return (
                              <img
                                src={url}
                                alt="avatar"
                                className="h-full w-full object-cover"
                                onError={(e) => {
                                  const el = e.currentTarget;
                                  if (el.getAttribute('data-fallback-applied') === '1') return;
                                  if (!fallback) return;
                                  el.setAttribute('data-fallback-applied', '1');
                                  el.src = fallback;
                                }}
                              />
                            );
                          })()}
                          {/* 角色/机器人图标（右下角） */}
                          {(() => {
                            // 机器人使用特殊图标
                            if (isBot) {
                              return (
                                <span
                                  className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full flex items-center justify-center border-2"
                                  style={{ background: 'rgba(34,197,94,0.9)', borderColor: 'rgba(0,0,0,0.5)', color: '#fff' }}
                                  title="机器人"
                                >
                                  <svg className="w-2 h-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2m-6 7a6 6 0 0112 0v5a3 3 0 01-3 3H9a3 3 0 01-3-3v-5z" />
                                    <circle cx="9" cy="13" r="1" fill="currentColor" />
                                    <circle cx="15" cy="13" r="1" fill="currentColor" />
                                  </svg>
                                </span>
                              );
                            }
                            // 人类用户显示角色图标
                            const roleIconConfig: Record<string, { bg: string; color: string; icon: React.ReactNode }> = {
                              PM: {
                                bg: 'rgba(59,130,246,0.9)',
                                color: '#fff',
                                icon: <svg className="w-2 h-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>,
                              },
                              DEV: {
                                bg: 'rgba(34,197,94,0.9)',
                                color: '#fff',
                                icon: <svg className="w-2 h-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6" /></svg>,
                              },
                              QA: {
                                bg: 'rgba(168,85,247,0.9)',
                                color: '#fff',
                                icon: <svg className="w-2 h-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" /></svg>,
                              },
                              ADMIN: {
                                bg: 'rgba(214,178,106,0.95)',
                                color: '#000',
                                icon: <svg className="w-2 h-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M12 2l7 4v6c0 5-3 9-7 10-4-1-7-5-7-10V6l7-4z" /></svg>,
                              },
                            };
                            const cfg = roleIconConfig[u.role] || roleIconConfig.DEV;
                            return (
                              <span
                                className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full flex items-center justify-center border-2"
                                style={{ background: cfg.bg, borderColor: 'rgba(0,0,0,0.5)', color: cfg.color }}
                                title={u.role}
                              >
                                {cfg.icon}
                              </span>
                            );
                          })()}
                        </div>
                      </UserProfilePopover>

                      {/* 信息区 */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          {/* 名称 */}
                          <span
                            className="text-[12px] font-semibold truncate"
                            style={{ color: 'var(--text-primary)' }}
                            title={displayName}
                          >
                            {displayName}
                          </span>
                          {/* 角色标签 */}
                          <span
                            className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-[4px]"
                            style={{ background: rc.bg, border: `1px solid ${rc.border}`, color: rc.text }}
                          >
                            {u.role}
                          </span>
                        </div>
                        {/* 用户名 */}
                        <div className="text-[11px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }} title={`@${u.username}`}>
                          @{u.username}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="mt-3 pt-3 flex items-center justify-between border-t border-white/8">
          <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
            共 {total} 人 · 第 {page} / {Math.max(1, Math.ceil(total / 50))} 页
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="secondary"
              size="xs"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </Button>
            <Button
              variant="secondary"
              size="xs"
              disabled={page >= Math.ceil(total / 50)}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </Button>
          </div>
        </div>
      </GlassCard>

      <Dialog
        open={createOpen}
        onOpenChange={(v) => {
          setCreateOpen(v);
          if (!v) {
            setCreateUsername('');
            setCreateDisplayName('');
            setCreateDisplayNameManuallyEdited(false);
            setCreateRole('DEV');
            setCreatePwd('');
            setCreateSystemRoleKey('agent_tester');
            setCreateError(null);
            setCreateSubmitting(false);
          }
        }}
        title="创建用户"
        description="创建账号（用户名）+ 密码 + 角色 + 权限"
        content={
          <div className="space-y-4">
            {/* 第一行：头像 + 用户名 + 显示名称 */}
            <div className="flex items-start gap-4">
              {/* 头像预览（点击提示创建后可修改） */}
              <div className="shrink-0">
                <div
                  className="h-16 w-16 rounded-[12px] overflow-hidden flex items-center justify-center relative group cursor-pointer"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)' }}
                  title="创建成功后可设置头像"
                  onClick={() => toast.info('提示', '请先完成用户创建，创建成功后将自动弹出头像设置')}
                >
                  <img
                    src={resolveNoHeadAvatarUrl()}
                    alt="default avatar"
                    className="h-full w-full object-cover transition-opacity group-hover:opacity-70"
                  />
                  {/* 悬浮提示 */}
                  <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Pencil size={16} className="text-white" />
                  </div>
                </div>
                <div className="text-[10px] text-center mt-1" style={{ color: 'var(--text-muted)' }}>
                  创建后可改
                </div>
              </div>
              
              {/* 用户名 + 显示名称 */}
              <div className="flex-1 grid grid-cols-2 gap-3">
                <div>
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>用户名</div>
                  <input
                    value={createUsername}
                    onChange={(e) => {
                      const val = e.target.value;
                      setCreateUsername(val);
                      setCreateError(null);
                      // 自动同步到显示名称（如果没有手动编辑过）
                      if (!createDisplayNameManuallyEdited) {
                        setCreateDisplayName(val);
                      }
                    }}
                    className="mt-1.5 h-9 w-full rounded-[10px] px-3 text-sm outline-none"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                    placeholder="4-32位"
                    autoComplete="off"
                  />
                </div>
                <div>
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>显示名称</div>
                  <input
                    value={createDisplayName}
                    onChange={(e) => {
                      setCreateDisplayName(e.target.value);
                      setCreateDisplayNameManuallyEdited(true);
                      setCreateError(null);
                    }}
                    className="mt-1.5 h-9 w-full rounded-[10px] px-3 text-sm outline-none"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                    placeholder="自动同步"
                    autoComplete="off"
                  />
                </div>
              </div>
            </div>

            {/* 第二行：密码 */}
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>密码</div>
              <input
                value={createPwd}
                onChange={(e) => {
                  setCreatePwd(e.target.value);
                  setCreateError(null);
                }}
                type="password"
                className="mt-1.5 h-9 w-full rounded-[10px] px-3 text-sm outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                placeholder="设置登录密码"
                autoComplete="new-password"
              />
            </div>

            {/* 第三行：角色 + 权限（等高布局） */}
            <div className="grid grid-cols-2 gap-4 items-stretch">
              {/* 角色选择 */}
              <div className="flex flex-col">
                <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>角色</div>
                <div
                  className="rounded-[10px] p-2 space-y-1 flex-1"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}
                >
                  {([
                    { key: 'PM', label: 'PM', desc: '产品经理' },
                    { key: 'DEV', label: 'DEV', desc: '开发' },
                    { key: 'QA', label: 'QA', desc: '测试' },
                    { key: 'ADMIN', label: 'ADMIN', desc: '管理员' },
                  ] as const).map((r) => (
                    <label
                      key={r.key}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-[6px] cursor-pointer transition-colors hover:bg-white/5"
                    >
                      <input
                        type="radio"
                        name="createRole"
                        value={r.key}
                        checked={createRole === r.key}
                        onChange={() => setCreateRole(r.key)}
                        className="accent-[var(--accent-gold)]"
                      />
                      <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{r.label}</span>
                      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{r.desc}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* 权限选择 */}
              <div className="flex flex-col">
                <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>权限</div>
                <div
                  className="rounded-[10px] p-2 space-y-1 flex-1"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}
                >
                  {(createSystemRoles.length > 0 ? createSystemRoles : [
                    { key: 'admin', name: '管理员' },
                    { key: 'operator', name: '运营/运维' },
                    { key: 'viewer', name: '只读' },
                    { key: 'agent_tester', name: 'Agent 体验者' },
                    { key: 'none', name: '无权限' },
                  ]).map((r) => (
                    <label
                      key={r.key}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-[6px] cursor-pointer transition-colors hover:bg-white/5"
                    >
                      <input
                        type="radio"
                        name="createSystemRole"
                        value={r.key}
                        checked={createSystemRoleKey === r.key}
                        onChange={() => setCreateSystemRoleKey(r.key)}
                        className="accent-[var(--accent-gold)]"
                      />
                      <span className="text-[12px]" style={{ color: 'var(--text-primary)' }}>{r.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            {/* 错误提示 */}
            {!createUsernameOk && createUsername.trim().length > 0 && (
              <div className="text-sm" style={{ color: 'rgba(239,68,68,0.95)' }}>
                用户名不合法：4-32 位，仅字母/数字/下划线
              </div>
            )}

            {createError && (
              <div
                className="rounded-[10px] px-3 py-2 text-sm"
                style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.28)', color: 'rgba(239,68,68,0.95)' }}
              >
                {createError}
              </div>
            )}

            {/* 按钮 */}
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)} disabled={createSubmitting}>
                取消
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={submitCreateUser}
                disabled={createSubmitting || !createUsernameOk || !createPwdNonEmptyOk}
              >
                {createSubmitting ? '创建中...' : '确认创建'}
              </Button>
            </div>
          </div>
        }
      />

      <AvatarEditDialog
        open={avatarOpen}
        onOpenChange={(v) => {
          setAvatarOpen(v);
          if (!v) setAvatarTargetUser(null);
        }}
        title={avatarTargetUser ? `修改头像：${avatarTargetUser.username}` : '修改头像'}
        description={avatarTargetUser ? `${avatarTargetUser.displayName} · ${avatarTargetUser.userId}` : undefined}
        userId={avatarTargetUser?.userId ?? null}
        username={avatarTargetUser?.username}
        userType={avatarTargetUser?.userType ?? null}
        avatarFileName={avatarTargetUser?.avatarFileName ?? null}
        onSave={async (avatarFileName) => {
          if (!avatarTargetUser) return;
          const res = await updateUserAvatar(avatarTargetUser.userId, avatarFileName);
          if (!res.success) throw new Error(res.error?.message || '保存失败');
          await load();
        }}
      />

      <Dialog
        open={nameOpen}
        onOpenChange={(v) => {
          setNameOpen(v);
          if (!v) {
            setNameTargetUser(null);
            setNameValue('');
            setNameError(null);
            setNameSubmitting(false);
          }
        }}
        title={nameTargetUser ? `修改姓名：${nameTargetUser.username}` : '修改姓名'}
        description={nameTargetUser ? `${nameTargetUser.userId}` : undefined}
        content={
          <div className="space-y-4">
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>姓名</div>
              <input
                value={nameValue}
                onChange={(e) => {
                  setNameValue(e.target.value);
                  setNameError(null);
                }}
                className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                placeholder="请输入姓名（1-50 字符）"
                autoComplete="off"
              />
            </div>

            {nameError && (
              <div
                className="rounded-[14px] px-4 py-3 text-sm"
                style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.28)', color: 'rgba(239,68,68,0.95)' }}
              >
                {nameError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setNameOpen(false)} disabled={nameSubmitting}>
                取消
              </Button>
              <Button variant="primary" size="sm" onClick={submitChangeDisplayName} disabled={nameSubmitting}>
                {nameSubmitting ? '保存中...' : '保存'}
              </Button>
            </div>
          </div>
        }
      />

      <Dialog
        open={pwdOpen}
        onOpenChange={(v) => {
          setPwdOpen(v);
          if (!v) {
            setPwdUser(null);
            setPwd('');
            setPwdSubmitError(null);
            setPwdSubmitting(false);
          }
        }}
        title={pwdUser ? `修改密码：${pwdUser.username}` : '修改密码'}
        description={pwdUser ? `${pwdUser.displayName} · ${pwdUser.userId}` : undefined}
        content={
          <div className="space-y-4">
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>新密码</div>
              <input
                value={pwd}
                onChange={(e) => {
                  setPwd(e.target.value);
                  setPwdSubmitError(null);
                }}
                type="password"
                className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                placeholder="设置登录密码"
                autoComplete="new-password"
              />
            </div>

            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              该用户下次登录时将被要求重新设置密码
            </div>

            {pwdSubmitError && (
              <div
                className="rounded-[14px] px-4 py-3 text-sm"
                style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.28)', color: 'rgba(239,68,68,0.95)' }}
              >
                {pwdSubmitError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setPwdOpen(false)} disabled={pwdSubmitting}>
                取消
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={submitChangePassword}
                disabled={pwdSubmitting || !pwd.trim()}
              >
                {pwdSubmitting ? '保存中...' : '保存'}
              </Button>
            </div>
          </div>
        }
      />

      <Dialog
        open={forceExpireOpen}
        onOpenChange={(v) => {
          setForceExpireOpen(v);
          if (!v) {
            setForceExpireTargetUser(null);
            setForceExpireError(null);
            setForceExpireSubmitting(false);
            setForceTargets({ admin: true, desktop: true });
          }
        }}
        title={forceExpireTargetUser ? `一键过期：${forceExpireTargetUser.username}` : '一键过期'}
        description={forceExpireTargetUser ? `${forceExpireTargetUser.displayName} · ${forceExpireTargetUser.userId}` : undefined}
        content={
          <div className="space-y-4">
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
              说明：此操作会让所选端的登录态立刻失效（可用于测试过期/踢下线）。
            </div>

            <div className="grid gap-2">
              <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
                <input
                  type="checkbox"
                  checked={forceTargets.admin}
                  onChange={(e) => setForceTargets((s) => ({ ...s, admin: e.target.checked }))}
                />
                踢 Admin（Web 管理端）
              </label>
              <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
                <input
                  type="checkbox"
                  checked={forceTargets.desktop}
                  onChange={(e) => setForceTargets((s) => ({ ...s, desktop: e.target.checked }))}
                />
                踢 Desktop（桌面端）
              </label>
            </div>

            {forceExpireError && (
              <div
                className="rounded-[14px] px-4 py-3 text-sm"
                style={{ border: '1px solid rgba(239,68,68,0.35)', background: 'rgba(239,68,68,0.08)', color: 'rgba(239,68,68,0.95)' }}
              >
                {forceExpireError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" disabled={forceExpireSubmitting} onClick={() => setForceExpireOpen(false)}>
                取消
              </Button>
              <Button variant="primary" size="sm" disabled={forceExpireSubmitting} onClick={submitForceExpire}>
                {forceExpireSubmitting ? '处理中...' : '确认踢下线'}
              </Button>
            </div>
          </div>
        }
      />

      <Dialog
        open={authzOpen}
        onOpenChange={(v) => {
          setAuthzOpen(v);
          if (!v) {
            setAuthzUser(null);
            setAuthzLoading(false);
            setAuthzSaving(false);
            setAuthzSystemRoles([]);
            setAuthzSystemRoleKey('none');
            setAuthzCatalog([]);
            setAuthzAllowSet(new Set());
            setAuthzDenySet(new Set());
          }
        }}
        title={authzUser ? `后台菜单权限：${authzUser.username}` : '后台菜单权限'}
        description={authzUser ? `${authzUser.displayName} · ${authzUser.userId}` : undefined}
        content={
          <div className="space-y-4">
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
              说明：菜单/路由由 permission 推导。这里设置该用户的 system role（主）以及 allow/deny（例外）。
            </div>

            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>系统角色（systemRoleKey）</div>
              <Select
                value={authzSystemRoleKey}
                onChange={(e) => setAuthzSystemRoleKey(e.target.value)}
                disabled={authzLoading || authzSaving}
                uiSize="md"
                className="mt-2"
              >
                {authzSystemRoles.map((r) => (
                  <option key={r.key} value={r.key}>{r.name}（{r.key}）</option>
                ))}
                {authzSystemRoles.length === 0 ? <option value="none">无权限（none）</option> : null}
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>额外允许（勾选 permission）</div>
                <div className="mt-2 rounded-[14px] p-2 overflow-auto min-h-[160px] max-h-[220px]"
                     style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)' }}>
                  {authzCatalog.map((p) => {
                    const k = String(p.key || '').trim();
                    const checked = authzAllowSet.has(k);
                    return (
                      <label key={`allow-${k}`} className="flex items-start gap-2 px-2 py-1 rounded-[10px] hover:bg-white/5">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={authzLoading || authzSaving}
                          onChange={() => toggleAuthzSet('allow', k)}
                        />
                        <div className="min-w-0">
                          <div className="text-xs" style={{ color: 'var(--text-primary)' }}>{p.name}</div>
                          <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                            <span className="opacity-80">{k}</span>
                            {p.description ? ` · ${p.description}` : ''}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                  {authzCatalog.length === 0 && !authzLoading ? (
                    <div className="text-xs px-2 py-1" style={{ color: 'var(--text-muted)' }}>权限清单为空</div>
                  ) : null}
                </div>
              </div>

              <div className="min-w-0">
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>禁止（勾选 permission）</div>
                <div className="mt-2 rounded-[14px] p-2 overflow-auto min-h-[160px] max-h-[220px]"
                     style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)' }}>
                  {authzCatalog.map((p) => {
                    const k = String(p.key || '').trim();
                    const checked = authzDenySet.has(k);
                    return (
                      <label key={`deny-${k}`} className="flex items-start gap-2 px-2 py-1 rounded-[10px] hover:bg-white/5">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={authzLoading || authzSaving}
                          onChange={() => toggleAuthzSet('deny', k)}
                        />
                        <div className="min-w-0">
                          <div className="text-xs" style={{ color: 'var(--text-primary)' }}>{p.name}</div>
                          <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                            <span className="opacity-80">{k}</span>
                            {p.description ? ` · ${p.description}` : ''}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                  {authzCatalog.length === 0 && !authzLoading ? (
                    <div className="text-xs px-2 py-1" style={{ color: 'var(--text-muted)' }}>权限清单为空</div>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" disabled={authzLoading || authzSaving} onClick={() => setAuthzOpen(false)}>
                取消
              </Button>
              <Button variant="primary" size="sm" disabled={authzLoading || authzSaving || !authzUser} onClick={saveUserAuthz}>
                {authzSaving ? '保存中...' : '保存'}
              </Button>
            </div>
          </div>
        }
      />

      {/* 限流配置 Dialog */}
      <Dialog
        open={rateLimitOpen}
        onOpenChange={(v) => {
          setRateLimitOpen(v);
          if (!v) {
            setRateLimitUser(null);
            setRateLimitLoading(false);
            setRateLimitSaving(false);
          }
        }}
        title={rateLimitUser ? `限流配置：${rateLimitUser.username}` : '限流配置'}
        description={rateLimitUser ? `${rateLimitUser.displayName} · ${rateLimitUser.userId}` : undefined}
        content={
          <div className="space-y-4">
            {rateLimitLoading ? (
              <div className="py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                加载中...
              </div>
            ) : (
              <>
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  全局默认：每分钟 {rateLimitGlobalMaxRpm} 次，最大并发 {rateLimitGlobalMaxConcurrent}
                </div>

                {/* 豁免开关 */}
                <div
                  className="rounded-[14px] p-4"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)' }}
                >
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={rateLimitIsExempt}
                      onChange={(e) => setRateLimitIsExempt(e.target.checked)}
                      disabled={rateLimitSaving}
                      className="w-4 h-4"
                    />
                    <div>
                      <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                        豁免限流
                      </div>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        开启后该用户不受任何限流约束（仅限特殊用户）
                      </div>
                    </div>
                  </label>
                </div>

                {/* 自定义配置 */}
                {!rateLimitIsExempt && (
                  <div
                    className="rounded-[14px] p-4"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)' }}
                  >
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={rateLimitUseCustom}
                        onChange={(e) => setRateLimitUseCustom(e.target.checked)}
                        disabled={rateLimitSaving}
                        className="w-4 h-4"
                      />
                      <div>
                        <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                          使用自定义配置
                        </div>
                        <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                          不勾选则使用全局默认配置
                        </div>
                      </div>
                    </label>

                    {rateLimitUseCustom && (
                      <div className="mt-4 grid grid-cols-2 gap-4">
                        <div>
                          <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                            每分钟最大请求数
                          </label>
                          <input
                            type="number"
                            value={rateLimitMaxRpm}
                            onChange={(e) => setRateLimitMaxRpm(Number(e.target.value) || 600)}
                            disabled={rateLimitSaving}
                            min={1}
                            max={100000}
                            className="mt-1 h-10 w-full rounded-[10px] px-3 text-sm outline-none"
                            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                            最大并发请求数
                          </label>
                          <input
                            type="number"
                            value={rateLimitMaxConcurrent}
                            onChange={(e) => setRateLimitMaxConcurrent(Number(e.target.value) || 100)}
                            disabled={rateLimitSaving}
                            min={1}
                            max={10000}
                            className="mt-1 h-10 w-full rounded-[10px] px-3 text-sm outline-none"
                            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex items-center justify-end gap-2">
                  <Button variant="secondary" size="sm" disabled={rateLimitSaving} onClick={() => setRateLimitOpen(false)}>
                    取消
                  </Button>
                  <Button variant="primary" size="sm" disabled={rateLimitSaving || !rateLimitUser} onClick={saveRateLimitConfig}>
                    {rateLimitSaving ? '保存中...' : '保存'}
                  </Button>
                </div>
              </>
            )}
          </div>
        }
      />
    </div>
  );
}
