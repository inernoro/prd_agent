import { invoke } from '@tauri-apps/api/core';
import { useSessionStore } from '../../stores/sessionStore';
import { UserRole, ApiResponse } from '../../types';

const roles: { value: UserRole; label: string; icon: string }[] = [
  { value: 'PM', label: '产品经理', icon: '📋' },
  { value: 'DEV', label: '开发', icon: '💻' },
  { value: 'QA', label: '测试', icon: '🧪' },
];

export default function RoleSelector() {
  const { sessionId, currentRole, setRole } = useSessionStore();

  const handleChange = async (role: UserRole) => {
    if (!sessionId || role === currentRole) return;

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
    <div className="flex items-center gap-1 bg-background-light dark:bg-background-dark rounded-lg p-1">
      {roles.map(({ value, label, icon }) => (
        <button
          key={value}
          onClick={() => handleChange(value)}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors flex items-center gap-1.5 ${
            currentRole === value
              ? 'bg-primary-500 text-white'
              : 'text-text-secondary hover:bg-gray-100 dark:hover:bg-gray-800'
          }`}
        >
          <span>{icon}</span>
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

