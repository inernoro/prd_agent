import { usePrdSessionStore } from '../../stores/prdSessionStore';
import { UserRole } from '../../types';
import { IconUser, IconCode, IconBug } from '@arco-design/web-react/icon';

const roles: { value: UserRole; label: string; icon: React.ReactNode; color: string }[] = [
  { value: 'PM', label: '产品', icon: <IconUser />, color: 'var(--accent)' },
  { value: 'DEV', label: '开发', icon: <IconCode />, color: '#22c55e' },
  { value: 'QA', label: '测试', icon: <IconBug />, color: '#f59e0b' },
];

export default function RoleSelector() {
  const { currentRole, setRole } = usePrdSessionStore();

  return (
    <div 
      className="flex items-center gap-1 p-1"
      style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-md)' }}
    >
      {roles.map((role) => (
        <button
          key={role.value}
          onClick={() => setRole(role.value)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            borderRadius: 'var(--radius-sm)',
            fontSize: 13,
            fontWeight: 500,
            border: 'none',
            cursor: 'pointer',
            transition: 'all var(--duration-fast) var(--ease-out)',
            background: currentRole === role.value ? role.color : 'transparent',
            color: currentRole === role.value ? '#fff' : 'var(--text-muted)',
          }}
        >
          {role.icon}
          <span>{role.label}</span>
        </button>
      ))}
    </div>
  );
}

