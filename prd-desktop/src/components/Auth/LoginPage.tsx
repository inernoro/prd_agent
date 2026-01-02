import { useState } from 'react';
import { invoke, isTauri } from '../../lib/tauri';
import { useAuthStore } from '../../stores/authStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { ApiResponse, User } from '../../types';
import SettingsModal from '../Settings/SettingsModal';

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  sessionKey: string;
  clientType: string;
  expiresIn: number;
  user: User;
}

export default function LoginPage() {
  const { login } = useAuthStore();
  const { openModal } = useSettingsStore();
  const [isLogin, setIsLogin] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  
  const [form, setForm] = useState({
    username: '',
    password: '',
    inviteCode: '',
    role: 'DEV' as 'PM' | 'DEV' | 'QA',
    displayName: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (!isTauri()) {
        setError('当前页面运行在浏览器环境，无法登录。请使用桌面窗口启动，或点击“演示模式”。');
        return;
      }
      if (isLogin) {
        const response = await invoke<ApiResponse<LoginResponse>>('login', {
          username: form.username,
          password: form.password,
        });

        if (response.success && response.data) {
          login(response.data.user, {
            accessToken: response.data.accessToken,
            refreshToken: response.data.refreshToken,
            sessionKey: response.data.sessionKey,
          });
        } else {
          setError(response.error?.message || '登录失败');
        }
      } else {
        const response = await invoke<ApiResponse<{ userId: string }>>('register', {
          username: form.username,
          password: form.password,
          inviteCode: form.inviteCode,
          role: form.role,
          displayName: form.displayName || undefined,
        });

        if (response.success) {
          setIsLogin(true);
          setError('');
          alert('注册成功，请登录');
        } else {
          setError(response.error?.message || '注册失败');
        }
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  // 演示模式：跳过登录，使用模拟用户
  const handleDemoMode = () => {
    const demoUser: User = {
      userId: 'demo-user-001',
      username: 'demo',
      displayName: '演示用户',
      role: 'PM',
    };
    login(demoUser, { accessToken: 'demo-token', refreshToken: 'demo-refresh', sessionKey: 'demo-session' });
  };

  return (
    <div className="h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 relative">
      {/* 右上角设置按钮 */}
      <button
        onClick={openModal}
        className="absolute top-4 right-4 p-2.5 rounded-xl ui-glass-panel hover:bg-white/10 transition-all hover:scale-105"
        title="设置"
      >
        <svg className="w-5 h-5 text-white/80" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>

      {/* 设置模态框 */}
      <SettingsModal />

      <div className="w-full max-w-md p-8 ui-glass-modal">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-to-r from-cyan-400 to-purple-500 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <span className="text-white font-bold text-2xl">P</span>
          </div>
          <h1 className="text-2xl font-bold text-white">PRD Agent</h1>
          <p className="text-white/60 text-sm mt-2">智能PRD解读助手</p>
        </div>

        <div className="flex mb-6">
          <button
            className={`flex-1 py-2 text-sm font-medium transition-colors ${isLogin ? 'text-white border-b-2 border-cyan-400' : 'text-white/50'}`}
            onClick={() => setIsLogin(true)}
          >
            登录
          </button>
          <button
            className={`flex-1 py-2 text-sm font-medium transition-colors ${!isLogin ? 'text-white border-b-2 border-cyan-400' : 'text-white/50'}`}
            onClick={() => setIsLogin(false)}
          >
            注册
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-200 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            placeholder="用户名"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            className="w-full px-4 py-3 ui-control transition-colors"
            required
          />
          
          <input
            type="password"
            placeholder="密码"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="w-full px-4 py-3 ui-control transition-colors"
            required
          />

          {!isLogin && (
            <>
              <input
                type="text"
                placeholder="邀请码"
                value={form.inviteCode}
                onChange={(e) => setForm({ ...form, inviteCode: e.target.value })}
                className="w-full px-4 py-3 ui-control transition-colors"
                required
              />
              
              <select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value as 'PM' | 'DEV' | 'QA' })}
                className="w-full px-4 py-3 ui-control transition-colors"
              >
                <option value="PM" className="bg-slate-800">产品经理</option>
                <option value="DEV" className="bg-slate-800">开发工程师</option>
                <option value="QA" className="bg-slate-800">测试工程师</option>
              </select>

              <input
                type="text"
                placeholder="显示名称（可选）"
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                className="w-full px-4 py-3 ui-control transition-colors"
              />
            </>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-gradient-to-r from-cyan-500 to-purple-500 text-white font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {loading ? '请稍候...' : isLogin ? '登录' : '注册'}
          </button>
        </form>

        {/* 演示模式分隔线 */}
        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-white/20"></div>
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="px-2 bg-transparent text-white/40">或</span>
          </div>
        </div>

        {/* 演示模式按钮 */}
        <button
          onClick={handleDemoMode}
          className="w-full py-3 bg-white/10 border border-white/30 text-white/80 font-medium rounded-lg hover:bg-white/20 hover:text-white transition-all flex items-center justify-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          演示模式
        </button>
        <p className="text-center text-white/30 text-xs mt-2">无需登录，快速体验功能</p>
      </div>
    </div>
  );
}

