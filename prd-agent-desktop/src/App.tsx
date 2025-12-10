import { useEffect, useState } from 'react';
import { useSessionStore } from './stores/sessionStore';
import { useAuthStore } from './stores/authStore';
import Header from './components/Layout/Header';
import Sidebar from './components/Layout/Sidebar';
import DocumentUpload from './components/Document/DocumentUpload';
import ChatContainer from './components/Chat/ChatContainer';
import LoginPage from './components/Auth/LoginPage';

function App() {
  const { isAuthenticated } = useAuthStore();
  const { documentLoaded } = useSessionStore();
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    // 检测系统主题
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    setIsDark(prefersDark);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
  }, [isDark]);

  // 未登录显示登录页
  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <div className="h-screen flex flex-col bg-background-light dark:bg-background-dark">
      <Header isDark={isDark} onToggleTheme={() => setIsDark(!isDark)} />
      
      <div className="flex-1 flex overflow-hidden">
        <Sidebar />
        
        <main className="flex-1 flex flex-col">
          {!documentLoaded ? (
            <DocumentUpload />
          ) : (
            <ChatContainer />
          )}
        </main>
      </div>
    </div>
  );
}

export default App;

