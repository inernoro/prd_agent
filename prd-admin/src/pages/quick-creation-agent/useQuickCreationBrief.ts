import { useCallback, useEffect, useRef, useState } from 'react';
import { getQuickCreationBrief, streamQuickCreationBrief, syncQuickCreationBrief } from '@/services/real/quickCreation';
import type { BriefPending } from './BriefChat';
import type { QcBriefContext, QcBriefSession } from './types';

interface Turn {
  id: string;
  turnId: string;
  mode: 'message' | 'script';
  text: string;
  context: QcBriefContext;
}

export function useQuickCreationBrief(briefId: string | null, onRestore: (session: QcBriefSession) => void) {
  const [session, setSession] = useState<QcBriefSession | null>(null);
  const [pending, setPending] = useState<BriefPending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const request = useRef<{ id: string; controller: AbortController } | null>(null);
  const retry = useRef<Turn | null>(null);
  const [restoreCount, setRestoreCount] = useState(0);

  useEffect(() => {
    if (request.current?.id === briefId) return;
    request.current?.controller.abort();
    request.current = null;
    setPending(null);
    setError(null);
    setSession(null);
    if (!briefId) {
      retry.current = null;
      setRestoring(false);
      return;
    }
    const controller = new AbortController();
    setRestoring(true);
    void getQuickCreationBrief(briefId, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setRestoring(false);
      if (result.success) {
        setSession(result.data);
        onRestore(result.data);
      } else setError(result.error.message || '简报暂时没有读到，请重试');
    });
    return () => controller.abort();
  }, [briefId, onRestore, restoreCount]);

  useEffect(() => () => request.current?.controller.abort(), []);

  async function send(turn: Turn): Promise<{ session: QcBriefSession; start: boolean } | null> {
    if (request.current) return null;
    const controller = new AbortController();
    request.current = { id: turn.id, controller };
    retry.current = turn;
    setError(null);
    setPending({
      mode: turn.mode, text: turn.text, reply: '',
      phase: turn.mode === 'script' ? '正在准备分镜' : '正在理解创作要求',
    });
    let completed: { session: QcBriefSession; start: boolean } | null = null;
    let issue: string | null = null;
    try {
      const result = await streamQuickCreationBrief(turn.id, turn, controller.signal, event => {
        switch (event.name) {
          case 'phase': setPending(value => value && { ...value, phase: event.message }); break;
          case 'model': setPending(value => value && { ...value, model: event.model, platform: event.platform }); break;
          case 'text': setPending(value => value && { ...value, reply: value.reply + event.text }); break;
          case 'session': completed = { session: event.session, start: event.start }; break;
          case 'error': issue = event.message; break;
        }
      });
      if (controller.signal.aborted) return null;
      if (!completed && !issue) {
        // The server can finish saving even when the event stream ended early.
        const saved = await getQuickCreationBrief(turn.id, controller.signal);
        if (saved.success && saved.data.messages.some(message => message.id === turn.turnId + '-reply'))
          completed = { session: saved.data, start: false };
      }
      if (controller.signal.aborted) return null;
      if (completed) {
        setSession(completed.session);
        retry.current = null;
        return completed;
      }
      setError(issue || result.errorMessage || '连接中断，已保存的简报仍可恢复，请重试');
      return null;
    } finally {
      if (request.current?.controller === controller) {
        request.current = null;
        setPending(null);
      }
    }
  }

  const sync = useCallback(async (context: QcBriefContext) => {
    if (!briefId || request.current) return;
    setSyncing(true);
    try {
      const result = await syncQuickCreationBrief(briefId, context);
      if (result.success) {
        setSession(current => current?.id === result.data.id && current.revision === context.revision ? result.data : current);
      } else {
        setError(result.error.message || '没有同步到简报，请重试');
      }
    } finally {
      setSyncing(false);
    }
  }, [briefId]);

  function recover() {
    if (retry.current) return send(retry.current);
    setRestoreCount(count => count + 1);
    return Promise.resolve(null);
  }

  return {
    session, pending, error, restoring, syncing, send, sync,
    recover,
  };
}
