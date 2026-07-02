// 独立路由（自成体系，不依赖 prd-admin）：/login 登录 + /change-password 首登强制改密 + / 观测主页（需鉴权）。
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from '@/lib/auth';
import { ConsoleLayout } from '@/components/ConsoleLayout';
import { LoginPage } from '@/pages/LoginPage';
import { ChangePasswordPage } from '@/pages/ChangePasswordPage';
import { OverviewPage } from '@/pages/OverviewPage';
import { LogsPage } from '@/pages/LogsPage';
import { ModelPoolsPage } from '@/pages/ModelPoolsPage';
import { PlatformsPage } from '@/pages/PlatformsPage';
import { ShadowPage } from '@/pages/ShadowPage';

// 受保护路由守卫：未登录跳登录页；已登录但挂着「强制改密」标记则跳改密页（服务端策略门同样拦截，双保险）。
function RequireAuth({ children }: { children: ReactNode }) {
  const { authed, mustChangePassword } = useAuth();
  const location = useLocation();
  if (!authed) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (mustChangePassword) return <Navigate to="/change-password" replace />;
  return <>{children}</>;
}

// 改密页守卫：未登录跳登录；已登录且无需改密则不应停留在此页，回主页。
function RequireChangePassword({ children }: { children: ReactNode }) {
  const { authed, mustChangePassword } = useAuth();
  if (!authed) return <Navigate to="/login" replace />;
  if (!mustChangePassword) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/change-password"
            element={
              <RequireChangePassword>
                <ChangePasswordPage />
              </RequireChangePassword>
            }
          />
          <Route
            element={
              <RequireAuth>
                <ConsoleLayout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<OverviewPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/pools" element={<ModelPoolsPage />} />
            <Route path="/platforms" element={<PlatformsPage />} />
            <Route path="/shadow" element={<ShadowPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
