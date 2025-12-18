import { useSessionStore } from '../../stores/sessionStore';
import { invoke } from '../../lib/tauri';

// 问答图标
const ChatIcon = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
  </svg>
);

// 引导讲解图标
const BookIcon = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
  </svg>
);

export default function ModeToggle() {
  const { mode, previousMode, setMode, sessionId } = useSessionStore();
  const modeForUi = mode === 'PrdPreview' ? (previousMode ?? 'QA') : mode;

  const switchToQa = async () => {
    // 从“讲解”离开时需要清理后端状态；若当前在 PRD 预览页，也要按 previousMode 判断
    if ((mode === 'Guided' || (mode === 'PrdPreview' && previousMode === 'Guided')) && sessionId) {
      try {
        await invoke('control_guide', { sessionId, action: 'stop' });
      } catch (err) {
        console.error('Failed to stop guide:', err);
      }
    }
    setMode('QA');
  };

  const switchToGuided = async () => {
    // 离开讲解时清理后端状态
    if (mode === 'Guided' && sessionId) {
      try {
        await invoke('control_guide', { sessionId, action: 'stop' });
      } catch {
        // ignore
      }
    }
    setMode('Guided');
    // 不自动触发任何讲解请求；由输入框上方悬浮栏的“讲解/简介”按钮显式触发
    // 如需退出时清理后端状态，可在 switchToQa 中 stop。
    void sessionId;
  };

  return (
    <div className="flex items-center gap-2 bg-background-light dark:bg-background-dark rounded-lg p-1">
      <button
        onClick={switchToQa}
        className={`px-3 py-1.5 text-sm rounded-md transition-colors flex items-center gap-1.5 ${
          modeForUi === 'QA'
            ? 'bg-primary-500 text-white'
            : 'text-text-secondary hover:bg-gray-100 dark:hover:bg-gray-800'
        }`}
      >
        <ChatIcon className="w-4 h-4" />
        <span>问答</span>
      </button>
      <button
        onClick={switchToGuided}
        className={`px-3 py-1.5 text-sm rounded-md transition-colors flex items-center gap-1.5 ${
          modeForUi === 'Guided'
            ? 'bg-primary-500 text-white'
            : 'text-text-secondary hover:bg-gray-100 dark:hover:bg-gray-800'
        }`}
      >
        <BookIcon className="w-4 h-4" />
        <span>阶段讲解</span>
      </button>
    </div>
  );
}
