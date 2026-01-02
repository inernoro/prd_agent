import { invoke } from '../../lib/tauri';
import { useSessionStore } from '../../stores/sessionStore';
import { useAuthStore } from '../../stores/authStore';
import { UserRole, ApiResponse } from '../../types';

// 角色图标组件
const RoleIcon = ({ role, className }: { role: UserRole; className?: string }) => {
  switch (role) {
    case 'PM':
      return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
        </svg>
      );
    case 'DEV':
      return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
        </svg>
      );
    case 'QA':
      return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
    default:
      return null;
  }
};

const roles: { value: UserRole; label: string }[] = [
  { value: 'PM', label: '产品经理' },
  { value: 'DEV', label: '开发' },
  { value: 'QA', label: '测试' },
];

export default function RoleSelector() {
  const { sessionId, currentRole, setRole } = useSessionStore();
  const { user } = useAuthStore();

  // 检测是否为演示模式
  const isDemoMode = user?.userId === 'demo-user-001';

  const handleChange = async (role: UserRole) => {
    if (!sessionId || role === currentRole) return;

    // 演示模式：直接切换角色
    if (isDemoMode) {
      setRole(role);
      return;
    }

    try {
      const response = await invoke<ApiResponse<{ currentRole: string }>>('switch_role', {
        sessionId,
        role: role.toLowerCase(),
      });

      if (response.success) {
        setRole(role);
      }
    } catch (err) {
      console.error('Failed to switch role:', err);
    }
  };

  return (
    <div className="flex items-center gap-1 ui-chip p-1">
      {roles.map(({ value, label }) => (
        <button
          key={value}
          onClick={() => handleChange(value)}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors flex items-center gap-1.5 ${
            currentRole === value
              ? 'bg-primary-500 text-white'
              : 'text-text-secondary hover:bg-black/5 dark:hover:bg-white/5'
          }`}
        >
          <RoleIcon role={value} className="w-4 h-4" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
