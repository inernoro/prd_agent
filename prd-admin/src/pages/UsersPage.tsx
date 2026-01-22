import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { TabBar } from '@/components/design/TabBar';
import { Select } from '@/components/design/Select';
import { Dialog } from '@/components/ui/Dialog';
import { getUsers, createUser, bulkCreateUsers, generateInviteCodes, updateUserPassword, updateUserRole, updateUserStatus, unlockUser, forceExpireUser, updateUserAvatar, updateUserDisplayName, initializeUsers, adminImpersonate, getSystemRoles, getUserAuthz, updateUserAuthz, getAdminPermissionCatalog, getUserRateLimit, updateUserRateLimit } from '@/services';
import { CheckCircle2, Circle, Clock, MoreVertical, Pencil, Search, XCircle, UserCog, Users, Gauge } from 'lucide-react';
import { AvatarEditDialog } from '@/components/ui/AvatarEditDialog';
import { resolveAvatarUrl, resolveNoHeadAvatarUrl } from '@/lib/avatar';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useNavigate } from 'react-router-dom';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import { useAuthStore } from '@/stores/authStore';

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

function fmtDateTime(v?: string | null) {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
}

function fmtRelative(v?: string | null) {
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

const passwordRules: Array<{ key: string; label: string; test: (pwd: string) => boolean }> = [
  { key: 'len', label: '长度 8-128 位', test: (pwd) => pwd.length >= 8 && pwd.length <= 128 },
  { key: 'lower', label: '包含小写字母', test: (pwd) => /[a-z]/.test(pwd) },
  { key: 'upper', label: '包含大写字母', test: (pwd) => /[A-Z]/.test(pwd) },
  { key: 'digit', label: '包含数字', test: (pwd) => /\d/.test(pwd) },
  { key: 'special', label: '包含特殊字符（如 !@#$ 等）', test: (pwd) => /[!@#$%^&*(),.?":{}|<>]/.test(pwd) },
];

export default function UsersPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<UserRow['role'] | ''>('');
  const [status, setStatus] = useState<UserRow['status'] | ''>('');

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteCount, setInviteCount] = useState(1);
  const [inviteCodes, setInviteCodes] = useState<string[]>([]);

  const [createOpen, setCreateOpen] = useState(false);
  const [createUsername, setCreateUsername] = useState('');
  const [createDisplayName, setCreateDisplayName] = useState('');
  const [createRole, setCreateRole] = useState<UserRow['role']>('DEV');
  const [createPwd, setCreatePwd] = useState('');
  const [createPwd2, setCreatePwd2] = useState('');
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createResult, setCreateResult] = useState<{ userId: string; username: string } | null>(null);

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkPrefix, setBulkPrefix] = useState('');
  const [bulkStart, setBulkStart] = useState(1);
  const [bulkCount, setBulkCount] = useState(5);
  const [bulkRole, setBulkRole] = useState<UserRow['role']>('DEV');
  const [bulkPwd, setBulkPwd] = useState('');
  const [bulkPwd2, setBulkPwd2] = useState('');
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<{
    requestedCount: number;
    createdCount: number;
    failedCount: number;
    createdItems: Array<{ userId: string; username: string }>;
    failedItems: Array<{ username: string; code: string; message: string }>;
  } | null>(null);

  const [pwdOpen, setPwdOpen] = useState(false);
  const [pwdUser, setPwdUser] = useState<UserRow | null>(null);
  const [pwd, setPwd] = useState('');
  const [pwd2, setPwd2] = useState('');
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

  const pwdChecks = useMemo(() => {
    const v = pwd ?? '';
    const touched = v.length > 0;
    return passwordRules.map((r) => ({ ...r, ok: touched ? r.test(v) : false, touched }));
  }, [pwd]);

  const pwdAllOk = useMemo(() => {
    if (!pwd) return false;
    return passwordRules.every((r) => r.test(pwd));
  }, [pwd]);

  const pwdMatchOk = useMemo(() => {
    if (!pwd || !pwd2) return false;
    return pwd === pwd2;
  }, [pwd, pwd2]);

  const createUsernameOk = useMemo(() => {
    const u = (createUsername ?? '').trim();
    if (!u) return false;
    if (u.length < 4 || u.length > 32) return false;
    return /^[a-zA-Z0-9_]+$/.test(u);
  }, [createUsername]);

  const createPwdChecks = useMemo(() => {
    const v = createPwd ?? '';
    const touched = v.length > 0;
    return passwordRules.map((r) => ({ ...r, ok: touched ? r.test(v) : false, touched }));
  }, [createPwd]);

  const createPwdNonEmptyOk = useMemo(() => {
    return (createPwd ?? '').trim().length > 0;
  }, [createPwd]);

  const createPwdMatchOk = useMemo(() => {
    if (!createPwd || !createPwd2) return false;
    return createPwd === createPwd2;
  }, [createPwd, createPwd2]);

  const bulkPwdChecks = useMemo(() => {
    const v = bulkPwd ?? '';
    const touched = v.length > 0;
    return passwordRules.map((r) => ({ ...r, ok: touched ? r.test(v) : false, touched }));
  }, [bulkPwd]);

  const bulkPwdNonEmptyOk = useMemo(() => {
    return (bulkPwd ?? '').trim().length > 0;
  }, [bulkPwd]);

  const bulkPwdMatchOk = useMemo(() => {
    if (!bulkPwd || !bulkPwd2) return false;
    return bulkPwd === bulkPwd2;
  }, [bulkPwd, bulkPwd2]);

  const bulkUsernames = useMemo(() => {
    const prefix = (bulkPrefix ?? '').trim();
    const count = Math.max(1, Math.min(200, Math.floor(bulkCount || 1)));
    const start = Math.max(0, Math.floor(bulkStart || 0));
    if (!prefix) return [];
    const maxIndex = start + count - 1;
    const width = Math.max(2, String(maxIndex).length);
    const arr: string[] = [];
    for (let i = 0; i < count; i++) {
      arr.push(`${prefix}${String(start + i).padStart(width, '0')}`);
    }
    return arr;
  }, [bulkPrefix, bulkStart, bulkCount]);

  const bulkUsernamesOk = useMemo(() => {
    if (bulkUsernames.length === 0) return false;
    return bulkUsernames.every((u) => {
      if (u.length < 4 || u.length > 32) return false;
      return /^[a-zA-Z0-9_]+$/.test(u);
    });
  }, [bulkUsernames]);

  const query = useMemo(
    () => ({ page, pageSize: 20, search: search.trim() || undefined, role: role || undefined, status: status || undefined }),
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

  const onGenerate = async () => {
    const res = await generateInviteCodes(inviteCount);
    if (res.success) setInviteCodes(res.data.codes);
  };

  const onCopy = async (text: string) => {
    await navigator.clipboard.writeText(text);
  };

  const openCreateUser = () => {
    setCreateUsername('');
    setCreateDisplayName('');
    setCreateRole('DEV');
    setCreatePwd('');
    setCreatePwd2('');
    setCreateError(null);
    setCreateResult(null);
    setCreateSubmitting(false);
    setCreateOpen(true);
  };

  const submitCreateUser = async () => {
    if (!createUsernameOk) return;
    if (!createPwdNonEmptyOk) return;
    if (!createPwdMatchOk) return;

    setCreateSubmitting(true);
    setCreateError(null);
    try {
      const res = await createUser({
        username: createUsername.trim(),
        displayName: createDisplayName.trim() || undefined,
        role: createRole,
        password: createPwd,
      });
      if (!res.success) {
        setCreateError(res.error?.message || '创建失败');
        return;
      }
      setCreateResult({ userId: res.data.userId, username: res.data.username });
      await load();
    } finally {
      setCreateSubmitting(false);
    }
  };

  const openBulkCreate = () => {
    setBulkPrefix('');
    setBulkStart(1);
    setBulkCount(5);
    setBulkRole('DEV');
    setBulkPwd('');
    setBulkPwd2('');
    setBulkError(null);
    setBulkResult(null);
    setBulkSubmitting(false);
    setBulkOpen(true);
  };

  const submitBulkCreate = async () => {
    if (!bulkUsernamesOk) {
      setBulkError('生成的用户名不合法（需 4-32 位，仅字母/数字/下划线）');
      return;
    }
    if (!bulkPwdNonEmptyOk) return;
    if (!bulkPwdMatchOk) return;

    setBulkSubmitting(true);
    setBulkError(null);
    try {
      const items = bulkUsernames.map((u) => ({
        username: u,
        displayName: u,
        role: bulkRole,
        password: bulkPwd,
      }));
      const res = await bulkCreateUsers(items);
      if (!res.success) {
        setBulkError(res.error?.message || '批量创建失败');
        return;
      }
      setBulkResult(res.data);
      await load();
    } finally {
      setBulkSubmitting(false);
    }
  };

  const openChangePassword = (u: UserRow) => {
    setPwdUser(u);
    setPwd('');
    setPwd2('');
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
    if (!pwdAllOk) return;
    if (!pwdMatchOk) return;

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

      <Card className="flex-1 min-h-0 flex flex-col">
        <div className="flex flex-wrap items-center gap-2.5">
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

          <div className="ml-auto flex items-center gap-2 shrink-0 flex-wrap justify-end">
            <Button variant="secondary" size="xs" onClick={openCreateUser}>
              创建用户
            </Button>
            <Button variant="secondary" size="xs" onClick={openBulkCreate}>
              批量创建
            </Button>
            <Button
              variant="primary"
              size="xs"
              onClick={() => {
                setInviteOpen(true);
                setInviteCodes([]);
              }}
            >
              生成邀请码
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
            <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 items-stretch">
              {items.map((u) => {
                const last = u.lastActiveAt ?? u.lastLoginAt;
                const displayName = (u.displayName || u.username).trim();
                return (
                  <div
                    key={u.userId}
                    className="group h-full rounded-[14px] p-3.5 transition-all duration-200 hover:-translate-y-px"
                    style={{
                      background: 'rgba(255,255,255,0.02)',
                      border: '1px solid rgba(255,255,255,0.06)',
                      boxShadow: '0 2px 8px -2px rgba(0,0,0,0.2)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(255,255,255,0.035)';
                      e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
                      e.currentTarget.style.boxShadow = '0 4px 16px -4px rgba(0,0,0,0.3)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(255,255,255,0.02)';
                      e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)';
                      e.currentTarget.style.boxShadow = '0 2px 8px -2px rgba(0,0,0,0.2)';
                    }}
                  >
                    <div
                      className="h-full flex flex-col"
                      style={{ gap: 14 }}
                    >
                      {/* Header（强约束：左侧信息 + 右侧操作，避免窄卡片挤压导致“重叠”） */}
                      <div className="grid grid-cols-[1fr_auto] gap-3 items-start">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div
                            className="h-10 w-10 rounded-[12px] overflow-hidden shrink-0 cursor-pointer ring-1 ring-white/8 hover:ring-[var(--accent-gold)]/40 transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/50"
                            title="点击修改头像"
                            onClick={() => openChangeAvatar(u)}
                            role="button"
                            tabIndex={0}
                            aria-label="点击修改头像"
                            onKeyDown={(e) => {
                              if (e.key !== 'Enter' && e.key !== ' ') return;
                              e.preventDefault();
                              openChangeAvatar(u);
                            }}
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
                          </div>

                          <div className="min-w-0">
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className="inline-block h-2 w-2 rounded-full shrink-0"
                                style={{
                                  background: u.status === 'Active' ? 'rgba(34,197,94,0.95)' : 'rgba(247,247,251,0.28)',
                                  boxShadow: u.status === 'Active' ? '0 0 0 3px rgba(34,197,94,0.12)' : 'none',
                                }}
                                title={u.status === 'Active' ? '正常' : '已禁用'}
                                aria-label={u.status === 'Active' ? '正常' : '已禁用'}
                              />
                              <div
                                className="font-semibold truncate leading-5"
                                style={{ color: 'var(--text-primary)' }}
                                title={displayName}
                              >
                                {displayName}
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                {/* Robot tag icon */}
                                {String(u.userType ?? '').toLowerCase() === 'bot' ? (
                                  <span
                                    className="inline-flex items-center justify-center h-5 w-5 rounded-[8px]"
                                    style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.2)', color: 'rgba(34,197,94,0.9)' }}
                                    title="机器人"
                                  >
                                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                                      <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 3v2m-6 7a6 6 0 0112 0v5a3 3 0 01-3 3H9a3 3 0 01-3-3v-5z" />
                                      <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M8 13h.01M16 13h.01" />
                                    </svg>
                                  </span>
                                ) : null}
                                {/* Admin tag icon */}
                                {String(u.role ?? '').toUpperCase() === 'ADMIN' ? (
                                  <span
                                    className="inline-flex items-center justify-center h-5 w-5 rounded-[8px]"
                                    style={{ background: 'rgba(214,178,106,0.1)', border: '1px solid rgba(214,178,106,0.2)', color: 'var(--accent-gold)' }}
                                    title="系统管理员"
                                  >
                                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                                      <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 2l7 4v6c0 5-3 9-7 10-4-1-7-5-7-10V6l7-4z" />
                                    </svg>
                                  </span>
                                ) : null}
                              </div>
                            </div>

                            <div className="mt-1 flex flex-col gap-1 min-w-0">
                              <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }} title={`用户名：${u.username}`}>
                                @{u.username}
                              </div>
                              <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }} title={u.userId}>
                                ID: {u.userId}
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center justify-end gap-1.5 shrink-0">
                          <Button
                            variant={u.status === 'Active' ? 'secondary' : 'primary'}
                            size="xs"
                            disabled={statusUpdatingUserId === u.userId || roleUpdatingUserId === u.userId}
                            onClick={() => onToggleStatus(u)}
                            title={u.status === 'Active' ? '点击停用' : '点击启用'}
                            aria-label={u.status === 'Active' ? '停用' : '启用'}
                            className="min-w-[56px] text-[11px]"
                          >
                            {statusUpdatingUserId === u.userId ? '...' : u.status === 'Active' ? '停用' : '启用'}
                          </Button>

                          <DropdownMenu.Root>
                            <DropdownMenu.Trigger asChild>
                              <button
                                type="button"
                                className="inline-flex items-center justify-center h-[28px] w-[28px] rounded-[8px] transition-colors hover:bg-white/6 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/30"
                                style={{ border: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-muted)' }}
                                aria-label="更多操作"
                                title="更多操作"
                              >
                                <MoreVertical size={16} />
                              </button>
                            </DropdownMenu.Trigger>
                            <DropdownMenu.Portal>
                            <DropdownMenu.Content
                              side="bottom"
                              align="end"
                              sideOffset={8}
                              className="rounded-[12px] p-1 min-w-[180px]"
                              style={{
                                zIndex: 90,
                                background: 'var(--bg-elevated)',
                                border: '1px solid var(--border-subtle)',
                                boxShadow: 'var(--shadow-lg)',
                              }}
                            >
                              {isLockedUser(u) && (
                                <DropdownMenu.Item
                                  className="flex items-center gap-2 rounded-[8px] px-3 py-2 text-sm outline-none cursor-pointer hover:bg-white/5"
                                  style={{ color: 'var(--text-primary)' }}
                                  disabled={unlockingUserId === u.userId}
                                  onSelect={(e) => {
                                    e.preventDefault();
                                    onUnlock(u);
                                  }}
                                  title={
                                    typeof u.lockoutRemainingSeconds === 'number' && u.lockoutRemainingSeconds > 0
                                      ? `当前锁定剩余 ${u.lockoutRemainingSeconds} 秒`
                                      : '解除登录锁定'
                                  }
                                >
                                  {unlockingUserId === u.userId ? '解除锁定（处理中…）' : '解除锁定'}
                                </DropdownMenu.Item>
                              )}
                              {isHumanUser(u) && (
                                <DropdownMenu.Item
                                  className="flex items-center gap-2 rounded-[8px] px-3 py-2 text-sm outline-none cursor-pointer hover:bg-white/5"
                                  style={{ color: 'var(--text-primary)' }}
                                  onSelect={(e) => {
                                    e.preventDefault();
                                    openChangeDisplayName(u);
                                  }}
                                >
                                  <Pencil size={14} />
                                  修改姓名
                                </DropdownMenu.Item>
                              )}
                              <DropdownMenu.Item
                                className="flex items-center gap-2 rounded-[8px] px-3 py-2 text-sm outline-none cursor-pointer hover:bg-white/5"
                                style={{ color: 'var(--text-primary)' }}
                                onSelect={(e) => {
                                  e.preventDefault();
                                  openForceExpire(u);
                                }}
                              >
                                一键过期
                              </DropdownMenu.Item>
                              <DropdownMenu.Item
                                className="flex items-center gap-2 rounded-[8px] px-3 py-2 text-sm outline-none cursor-pointer hover:bg-white/5"
                                style={{ color: 'var(--text-primary)' }}
                                onSelect={(e) => {
                                  e.preventDefault();
                                  openChangeAvatar(u);
                                }}
                              >
                                修改头像
                              </DropdownMenu.Item>
                              <DropdownMenu.Item
                                className="flex items-center gap-2 rounded-[8px] px-3 py-2 text-sm outline-none cursor-pointer hover:bg-white/5"
                                style={{ color: 'var(--text-primary)' }}
                                onSelect={(e) => {
                                  e.preventDefault();
                                  openChangePassword(u);
                                }}
                              >
                                修改密码
                              </DropdownMenu.Item>

                              {canAuthzManage ? (
                                <DropdownMenu.Item
                                  className="flex items-center gap-2 rounded-[8px] px-3 py-2 text-sm outline-none cursor-pointer hover:bg-white/5"
                                  style={{ color: 'var(--text-primary)' }}
                                  onSelect={(e) => {
                                    e.preventDefault();
                                    void openUserAuthz(u);
                                  }}
                                >
                                  后台菜单权限
                                </DropdownMenu.Item>
                              ) : null}
                              <DropdownMenu.Item
                                className="flex items-center gap-2 rounded-[8px] px-3 py-2 text-sm outline-none cursor-pointer hover:bg-white/5"
                                style={{ color: 'var(--text-primary)' }}
                                onSelect={(e) => {
                                  e.preventDefault();
                                  void openRateLimitConfig(u);
                                }}
                              >
                                <Gauge size={14} />
                                限流配置
                              </DropdownMenu.Item>

                              <DropdownMenu.Separator className="h-px my-1" style={{ background: 'rgba(255,255,255,0.08)' }} />

                              <DropdownMenu.Item
                                className="flex items-center gap-2 rounded-[8px] px-3 py-2 text-sm outline-none cursor-pointer hover:bg-white/5"
                                style={{ color: 'var(--text-primary)' }}
                                disabled={switchingUserId === u.userId}
                                onSelect={(e) => {
                                  e.preventDefault();
                                  onSwitchToUser(u);
                                }}
                              >
                                <UserCog size={14} />
                                {switchingUserId === u.userId ? '切换中...' : '切换到该用户登录'}
                              </DropdownMenu.Item>

                              <DropdownMenu.Separator className="h-px my-1" style={{ background: 'rgba(255,255,255,0.08)' }} />

                              <DropdownMenu.Item
                                className="flex items-center gap-2 rounded-[8px] px-3 py-2 text-sm outline-none cursor-pointer hover:bg-white/5"
                                style={{ color: 'var(--text-primary)' }}
                                onSelect={(e) => {
                                  e.preventDefault();
                                  navigate(`/logs?tab=llm&userId=${encodeURIComponent(u.userId)}`);
                                }}
                              >
                                查看 LLM 请求日志
                              </DropdownMenu.Item>
                              <DropdownMenu.Item
                                className="flex items-center gap-2 rounded-[8px] px-3 py-2 text-sm outline-none cursor-pointer hover:bg-white/5"
                                style={{ color: 'var(--text-primary)' }}
                                onSelect={(e) => {
                                  e.preventDefault();
                                  navigate(`/logs?tab=system&userId=${encodeURIComponent(u.userId)}`);
                                }}
                              >
                                查看 系统请求日志
                              </DropdownMenu.Item>
                              <DropdownMenu.Arrow
                                className="fill-[color:var(--bg-elevated)]"
                                style={{ filter: 'drop-shadow(0 1px 0 rgba(255,255,255,0.10))' }}
                              />
                            </DropdownMenu.Content>
                          </DropdownMenu.Portal>
                          </DropdownMenu.Root>
                        </div>
                      </div>

                      {/* Role */}
                      <div
                        className="rounded-[14px] p-2"
                        style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.08)' }}
                      >
                        <div className="grid grid-cols-4 gap-1">
                          {(['PM', 'DEV', 'QA', 'ADMIN'] as const).map((r) => {
                            const active = u.role === r;
                            const disabled = roleUpdatingUserId === u.userId || statusUpdatingUserId === u.userId;
                            return (
                              <button
                                key={r}
                                type="button"
                                className="h-[30px] rounded-[10px] text-[12px] font-semibold transition-colors inline-flex items-center justify-center disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
                                style={{
                                  color: active ? 'rgba(250,204,21,0.95)' : 'var(--text-primary)',
                                  background: active ? 'rgba(250,204,21,0.10)' : 'transparent',
                                  border: active ? '1px solid rgba(250,204,21,0.35)' : '1px solid transparent',
                                }}
                                aria-pressed={active}
                                disabled={disabled}
                                onClick={() => onSetRole(u, r)}
                              >
                                {r}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Footer */}
                      <div className="flex items-end justify-between gap-3">
                        <div className="min-w-0" />
                        {!last ? (
                          <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                            暂无操作记录
                          </div>
                        ) : (
                          <div className="text-right min-w-0">
                            {(() => {
                              const abs = fmtDateTime(last);
                              const rel = fmtRelative(last);
                              const primary = rel || abs;
                              const secondary = rel ? abs : '';
                              return (
                                <div className="flex flex-col items-end">
                                  <div
                                    className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-semibold"
                                    style={{
                                      background: 'rgba(255,255,255,0.03)',
                                      border: '1px solid rgba(255,255,255,0.10)',
                                      color: 'var(--text-secondary)',
                                    }}
                                    title={abs}
                                  >
                                    <Clock size={12} style={{ color: 'var(--text-muted)' }} />
                                    <span className="truncate">{primary}</span>
                                  </div>
                                  {secondary ? (
                                    <div
                                      className="mt-1 text-[11px] truncate opacity-0 group-hover:opacity-100 transition-opacity duration-200"
                                      style={{ color: 'var(--text-muted)' }}
                                    >
                                      {secondary}
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })()}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="mt-4 pt-4 flex items-center justify-between border-t border-white/10">
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>第 {page} 页 / 共 {Math.max(1, Math.ceil(total / 20))} 页</div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= Math.ceil(total / 20)}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </Button>
          </div>
        </div>
      </Card>

      <Dialog
        open={createOpen}
        onOpenChange={(v) => {
          setCreateOpen(v);
          if (!v) {
            setCreateUsername('');
            setCreateDisplayName('');
            setCreateRole('DEV');
            setCreatePwd('');
            setCreatePwd2('');
            setCreateError(null);
            setCreateResult(null);
            setCreateSubmitting(false);
          }
        }}
        title="创建用户"
        description="创建账号（用户名）+ 密码 + 角色"
        content={
          <div className="space-y-4">
            <div className="grid gap-3">
              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>用户名</div>
                <input
                  value={createUsername}
                  onChange={(e) => {
                    setCreateUsername(e.target.value);
                    setCreateError(null);
                    setCreateResult(null);
                  }}
                  className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                  placeholder="4-32 位，仅字母/数字/下划线"
                  autoComplete="off"
                />
              </div>

              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>显示名称（可选）</div>
                <input
                  value={createDisplayName}
                  onChange={(e) => {
                    setCreateDisplayName(e.target.value);
                    setCreateError(null);
                    setCreateResult(null);
                  }}
                  className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                  placeholder="默认同用户名（上限 50）"
                  autoComplete="off"
                />
              </div>

              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>角色</div>
                <select
                  value={createRole}
                  onChange={(e) => setCreateRole(e.target.value as UserRow['role'])}
                  className="mt-2 h-10 w-full rounded-[14px] px-3 text-sm"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                >
                  <option value="PM">PM</option>
                  <option value="DEV">DEV</option>
                  <option value="QA">QA</option>
                  <option value="ADMIN">ADMIN</option>
                </select>
              </div>

              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>密码</div>
                <input
                  value={createPwd}
                  onChange={(e) => {
                    setCreatePwd(e.target.value);
                    setCreateError(null);
                    setCreateResult(null);
                  }}
                  type="password"
                  className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                  placeholder="任意非空（强烈建议使用复杂密码）"
                  autoComplete="new-password"
                />
              </div>

              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>确认密码</div>
                <input
                  value={createPwd2}
                  onChange={(e) => {
                    setCreatePwd2(e.target.value);
                    setCreateError(null);
                    setCreateResult(null);
                  }}
                  type="password"
                  className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                  placeholder="再次输入密码"
                  autoComplete="new-password"
                />
              </div>
            </div>

            <div
              className="rounded-[16px] px-4 py-3"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)' }}
            >
              <div className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>密码建议（不影响创建）</div>
              <div className="mt-2 grid gap-1">
                {createPwdChecks.map((r) => {
                  const ok = r.touched ? r.ok : false;
                  const state: 'todo' | 'ok' | 'bad' = !r.touched ? 'todo' : ok ? 'ok' : 'bad';
                  const color = state === 'ok' ? 'rgba(34,197,94,0.95)' : state === 'bad' ? 'rgba(239,68,68,0.95)' : 'var(--text-muted)';
                  const Icon = state === 'ok' ? CheckCircle2 : state === 'bad' ? XCircle : Circle;
                  return (
                    <div key={r.key} className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
                      <Icon size={16} style={{ color }} />
                      <span style={{ color: 'var(--text-primary)' }}>{r.label}</span>
                    </div>
                  );
                })}
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
                  {createPwd2.length === 0 ? (
                    <Circle size={16} style={{ color: 'var(--text-muted)' }} />
                  ) : createPwdMatchOk ? (
                    <CheckCircle2 size={16} style={{ color: 'rgba(34,197,94,0.95)' }} />
                  ) : (
                    <XCircle size={16} style={{ color: 'rgba(239,68,68,0.95)' }} />
                  )}
                  <span style={{ color: 'var(--text-primary)' }}>两次输入一致</span>
                </div>
              </div>
            </div>

            {!createUsernameOk && createUsername.trim().length > 0 && (
              <div className="text-sm" style={{ color: 'rgba(239,68,68,0.95)' }}>
                用户名不合法：4-32 位，仅字母/数字/下划线
              </div>
            )}

            {createResult && (
              <div
                className="rounded-[14px] px-4 py-3 text-sm"
                style={{ background: 'rgba(34,197,94,0.10)', border: '1px solid rgba(34,197,94,0.28)', color: 'rgba(34,197,94,0.95)' }}
              >
                已创建：{createResult.username}（{createResult.userId}）
              </div>
            )}

            {createError && (
              <div
                className="rounded-[14px] px-4 py-3 text-sm"
                style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.28)', color: 'rgba(239,68,68,0.95)' }}
              >
                {createError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)} disabled={createSubmitting}>
                取消
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={submitCreateUser}
                disabled={createSubmitting || !createUsernameOk || !createPwdNonEmptyOk || !createPwdMatchOk}
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
        open={bulkOpen}
        onOpenChange={(v) => {
          setBulkOpen(v);
          if (!v) {
            setBulkPrefix('');
            setBulkStart(1);
            setBulkCount(5);
            setBulkRole('DEV');
            setBulkPwd('');
            setBulkPwd2('');
            setBulkError(null);
            setBulkResult(null);
            setBulkSubmitting(false);
          }
        }}
        title="批量创建用户"
        description="按前缀 + 数量生成用户名，统一密码与角色"
        maxWidth={900}
        content={
          <div className="space-y-4">
            <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 140px 140px 180px' }}>
              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>用户名前缀</div>
                <input
                  value={bulkPrefix}
                  onChange={(e) => {
                    setBulkPrefix(e.target.value);
                    setBulkError(null);
                    setBulkResult(null);
                  }}
                  className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                  placeholder="例如 dev_"
                  autoComplete="off"
                />
              </div>
              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>起始编号</div>
                <input
                  type="number"
                  min={0}
                  value={bulkStart}
                  onChange={(e) => {
                    setBulkStart(Number(e.target.value || 0));
                    setBulkError(null);
                    setBulkResult(null);
                  }}
                  className="mt-2 h-10 w-full rounded-[14px] px-3 text-sm outline-none"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                />
              </div>
              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>数量</div>
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={bulkCount}
                  onChange={(e) => {
                    setBulkCount(Number(e.target.value || 1));
                    setBulkError(null);
                    setBulkResult(null);
                  }}
                  className="mt-2 h-10 w-full rounded-[14px] px-3 text-sm outline-none"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                />
              </div>
              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>角色</div>
                <select
                  value={bulkRole}
                  onChange={(e) => setBulkRole(e.target.value as UserRow['role'])}
                  className="mt-2 h-10 w-full rounded-[14px] px-3 text-sm"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                >
                  <option value="PM">PM</option>
                  <option value="DEV">DEV</option>
                  <option value="QA">QA</option>
                  <option value="ADMIN">ADMIN</option>
                </select>
              </div>
            </div>

            <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>统一密码</div>
                <input
                  value={bulkPwd}
                  onChange={(e) => {
                    setBulkPwd(e.target.value);
                    setBulkError(null);
                    setBulkResult(null);
                  }}
                  type="password"
                  className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                  placeholder="任意非空（强烈建议使用复杂密码）"
                  autoComplete="new-password"
                />
              </div>
              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>确认密码</div>
                <input
                  value={bulkPwd2}
                  onChange={(e) => {
                    setBulkPwd2(e.target.value);
                    setBulkError(null);
                    setBulkResult(null);
                  }}
                  type="password"
                  className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                  placeholder="再次输入密码"
                  autoComplete="new-password"
                />
              </div>
            </div>

            <div
              className="rounded-[16px] px-4 py-3"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)' }}
            >
              <div className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>预览（最多显示前 30 条）</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {bulkUsernames.slice(0, 30).map((u) => (
                  <code
                    key={u}
                    className="rounded-[10px] px-2 py-1 text-[12px]"
                    style={{ background: 'rgba(0,0,0,0.16)', border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-primary)' }}
                  >
                    {u}
                  </code>
                ))}
                {bulkUsernames.length > 30 && (
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>… 共 {bulkUsernames.length} 条</span>
                )}
              </div>
              {!bulkUsernamesOk && bulkUsernames.length > 0 && (
                <div className="mt-2 text-sm" style={{ color: 'rgba(239,68,68,0.95)' }}>
                  生成的用户名不合法：4-32 位，仅字母/数字/下划线（请检查前缀与长度）
                </div>
              )}
            </div>

            <div
              className="rounded-[16px] px-4 py-3"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)' }}
            >
              <div className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>密码建议（不影响创建）</div>
              <div className="mt-2 grid gap-1">
                {bulkPwdChecks.map((r) => {
                  const ok2 = r.touched ? r.ok : false;
                  const state: 'todo' | 'ok' | 'bad' = !r.touched ? 'todo' : ok2 ? 'ok' : 'bad';
                  const color = state === 'ok' ? 'rgba(34,197,94,0.95)' : state === 'bad' ? 'rgba(239,68,68,0.95)' : 'var(--text-muted)';
                  const Icon = state === 'ok' ? CheckCircle2 : state === 'bad' ? XCircle : Circle;
                  return (
                    <div key={r.key} className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
                      <Icon size={16} style={{ color }} />
                      <span style={{ color: 'var(--text-primary)' }}>{r.label}</span>
                    </div>
                  );
                })}
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
                  {bulkPwd2.length === 0 ? (
                    <Circle size={16} style={{ color: 'var(--text-muted)' }} />
                  ) : bulkPwdMatchOk ? (
                    <CheckCircle2 size={16} style={{ color: 'rgba(34,197,94,0.95)' }} />
                  ) : (
                    <XCircle size={16} style={{ color: 'rgba(239,68,68,0.95)' }} />
                  )}
                  <span style={{ color: 'var(--text-primary)' }}>两次输入一致</span>
                </div>
              </div>
            </div>

            {bulkResult && (
              <div
                className="rounded-[14px] px-4 py-3 text-sm"
                style={{ background: 'rgba(34,197,94,0.10)', border: '1px solid rgba(34,197,94,0.28)', color: 'rgba(34,197,94,0.95)' }}
              >
                批量创建完成：成功 {bulkResult.createdCount} 个，失败 {bulkResult.failedCount} 个（请求 {bulkResult.requestedCount} 个）
              </div>
            )}

            {bulkError && (
              <div
                className="rounded-[14px] px-4 py-3 text-sm"
                style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.28)', color: 'rgba(239,68,68,0.95)' }}
              >
                {bulkError}
              </div>
            )}

            {bulkResult?.failedItems?.length ? (
              <div
                className="rounded-[16px] px-4 py-3"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)' }}
              >
                <div className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>失败明细（最多显示前 50 条）</div>
                <div className="mt-2 grid gap-1">
                  {bulkResult.failedItems.slice(0, 50).map((x) => (
                    <div key={`${x.username}:${x.code}:${x.message}`} className="text-sm" style={{ color: 'var(--text-primary)' }}>
                      <span style={{ color: 'rgba(239,68,68,0.95)' }}>{x.username || '(空)'}</span>
                      <span style={{ color: 'var(--text-muted)' }}> · {x.code}</span>
                      <span style={{ color: 'var(--text-muted)' }}> · {x.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-2 pt-1">
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={bulkUsernames.length === 0}
                  onClick={() => onCopy(bulkUsernames.join('\n'))}
                >
                  复制账号清单
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={bulkUsernames.length === 0 || !bulkPwd}
                  onClick={() => onCopy(bulkUsernames.map((u) => `${u}\t${bulkPwd}`).join('\n'))}
                >
                  复制账号+密码
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setBulkOpen(false)} disabled={bulkSubmitting}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={submitBulkCreate}
                  disabled={bulkSubmitting || !bulkUsernamesOk || !bulkPwdNonEmptyOk || !bulkPwdMatchOk}
                >
                  {bulkSubmitting ? '创建中...' : '确认创建'}
                </Button>
              </div>
            </div>
          </div>
        }
      />

      <Dialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        title="生成邀请码"
        description="生成后可复制分发"
        content={
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={1}
                max={50}
                value={inviteCount}
                onChange={(e) => setInviteCount(Number(e.target.value || 1))}
                className="h-10 w-[120px] rounded-[14px] px-3 text-sm outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
              />
              <Button variant="secondary" size="sm" onClick={onGenerate}>
                生成
              </Button>
            </div>

            {inviteCodes.length > 0 && (
              <div className="grid gap-2">
                {inviteCodes.map((code) => (
                  <div
                    key={code}
                    className="flex items-center justify-between rounded-[14px] px-4 py-3"
                    style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)' }}
                  >
                    <code className="text-sm" style={{ color: 'var(--accent-green)' }}>{code}</code>
                    <Button variant="secondary" size="sm" onClick={() => onCopy(code)}>
                      复制
                    </Button>
                  </div>
                ))}
              </div>
            )}
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
            setPwd2('');
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
                placeholder="至少8位，含大小写、数字、特殊字符"
                autoComplete="new-password"
              />
            </div>

            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>确认新密码</div>
              <input
                value={pwd2}
                onChange={(e) => {
                  setPwd2(e.target.value);
                  setPwdSubmitError(null);
                }}
                type="password"
                className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                placeholder="再次输入新密码"
                autoComplete="new-password"
              />
            </div>

            <div
              className="rounded-[16px] px-4 py-3"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)' }}
            >
              <div className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>密码要求（实时校验）</div>
              <div className="mt-2 rounded-[14px]" style={{ background: 'rgba(0,0,0,0.10)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <ul className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
                  {pwdChecks.map((r) => {
                    const ok = r.touched ? r.ok : false;
                    const state: 'todo' | 'ok' | 'bad' = !r.touched ? 'todo' : ok ? 'ok' : 'bad';
                    const color = state === 'ok' ? 'rgba(34,197,94,0.95)' : state === 'bad' ? 'rgba(239,68,68,0.95)' : 'var(--text-muted)';
                    const Icon = state === 'ok' ? CheckCircle2 : state === 'bad' ? XCircle : Circle;
                    const statusText = state === 'ok' ? '通过' : state === 'bad' ? '未通过' : '待输入';
                    const statusBg =
                      state === 'ok'
                        ? 'rgba(34,197,94,0.10)'
                        : state === 'bad'
                          ? 'rgba(239,68,68,0.10)'
                          : 'rgba(255,255,255,0.03)';
                    const statusBorder =
                      state === 'ok'
                        ? 'rgba(34,197,94,0.28)'
                        : state === 'bad'
                          ? 'rgba(239,68,68,0.28)'
                          : 'rgba(255,255,255,0.10)';

                    return (
                      <li key={r.key} className="flex items-center justify-between gap-3 px-3 py-2.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <Icon size={16} style={{ color }} />
                          <div className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>
                            {r.label}
                          </div>
                        </div>
                        <span
                          className="shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold"
                          style={{ color, background: statusBg, border: `1px solid ${statusBorder}` }}
                        >
                          {statusText}
                        </span>
                      </li>
                    );
                  })}

                  {(() => {
                    const state: 'todo' | 'ok' | 'bad' = pwd2.length === 0 ? 'todo' : pwdMatchOk ? 'ok' : 'bad';
                    const color = state === 'ok' ? 'rgba(34,197,94,0.95)' : state === 'bad' ? 'rgba(239,68,68,0.95)' : 'var(--text-muted)';
                    const Icon = state === 'ok' ? CheckCircle2 : state === 'bad' ? XCircle : Circle;
                    const statusText = state === 'ok' ? '通过' : state === 'bad' ? '未通过' : '待输入';
                    const statusBg =
                      state === 'ok'
                        ? 'rgba(34,197,94,0.10)'
                        : state === 'bad'
                          ? 'rgba(239,68,68,0.10)'
                          : 'rgba(255,255,255,0.03)';
                    const statusBorder =
                      state === 'ok'
                        ? 'rgba(34,197,94,0.28)'
                        : state === 'bad'
                          ? 'rgba(239,68,68,0.28)'
                          : 'rgba(255,255,255,0.10)';

                    return (
                      <li className="flex items-center justify-between gap-3 px-3 py-2.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <Icon size={16} style={{ color }} />
                          <div className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>
                            两次输入一致
                          </div>
                        </div>
                        <span
                          className="shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold"
                          style={{ color, background: statusBg, border: `1px solid ${statusBorder}` }}
                        >
                          {statusText}
                        </span>
                      </li>
                    );
                  })()}
                </ul>
              </div>
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
                disabled={pwdSubmitting || !pwdAllOk || !pwdMatchOk}
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
              <select
                value={authzSystemRoleKey}
                onChange={(e) => setAuthzSystemRoleKey(e.target.value)}
                disabled={authzLoading || authzSaving}
                className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
              >
                {authzSystemRoles.map((r) => (
                  <option key={r.key} value={r.key}>{r.name}（{r.key}）</option>
                ))}
                {authzSystemRoles.length === 0 ? <option value="none">无权限（none）</option> : null}
              </select>
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
