import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import UsersPage from './pages/UsersPage';
import ModelManagePage from './pages/ModelManagePage';
import StatsPage from './pages/StatsPage';

function App() {
  const { isAuthenticated, user } = useAuthStore();

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  // 只有ADMIN可以访问
  if (user?.role !== 'ADMIN') {
    return (
      <div 
        className="h-full w-full flex items-center justify-center"
        style={{ background: 'var(--bg-base)' }}
      >
        <div className="text-center">
          <h1 
            style={{ 
              fontSize: 24, 
              fontWeight: 600, 
              color: 'var(--text-primary)',
              marginBottom: 8,
            }}
          >
            无权限访问
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
            只有管理员可以访问此系统
          </p>
        </div>
      </div>
    );
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/model-manage" element={<ModelManagePage />} />
        <Route path="/stats" element={<StatsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

export default App;
