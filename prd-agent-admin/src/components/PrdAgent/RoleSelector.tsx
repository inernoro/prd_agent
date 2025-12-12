import { usePrdSessionStore } from '../../stores/prdSessionStore';
import { UserRole } from '../../types';
import { UserOutlined, CodeOutlined, BugOutlined } from '@ant-design/icons';

const roles: { value: UserRole; label: string; icon: React.ReactNode; color: string }[] = [
  { value: 'PM', label: '产品', icon: <UserOutlined />, color: 'from-blue-500 to-cyan-500' },
  { value: 'DEV', label: '开发', icon: <CodeOutlined />, color: 'from-green-500 to-emerald-500' },
  { value: 'QA', label: '测试', icon: <BugOutlined />, color: 'from-orange-500 to-yellow-500' },
];

export default function RoleSelector() {
  const { currentRole, setRole } = usePrdSessionStore();

  return (
    <div className="flex items-center gap-1 p-1 bg-white/5 rounded-lg">
      {roles.map((role) => (
        <button
          key={role.value}
          onClick={() => setRole(role.value)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200 ${
            currentRole === role.value
              ? `bg-gradient-to-r ${role.color} text-white shadow-lg`
              : 'text-gray-400 hover:text-white hover:bg-white/5'
          }`}
        >
          {role.icon}
          <span>{role.label}</span>
        </button>
      ))}
    </div>
  );
}

