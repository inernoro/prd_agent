import { useSessionStore } from '../../stores/sessionStore';

export default function ModeToggle() {
  const { mode, setMode } = useSessionStore();

  return (
    <div className="flex items-center gap-2 bg-background-light dark:bg-background-dark rounded-lg p-1">
      <button
        onClick={() => setMode('QA')}
        className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
          mode === 'QA'
            ? 'bg-primary-500 text-white'
            : 'text-text-secondary hover:bg-gray-100 dark:hover:bg-gray-800'
        }`}
      >
        💬 问答
      </button>
      <button
        onClick={() => setMode('Guided')}
        className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
          mode === 'Guided'
            ? 'bg-primary-500 text-white'
            : 'text-text-secondary hover:bg-gray-100 dark:hover:bg-gray-800'
        }`}
      >
        📖 引导讲解
      </button>
    </div>
  );
}





