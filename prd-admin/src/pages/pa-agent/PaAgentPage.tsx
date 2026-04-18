import { useState, useEffect, useCallback } from 'react';
import { MessageSquare, LayoutGrid, RefreshCw, AlertCircle, Zap } from 'lucide-react';
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
  const [sessionId, setSessionId] = useState<string>(() => generateLocalSessionId());
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [boardRefreshKey, setBoardRefreshKey] = useState(0);

  const initSession = useCallback(async () => {
    setSessionError(null);
    const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), 5000));
    const result = await Promise.race([getPaSession(), timeout]);

    if (result && result.success && result.data?.sessionId) {
      setSessionId(result.data.sessionId);
    } else {
      const errMsg = result
        ? (result.error?.message ?? '会话同步失败，消息仅保存在本地')
        : '会话接口超时，消息仅保存在本地';
      setSessionError(errMsg);
    }
  }, []);

  useEffect(() => {
    void initSession();
  }, [initSession]);

  const handleTaskSaved = (_task: PaTask) => {
    setBoardRefreshKey(k => k + 1);
    // 短暂切换到看板让用户看到新任务
    setTimeout(() => setTab('board'), 600);
  };

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'chat', label: '对话助理', icon: <MessageSquare size={14} /> },
    { key: 'board', label: '任务看板', icon: <LayoutGrid size={14} /> },
  ];

  return (
    <div
      className="h-full flex flex-col"
      style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
    >
      {/* Header */}
      <div
        className="shrink-0 flex items-center justify-between px-4 py-2.5"
        style={{ borderBottom: '1px solid var(--border-default)' }}
      >
        <div className="flex items-center gap-2">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
          >
            <Zap size={14} color="#fff" />
          </div>
          <div>
            <span className="text-sm font-semibold">私人助理</span>
            <span
              className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full font-medium"
              style={{
                background: 'rgba(99,102,241,0.12)',
                color: '#6366f1',
              }}
            >
              MBB
            </span>
          </div>
        </div>

        {/* Tab switcher */}
        <div
          className="flex items-center rounded-xl p-0.5"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-default)',
          }}
        >
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-[10px] transition-all whitespace-nowrap font-medium"
              style={
                tab === t.key
                  ? {
                      background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                      color: '#fff',
                      boxShadow: '0 2px 8px rgba(99,102,241,0.3)',
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
            background: 'rgba(234,179,8,0.08)',
            color: '#ca8a04',
            borderBottom: '1px solid rgba(234,179,8,0.2)',
          }}
        >
          <AlertCircle size={12} className="shrink-0" />
          <span className="flex-1">{sessionError}</span>
          <button
            onClick={() => void initSession()}
            className="flex items-center gap-1 px-2 py-0.5 rounded-lg text-xs whitespace-nowrap transition-colors"
            style={{ background: 'rgba(234,179,8,0.1)' }}
          >
            <RefreshCw size={10} />
            重连
          </button>
          <button
            onClick={() => setSessionError(null)}
            className="ml-1 hover:opacity-70"
          >
            ×
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
