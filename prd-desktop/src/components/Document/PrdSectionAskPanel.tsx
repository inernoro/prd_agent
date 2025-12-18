import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke, listen } from '../../lib/tauri';

type PreviewAskPhase = 'requesting' | 'connected' | 'receiving' | 'typing' | null;

type PreviewAskHistoryItem = {
  id: string;
  question: string;
  answer: string;
  headingId: string;
  headingTitle?: string | null;
  createdAtMs: number;
};

type PreviewAskEvent = {
  type: 'start' | 'delta' | 'done' | 'error' | 'phase';
  requestId?: string;
  content?: string;
  errorCode?: string;
  errorMessage?: string;
  phase?: PreviewAskPhase;
};

export default function PrdSectionAskPanel(props: {
  sessionId: string | null;
  headingId: string | null;
  headingTitle: string | null;
  onJumpToHeading?: (headingId: string) => void;
}) {
  const { sessionId, headingId, headingTitle, onJumpToHeading } = props;
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [history, setHistory] = useState<PreviewAskHistoryItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<PreviewAskPhase>(null);
  const reqIdRef = useRef<string | null>(null);
  const pendingQuestionRef = useRef<string | null>(null);
  const answerRef = useRef<string>('');
  const persistedRef = useRef<boolean>(false);
  const sessionIdRef = useRef<string | null>(sessionId);
  const headingIdRef = useRef<string | null>(headingId);
  const headingTitleRef = useRef<string | null>(headingTitle);

  const canAsk = useMemo(() => !!sessionId && !!headingId && !busy, [sessionId, headingId, busy]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
    headingIdRef.current = headingId;
    headingTitleRef.current = headingTitle;
  }, [sessionId, headingId, headingTitle]);

  useEffect(() => {
    // 监听 preview-ask-chunk（一次性窗口，独立于消息历史）
    const unlistenPromise = listen<PreviewAskEvent>('preview-ask-chunk', (event) => {
      const p = event.payload as any;
      const t = p?.type;
      if (t === 'phase') {
        setPhase((p.phase as PreviewAskPhase) || null);
        return;
      }
      if (t === 'start') {
        reqIdRef.current = p.requestId || null;
        setPhase('typing');
        persistedRef.current = false;
        return;
      }
      if (t === 'delta' && p.content) {
        setAnswer((prev) => {
          const next = prev + String(p.content);
          answerRef.current = next;
          return next;
        });
        setPhase('typing');
        return;
      }
      if (t === 'error') {
        setError(p.errorMessage || '请求失败');
        setBusy(false);
        setPhase(null);
        pendingQuestionRef.current = null;
        persistedRef.current = false;
        return;
      }
      if (t === 'done') {
        setBusy(false);
        setPhase(null);
        // 将“提问本章”的问答历史落盘（仅本机）
        const sid = sessionIdRef.current;
        const hid = headingIdRef.current;
        const htitle = headingTitleRef.current;
        if (!persistedRef.current && sid && hid) {
          const q = (pendingQuestionRef.current || '').trim();
          const a = (answerRef.current || '').trim();
          if (q && a) {
            persistedRef.current = true;
            const item: PreviewAskHistoryItem = {
              id: `local-${Date.now()}`,
              question: q,
              answer: answerRef.current,
              headingId: hid,
              headingTitle: htitle || null,
              createdAtMs: Date.now(),
            };
            setHistory((prev) => [...prev, item]);
            invoke('append_preview_ask_history', {
              sessionId: sid,
              headingId: hid,
              headingTitle: htitle || undefined,
              question: q,
              answer: answerRef.current,
            }).catch((e: any) => {
              // 不阻塞 UI；仅记录错误
              console.error('Failed to persist preview ask history:', e);
            });
          }
        }
        pendingQuestionRef.current = null;
        return;
      }
    }).catch(() => {
      return () => {};
    });

    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // 打开面板/切换章节时恢复历史（从本机落盘文件读取）
  useEffect(() => {
    if (!open) return;
    if (!sessionId || !headingId) {
      setHistory([]);
      return;
    }

    invoke<PreviewAskHistoryItem[]>('get_preview_ask_history', { sessionId, headingId, limit: 50 })
      .then((items) => {
        setHistory(Array.isArray(items) ? items : []);
      })
      .catch((e: any) => {
        console.error('Failed to load preview ask history:', e);
        setHistory([]);
      });
  }, [open, sessionId, headingId]);

  const submit = async () => {
    if (!sessionId) {
      setError('当前群组未绑定 PRD，无法提问');
      return;
    }
    if (!headingId) {
      setError('未识别到当前章节，请滚动到有标题的章节后再试');
      return;
    }
    const q = question.trim();
    if (!q) return;

    setBusy(true);
    setError('');
    setAnswer('');
    answerRef.current = '';
    setPhase('requesting');
    reqIdRef.current = null;
    pendingQuestionRef.current = q;
    persistedRef.current = false;
    setQuestion('');

    try {
      await invoke('preview_ask_in_section', {
        sessionId,
        headingId,
        headingTitle: headingTitle || undefined,
        question: q,
      });
    } catch (e: any) {
      setError(e?.message || '请求失败');
      setBusy(false);
      setPhase(null);
      pendingQuestionRef.current = null;
      persistedRef.current = false;
    }
  };

  return (
    <div className="fixed z-40 left-1/2 -translate-x-1/2 bottom-4">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="h-10 px-4 rounded-full border border-border bg-surface-light dark:bg-surface-dark shadow-lg text-sm text-text-secondary hover:text-primary-500 hover:bg-gray-50 dark:hover:bg-white/10"
          title="提问本章（只基于当前章节内容）"
        >
          提问本章
        </button>
      ) : (
        <div className="w-[520px] max-w-[calc(100vw-24px)] bg-surface-light dark:bg-surface-dark border border-border rounded-2xl shadow-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs text-text-secondary">当前章节</div>
              <div className="text-sm font-semibold truncate" title={headingTitle || headingId || ''}>
                {headingTitle || headingId || '未识别'}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {headingId ? (
                <button
                  type="button"
                  onClick={() => onJumpToHeading?.(headingId)}
                  className="h-8 px-2 rounded-md text-xs border border-border text-text-secondary hover:text-primary-500 hover:bg-gray-50 dark:hover:bg-white/10"
                  title="跳转到本章"
                >
                  跳转
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-8 px-2 rounded-md text-xs border border-border text-text-secondary hover:text-primary-500 hover:bg-gray-50 dark:hover:bg-white/10"
                title="折叠"
              >
                折叠
              </button>
            </div>
          </div>

          <div className="p-4 space-y-3">
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={!canAsk}
              className="w-full min-h-[72px] px-3 py-2 bg-background-light dark:bg-background-dark border border-border rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-primary-500/40 text-sm"
              placeholder={canAsk ? '输入你想问本章的问题…' : (!sessionId ? '未绑定 PRD，无法提问' : '未识别到当前章节')}
            />

            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] text-text-secondary">
                {busy && phase ? (phase === 'typing' ? '开始输出…' : (phase === 'receiving' ? '正在接收信息…' : phase === 'connected' ? '已连接，等待首包…' : '正在请求大模型…')) : ''}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (!sessionId || !headingId) return;
                    invoke('clear_preview_ask_history', { sessionId, headingId })
                      .then(() => setHistory([]))
                      .catch((e: any) => console.error('Failed to clear preview ask history:', e));
                  }}
                  disabled={busy || !sessionId || !headingId || history.length === 0}
                  className="px-3 py-2 text-sm rounded-xl border border-border text-text-secondary hover:bg-gray-50 dark:hover:bg-white/10 disabled:opacity-50"
                  title="清空本章提问历史（仅清理本机落盘）"
                >
                  清空历史
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setQuestion('');
                    setAnswer('');
                    answerRef.current = '';
                    setError('');
                    setPhase(null);
                    reqIdRef.current = null;
                    pendingQuestionRef.current = null;
                    persistedRef.current = false;
                  }}
                  disabled={busy}
                  className="px-3 py-2 text-sm rounded-xl border border-border text-text-secondary hover:bg-gray-50 dark:hover:bg-white/10 disabled:opacity-50"
                >
                  清空
                </button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={!question.trim() || !sessionId || !headingId || busy}
                  className="px-3 py-2 text-sm rounded-xl bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50"
                >
                  {busy ? '发送中…' : '发送'}
                </button>
              </div>
            </div>

            {error ? (
              <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
            ) : null}

            <div className="border-t border-border pt-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="text-xs font-semibold text-text-secondary">历史（仅保存在本机，最多 50 条）</div>
                <div className="text-[11px] text-text-secondary">
                  {sessionId && headingId ? (history.length ? `共 ${history.length} 条` : '暂无') : ''}
                </div>
              </div>
              <div className="max-h-[26vh] overflow-auto space-y-2">
                {history.length ? (
                  history.map((h) => (
                    <div key={h.id} className="rounded-xl border border-border p-3 bg-background-light/40 dark:bg-background-dark/30">
                      <div className="text-[11px] text-text-secondary mb-1">问</div>
                      <div className="text-sm whitespace-pre-wrap break-words">{h.question}</div>
                      <div className="mt-2 text-[11px] text-text-secondary mb-1">答</div>
                      <div className="text-sm whitespace-pre-wrap break-words">{h.answer}</div>
                    </div>
                  ))
                ) : (
                  <div className="text-sm text-text-secondary">暂无历史</div>
                )}
              </div>
            </div>

            <div className="border-t border-border pt-3">
              <div className="text-xs font-semibold text-text-secondary mb-2">本次回复</div>
              <div className="max-h-[34vh] overflow-auto text-sm whitespace-pre-wrap break-words">
                {answer ? answer : (busy ? '正在生成…' : '暂无')}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

