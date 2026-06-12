/**
 * 项目管理智能体 — 首页「AI助手」面板（问答形式，首页主区常驻）。
 *
 * 以当前用户为中心、跨其全部相关项目（项目/目标/里程碑/任务/风险摘要）为上下文，SSE 流式问答；
 * 并支持通过对话创建项目/目标/里程碑/任务（后端 <<<ACTIONS>>> 动作协议，action 事件回执卡片可直达）。
 * 对话保存在 sessionStorage（用户级），切 tab / 刷新不丢，支持手动清除。
 * 结构参考 product-agent/ProductAssistantPanel（蓝色强调）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Send, Copy, Check, Trash2, Mic, MicOff, ExternalLink, CircleAlert, FileText } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming/StreamingText';
import { useSseStream } from '@/lib/useSseStream';
import { useSpeechInput } from '@/lib/useSpeechInput';
import { useAuthStore } from '@/stores/authStore';
import { resolveAvatarUrl } from '@/lib/avatar';
import { stripMarkdown } from '@/lib/stripMarkdown';
import { toast } from '@/lib/toast';
import { api } from '@/services/api';
import { AttachmentUploadButton, AttachmentChips, type AssistantAttachment } from '@/components/assistant/AssistantAttachments';

const PRESETS = ['我的任务概览', '哪个项目风险最高', '本周到期的里程碑和逾期任务'];

/** 后端 SSE action 事件载荷：助手替用户创建对象的执行结果 */
interface PmAssistantActionResult {
  kind: 'project' | 'goal' | 'milestone' | 'task' | string;
  ok: boolean;
  id?: string | null;
  projectId?: string | null;
  projectTitle?: string | null;
  title?: string;
  error?: string | null;
}

interface QA {
  q: string;
  a: string;
  actions?: PmAssistantActionResult[];
  /** 随该问题携带的附件名（仅展示用） */
  files?: string[];
}

