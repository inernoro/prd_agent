import { useState, useEffect, useCallback } from 'react';
import { MessageSquare, LayoutGrid, RefreshCw, AlertCircle } from 'lucide-react';
import { getPaSession } from '@/services/real/paAgentService';
import type { PaTask } from '@/services/real/paAgentService';
import { PaAssistantChat } from './PaAssistantChat';
import { PaTaskBoard } from './PaTaskBoard';

type Tab = 'chat' | 'board';

function generateLocalSessionId(): string {
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function PaAgentPage() {
  const [tab, setTab] = useState<Tab>('chat');
  // Initialise immediately with a local id so the UI never blocks on the API
  const [sessionId, setSessionId] = useState<string>(() => generateLocalSessionId());
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [boardRefreshKey, setBoardRefreshKey] = useState(0);

  const initSession = useCallback(async () => {
    setSessionError(null);
    // Race API against 5 s timeout
    const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), 5000));
    const result = await Promise.race([getPaSession(), timeout]);

    if (result && result.success && result.data?.sessionId) {
      // Upgrade to the persistent server-side session id
      setSessionId(result.data.sessionId);
    } else {
      const errMsg = result
        ? (result.error?.message ?? '会话初始化失败，消息不会持久化')
        : '会话接口超时，消息不会持久化';
      setSessionError(errMsg);
    }
  }, []);

  useEffect(() => {
    void initSession();
  }, [initSession]);

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

      {/* Session error banner */}
      {sessionError && (
        <div
          className="shrink-0 flex items-center gap-2 px-4 py-2 text-xs"
          style={{
            background: 'var(--color-yellow-950, #422006)',
            color: 'var(--color-yellow-400, #facc15)',
            borderBottom: '1px solid var(--border-default)',
          }}
        >
          <AlertCircle size={13} className="shrink-0" />
          <span className="flex-1">{sessionError}</span>
          <button
            onClick={() => void initSession()}
            className="flex items-center gap-1 px-2 py-0.5 rounded whitespace-nowrap"
            style={{ background: 'rgba(255,255,255,0.1)' }}
          >
            <RefreshCw size={11} />
            重试
          </button>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {tab === 'chat' ? (
          <PaAssistantChat sessionId={sessionId} onTaskSaved={handleTaskSaved} />
        ) : (
          <PaTaskBoard key={boardRefreshKey} />
        )}
      </div>
    </div>
  );
}
