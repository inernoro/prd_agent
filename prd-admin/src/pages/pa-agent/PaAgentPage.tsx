import { useState, useEffect } from 'react';
import { MessageSquare, LayoutGrid } from 'lucide-react';
import { getPaSession } from '@/services/real/paAgentService';
import type { PaTask } from '@/services/real/paAgentService';
import { PaAssistantChat } from './PaAssistantChat';
import { PaTaskBoard } from './PaTaskBoard';

type Tab = 'chat' | 'board';

export function PaAgentPage() {
  const [tab, setTab] = useState<Tab>('chat');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [boardRefreshKey, setBoardRefreshKey] = useState(0);

  useEffect(() => {
    (async () => {
      const res = await getPaSession();
      if (res.success && res.data) {
        setSessionId(res.data.sessionId);
      }
    })();
  }, []);

  const handleTaskSaved = (_task: PaTask) => {
    setBoardRefreshKey(k => k + 1);
  };

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'chat', label: '对话助理', icon: <MessageSquare size={15} /> },
    { key: 'board', label: '任务看板', icon: <LayoutGrid size={15} /> },
  ];

  return (
    <div
      className="h-full flex flex-col"
      style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
    >
      {/* Header */}
      <div
        className="shrink-0 flex items-center justify-between px-4 py-3"
        style={{ borderBottom: '1px solid var(--border-default)' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold">私人助理</span>
          <span
            className="text-xs px-1.5 py-0.5 rounded"
            style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}
          >
            PA Agent
          </span>
        </div>

        {/* Tab switcher */}
        <div
          className="flex items-center rounded-lg p-0.5"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}
        >
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md transition-colors whitespace-nowrap"
              style={
                tab === t.key
                  ? {
                      background: 'var(--bg-base)',
                      color: 'var(--text-primary)',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
                    }
                  : {
                      color: 'var(--text-muted)',
                    }
              }
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {tab === 'chat' ? (
          sessionId ? (
            <PaAssistantChat sessionId={sessionId} onTaskSaved={handleTaskSaved} />
          ) : (
            <div className="flex items-center justify-center h-full">
              <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
                初始化中...
              </span>
            </div>
          )
        ) : (
          <PaTaskBoard key={boardRefreshKey} />
        )}
      </div>
    </div>
  );
}