export function PmAssistantPanel({ prefill }: { prefill?: { text: string; nonce: number } | null }) {
  const storageKey = 'pm-ai-assistant';
  const me = useAuthStore((s) => s.user);
  const myAvatar = resolveAvatarUrl({ username: me?.username, avatarFileName: me?.avatarFileName });

  const [history, setHistory] = useState<QA[]>(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      return raw ? (JSON.parse(raw) as QA[]) : [];
    } catch {
      return [];
    }
  });
  const [pendingQ, setPendingQ] = useState<string | null>(null);
  const [liveAnswer, setLiveAnswer] = useState('');
  const [liveActions, setLiveActions] = useState<PmAssistantActionResult[]>([]);
  const [input, setInput] = useState('');
  // 附件作为上下文（md/pdf，先经后端提取为纯文本驻留前端，随提问回传）
  const [files, setFiles] = useState<AssistantAttachment[]>([]);
  const [pendingFiles, setPendingFiles] = useState<string[]>([]);
  const answerRef = useRef('');
  const actionsRef = useRef<PmAssistantActionResult[]>([]);
  const pendingRef = useRef<string | null>(null);
  const pendingFilesRef = useRef<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 便捷操作「创建目标/里程碑/任务」预填模板 → 填进输入框并聚焦，由用户补全后发送
  useEffect(() => {
    if (!prefill || !prefill.text) return;
    setInput(prefill.text);
    inputRef.current?.focus();
  }, [prefill]);

  // 对话持久化（sessionStorage：切走重回不丢，手动清除才没）
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(history));
    } catch {
      /* ignore quota */
    }
  }, [history]);

  const finalize = (a: string) => {
    const q = pendingRef.current;
    const actions = actionsRef.current;
    const qFiles = pendingFilesRef.current;
    if (q != null) setHistory((h) => [...h, { q, a, ...(actions.length > 0 ? { actions } : {}), ...(qFiles.length > 0 ? { files: qFiles } : {}) }]);
    pendingRef.current = null;
    actionsRef.current = [];
    pendingFilesRef.current = [];
    setPendingQ(null);
    setPendingFiles([]);
    setLiveAnswer('');
    setLiveActions([]);
    answerRef.current = '';
  };

  const sse = useSseStream({
    url: api.pm.assistantAsk(),
    method: 'POST',
    onTyping: (t) => {
      answerRef.current += t;
      setLiveAnswer(answerRef.current);
    },
    onEvent: {
      // 助手创建对象的执行结果（项目/目标/里程碑/任务），流尾随 done 一起到达
      action: (d) => {
        actionsRef.current = [...actionsRef.current, d as PmAssistantActionResult];
        setLiveActions(actionsRef.current);
      },
    },
    onDone: () => finalize(stripMarkdown(answerRef.current) || '（无内容）'),
    onError: (m) => finalize(`出错：${m}`),
  });

  // 语音输入（Web Speech API；不支持的浏览器自动隐藏麦克风按钮）
  const speechBaseRef = useRef('');
  const speech = useSpeechInput({
    onResult: (finalText, interim) => setInput(speechBaseRef.current + finalText + interim),
    onError: (msg) => toast.error('语音输入', msg),
  });
  const toggleVoice = () => {
    if (!speech.listening) speechBaseRef.current = input;
    speech.toggle();
  };

  const ask = (q: string) => {
    const text = q.trim();
    if (!text || sse.isStreaming) return;
    if (speech.listening) speech.cancel();
    speechBaseRef.current = '';
    answerRef.current = '';
    actionsRef.current = [];
    setLiveAnswer('');
    setLiveActions([]);
    pendingRef.current = text;
    setPendingQ(text);
    setInput('');
    // 附件随本次提问消费：回传已提取文本，发送后清空
    const fileNames = files.map((f) => f.name);
    pendingFilesRef.current = fileNames;
    setPendingFiles(fileNames);
    const attachments = files.map((f) => ({ name: f.name, text: f.text }));
    setFiles([]);
    void sse.start({ body: { question: text, ...(attachments.length > 0 ? { attachments } : {}) } });
  };

  const clearAll = () => {
    sse.abort();
    pendingRef.current = null;
    answerRef.current = '';
    actionsRef.current = [];
    pendingFilesRef.current = [];
    setPendingQ(null);
    setPendingFiles([]);
    setFiles([]);
    setLiveAnswer('');
    setLiveActions([]);
    setHistory([]);
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  };

  // 新内容自动滚到底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [history, liveAnswer, pendingQ]);

  const connecting = sse.phase === 'connecting' || (sse.isStreaming && !liveAnswer);

  return (
    <div className="h-full min-h-0 flex flex-col">
      {/* 头部 */}
      <div className="shrink-0 flex items-center gap-2 px-5 py-3.5 border-b border-white/10">
        <Sparkles size={16} className="text-blue-300" />
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-semibold text-white/90">AI助手</span>
          <span className="text-[11px] text-white/40 truncate">基于你全部相关项目的数据，跨项目问答与操作</span>
        </div>
        {history.length > 0 && (
          <button
            onClick={clearAll}
            className="ml-auto flex items-center gap-1 text-[11px] text-white/45 hover:text-white/80 px-1.5 py-1 rounded hover:bg-white/5"
            title="清除全部对话"
          >
            <Trash2 size={13} /> 清除
          </button>
        )}
      </div>

      {/* 消息区 */}
      <div
        ref={scrollRef}
        className="flex-1 px-5 py-4 space-y-3"
        style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
      >
        {history.length === 0 && !pendingQ && (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-6">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center bg-blue-500/10 border border-blue-500/25">
              <Sparkles size={22} className="text-blue-300" />
            </div>
            <div className="text-sm text-white/70 font-medium">问点什么吧</div>
            <div className="text-[12px] text-white/40 leading-relaxed max-w-md">
              我能基于你相关的全部项目（目标 / 里程碑 / 任务 / 风险）跨项目回答问题，也能直接替你创建。
              试试下方的快捷分析，或者对我说：「帮我创建一个项目：官网改版，目标是上线新官网」。
              也可以点左下角回形针上传 md / pdf 文档，让我基于文档内容分析或批量创建。
            </div>
          </div>
        )}
        {history.map((m, i) => (
          <div key={i} className="space-y-2.5">
            <UserRow text={m.q} avatar={myAvatar} files={m.files} />
            <AiRow text={m.a} />
            {m.actions && m.actions.length > 0 && <ActionResults items={m.actions} />}
          </div>
        ))}
        {pendingQ && (
          <div className="space-y-2.5">
            <UserRow text={pendingQ} avatar={myAvatar} files={pendingFiles} />
            <AiRow streaming>
              {connecting ? (
                <span className="inline-flex items-center gap-2 text-white/50 text-[12px]">
                  <MapSpinner size={14} /> {sse.phaseMessage || '思考中…'}
                </span>
              ) : (
                <StreamingText text={stripMarkdown(liveAnswer)} streaming />
              )}
            </AiRow>
            {liveActions.length > 0 && <ActionResults items={liveActions} />}
          </div>
        )}
      </div>

      {/* 快捷问题 */}
      <div className="shrink-0 px-5 pt-2 flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p}
            disabled={sse.isStreaming}
            onClick={() => ask(p)}
            className="text-[12px] px-2.5 py-1 rounded-full border border-blue-500/30 text-blue-200 bg-blue-500/10 hover:bg-blue-500/20 disabled:opacity-40"
          >
            {p}
          </button>
        ))}
      </div>

      {/* 输入区（大输入框 + 底部操作行，语音/发送在框内右下） */}
      <div className="shrink-0 px-5 py-3">
        <div
          className={`rounded-xl border bg-white/5 flex flex-col transition-colors ${
            speech.listening ? 'border-red-400/50' : 'border-white/10 focus-within:border-blue-500/40'
          }`}
        >
          {files.length > 0 && (
            <div className="px-3 pt-2.5">
              <AttachmentChips items={files} onRemove={(i) => setFiles((p) => p.filter((_, idx) => idx !== i))} accent="#3B82F6" />
            </div>
          )}
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                ask(input);
              }
            }}
            rows={3}
            placeholder={speech.listening ? '正在聆听，直接说出你的问题…' : '输入问题，Enter 发送，Shift+Enter 换行…'}
            className="no-focus-ring w-full resize-none bg-transparent px-3.5 pt-3 text-[13px] text-white/90 outline-none placeholder:text-white/30"
            style={{ minHeight: 84, maxHeight: 200, overflowY: 'auto' }}
          />
          <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
            <AttachmentUploadButton
              extractUrl={api.pm.assistantAttachments()}
              attachments={files}
              onAdd={(f) => setFiles((p) => [...p, f])}
              disabled={sse.isStreaming}
            />
            {speech.listening && (
              <span className="flex items-center gap-1.5 text-[11px] text-red-300">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
                正在聆听…再点麦克风结束
              </span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              {speech.supported && (
                <button
                  onClick={toggleVoice}
                  className={`flex items-center justify-center w-8 h-8 rounded-lg border text-sm transition-colors ${
                    speech.listening
                      ? 'bg-red-500/20 text-red-300 border-red-400/40 hover:bg-red-500/30'
                      : 'bg-white/5 text-white/55 border-white/10 hover:text-white hover:bg-white/10'
                  }`}
                  title={speech.listening ? '停止语音输入' : '语音输入（说话转文字）'}
                >
                  {speech.listening ? <MicOff size={15} /> : <Mic size={15} />}
                </button>
              )}
              <button
                onClick={() => ask(input)}
                disabled={!input.trim() || sse.isStreaming}
                className="flex items-center justify-center w-8 h-8 rounded-lg bg-blue-500/20 text-blue-200 border border-blue-500/40 text-sm hover:bg-blue-500/30 disabled:opacity-40"
                title="发送"
              >
                {sse.isStreaming ? <MapSpinner size={14} /> : <Send size={14} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const ACTION_KIND_META: Record<string, { label: string; color: string }> = {
  project: { label: '项目', color: '#3B82F6' },
  goal: { label: '目标', color: '#FBBF24' },
  milestone: { label: '里程碑', color: '#A78BFA' },
  task: { label: '任务', color: '#34D399' },
};

/** 助手创建对象的结果卡片：成功可点击直达对应项目页/任务页，失败显示原因。 */
function ActionResults({ items }: { items: PmAssistantActionResult[] }) {
  const navigate = useNavigate();
  const open = (r: PmAssistantActionResult) => {
    if (!r.ok || !r.projectId) return;
    if (r.kind === 'project') navigate(`/pm-agent/p/${r.projectId}`);
    else if (r.kind === 'task' && r.id) navigate(`/pm-agent/p/${r.projectId}/task/${r.id}`);
    else if (r.kind === 'goal') navigate(`/pm-agent/p/${r.projectId}?tab=goals`);
    else if (r.kind === 'milestone') navigate(`/pm-agent/p/${r.projectId}?tab=milestones`);
  };
  return (
    <div className="flex flex-col gap-1.5" style={{ marginLeft: 36 }}>
      {items.map((r, i) => {
        const meta = ACTION_KIND_META[r.kind] ?? { label: r.kind, color: '#94A3B8' };
        if (!r.ok) {
          return (
            <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-red-400/30 bg-red-500/10 text-[12px] text-red-200">
              <CircleAlert size={14} className="shrink-0" />
              <span className="truncate">创建{meta.label}「{r.title}」失败：{r.error || '未知错误'}</span>
            </div>
          );
        }
        return (
          <button
            key={i}
            onClick={() => open(r)}
            className="group flex items-center gap-2 px-3 py-2 rounded-lg border border-white/10 bg-white/[0.03] hover:bg-blue-500/10 hover:border-blue-500/30 text-left"
          >
            <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ color: meta.color, background: `${meta.color}1a` }}>
              已创建{meta.label}
            </span>
            {r.projectTitle && r.kind !== 'project' && (
              <span className="text-[11px] text-white/40 shrink-0 truncate" style={{ maxWidth: 120 }}>{r.projectTitle}</span>
            )}
            <span className="text-[12px] text-white/85 truncate flex-1">{r.title}</span>
            <span className="flex items-center gap-1 text-[11px] text-blue-300/70 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              查看 <ExternalLink size={11} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** 用户消息行：头像在右，气泡右对齐；携带附件时在正文上方显示文件名胶囊。 */
function UserRow({ text, avatar, files }: { text: string; avatar: string; files?: string[] }) {
  return (
    <div className="flex items-start gap-2 justify-end">
      <div className="max-w-[80%] text-[13px] text-blue-50 bg-blue-500/15 border border-blue-500/25 rounded-2xl rounded-tr-sm px-3 py-2 whitespace-pre-wrap leading-relaxed">
        {files && files.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-1.5">
            {files.map((f, i) => (
              <span key={i} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 border border-blue-400/30 text-blue-100">
                <FileText size={10} /> {f}
              </span>
            ))}
          </div>
        )}
        {text}
      </div>
      <img src={avatar} alt="" referrerPolicy="no-referrer" className="w-7 h-7 rounded-full object-cover shrink-0 mt-0.5" />
    </div>
  );
}

/** AI 消息行：头像在左，气泡带底色+边框，hover 出现复制按钮（已完成的回答 text 传入）。 */
function AiRow({ text, streaming, children }: { text?: string; streaming?: boolean; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!text) return;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="flex items-start gap-2">
      <div className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center bg-blue-500/15 border border-blue-500/30 mt-0.5">
        <Sparkles size={14} className="text-blue-300" />
      </div>
      <div className="group relative max-w-[85%] text-[13px] text-white/85 bg-white/[0.04] border border-white/10 rounded-2xl rounded-tl-sm px-3 py-2 leading-relaxed whitespace-pre-wrap">
        {children ?? text}
        {!streaming && text && (
          <button
            onClick={copy}
            className="absolute -bottom-2.5 right-1 flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-[#1a1c22] border border-white/10 text-white/50 hover:text-white/90 opacity-0 group-hover:opacity-100 transition-opacity"
            title="复制内容"
          >
            {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? '已复制' : '复制'}
          </button>
        )}
      </div>
    </div>
  );
}
