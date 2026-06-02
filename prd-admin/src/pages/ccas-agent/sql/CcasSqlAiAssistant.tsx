import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, Copy, Eraser, Database, StopCircle, AlertCircle } from 'lucide-react';
import { connectSse } from '@/lib/useSseStream';
import {
  CCAS_SQL_AI_STREAM_URL,
  CCAS_SQL_AI_DIALECTS,
  CCAS_SQL_AI_ASSOCIATION_MODES,
  type CcasSqlAiDialect,
  type CcasSqlAiAssociationMode,
} from '@/services';
import { Button } from '@/components/design/Button';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { toast } from '@/lib/toast';

interface ModelInfo {
  name?: string;
  platform?: string;
}

const QUICK_EXAMPLES = [
  '查 1109070016 这个箱码下挂了几个盒码，按采集时间排序',
  '找出 8 位箱码且关联超过 4 个盒码的异常箱',
  '重置石湾 2 号机里 Status=4 / 5 且 Msg="xx 不在码包范围内" 的记录',
];

function safeJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 从流式 markdown 文本里提取所有 ```sql 代码块，多块时按出现顺序用空行连接。
 * 提取失败 / 没有代码块时返回原文，让用户能复制完整答复。
 */
function extractSqlBlocks(markdown: string): string {
  if (!markdown) return '';
  const re = /```(?:sql|SQL|tsql|mysql)?\s*([\s\S]*?)```/g;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const body = (m[1] ?? '').trim();
    if (body) blocks.push(body);
  }
  return blocks.length > 0 ? blocks.join('\n\n') : markdown.trim();
}

/**
 * CCAS SQL 助手 AI 子 tab。
 *
 * 行为：
 *   - 顶部选数据库版本（陈智版 / 米多版 MySQL / 米多版 SQL Server），陈智版另选关联模式
 *   - 中部输入框 + 三个示例快捷
 *   - 提交后 SSE 流式接收 phase / model / typing / done / error 事件
 *   - 输出区用 MarkdownContent 渲染（自动给 ```sql 代码块语法高亮）
 *   - 复制 SQL 按钮智能提取代码块（多块连接），抽不出来就复制全文
 *   - 中止按钮：本地 AbortController.abort，后端继续完整跑（server-authority 规则）
 *   - 顶部模型徽章按 ai-model-visibility 强制规则展示
 */
export function CcasSqlAiAssistant() {
  const [dialect, setDialect] = useState<CcasSqlAiDialect>('chenzhi-mssql');
  const [associationMode, setAssociationMode] = useState<CcasSqlAiAssociationMode>('bottle-pack-box-stack');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [model, setModel] = useState<ModelInfo>({});
  const [phaseMsg, setPhaseMsg] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string>(`sql-ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  useEffect(() => () => abortRef.current?.abort(), []);

  const showAssociationPicker = dialect === 'chenzhi-mssql';

  const handleGenerate = useCallback(async () => {
    const q = question.trim();
    if (!q) {
      toast.warning('请输入问题');
      return;
    }
    if (streaming) return;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setAnswer('');
    setModel({});
    setErrorMsg(null);
    setPhaseMsg('连接中…');
    setStreaming(true);

    const body = {
      dialect,
      associationMode: showAssociationPicker ? associationMode : undefined,
      question: q,
      sessionId: sessionIdRef.current,
    };

    const { success, errorMessage } = await connectSse({
      url: CCAS_SQL_AI_STREAM_URL,
      method: 'POST',
      body,
      signal: ac.signal,
      onEvent: (evt) => {
        const data = evt.data ? safeJson(evt.data) : null;
        if (!data) return;
        switch (evt.event) {
          case 'phase':
            if (typeof data.message === 'string') setPhaseMsg(data.message);
            break;
          case 'model':
            setModel({
              name: typeof data.model === 'string' ? data.model : undefined,
              platform: typeof data.platform === 'string' ? data.platform : undefined,
            });
            break;
          case 'typing':
            if (typeof data.text === 'string') {
              setAnswer((prev) => prev + data.text);
            }
            break;
          case 'done':
            setStreaming(false);
            setPhaseMsg('生成完成');
            break;
          case 'error':
            setStreaming(false);
            setErrorMsg(typeof data.message === 'string' ? data.message : '生成失败');
            setPhaseMsg('');
            break;
        }
      },
    });

    if (!success && !ac.signal.aborted) {
      setStreaming(false);
      setErrorMsg(errorMessage || '连接失败');
      setPhaseMsg('');
    }
  }, [question, streaming, dialect, associationMode, showAssociationPicker]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
    setPhaseMsg('已中止（后端仍会跑完，日志可见）');
  }, []);

  const handleClear = useCallback(() => {
    abortRef.current?.abort();
    setQuestion('');
    setAnswer('');
    setModel({});
    setErrorMsg(null);
    setPhaseMsg('');
    setStreaming(false);
    sessionIdRef.current = `sql-ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }, []);

  const handleCopySql = useCallback(async () => {
    const sql = extractSqlBlocks(answer);
    if (!sql) {
      toast.warning('暂无可复制的内容');
      return;
    }
    try {
      await navigator.clipboard.writeText(sql);
      toast.success('SQL 已复制');
    } catch {
      toast.error('复制失败', '请手动选中代码块文本复制');
    }
  }, [answer]);

  const handleCopyAll = useCallback(async () => {
    if (!answer) {
      toast.warning('暂无可复制的内容');
      return;
    }
    try {
      await navigator.clipboard.writeText(answer);
      toast.success('完整答复已复制');
    } catch {
      toast.error('复制失败', '请手动选中文本复制');
    }
  }, [answer]);

  const modelChip = useMemo(() => {
    if (!model.name) return null;
    return (
      <div className="inline-flex items-center gap-1.5 text-[11px] text-white/45 font-mono">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400/80" />
        {model.name}
        {model.platform && <span className="text-white/30">· {model.platform}</span>}
      </div>
    );
  }, [model]);

  return (
    <div
      className="flex-1 min-h-0 flex flex-col gap-4"
      style={{ overflowY: 'auto', overscrollBehavior: 'contain', paddingRight: 4 }}
    >
      <div className="shrink-0 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-white/60">
          <Sparkles className="w-3.5 h-3.5 text-amber-300/85" />
          <span>把陈智版 / 米多版 schema 内化进提示词，自然语言提问即可。</span>
        </div>
        {modelChip}
      </div>

      <div className="shrink-0 rounded-xl border border-white/10 bg-white/[0.03] p-3 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <div className="text-[11px] text-white/45 flex items-center gap-1.5">
            <Database className="w-3 h-3" />
            数据库版本
          </div>
          <div className="flex flex-wrap gap-1.5">
            {CCAS_SQL_AI_DIALECTS.map((opt) => {
              const active = opt.value === dialect;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setDialect(opt.value)}
                  disabled={streaming}
                  data-active={active}
                  className="px-3 py-1.5 rounded-md text-xs border transition data-[active=true]:bg-amber-300/12 data-[active=true]:border-amber-300/55 data-[active=true]:text-amber-200 hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{
                    borderColor: active ? undefined : 'rgba(255,255,255,0.10)',
                    color: active ? undefined : 'rgba(255,255,255,0.75)',
                    background: active ? undefined : 'rgba(255,255,255,0.03)',
                  }}
                  title={opt.hint}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {showAssociationPicker && (
          <div className="flex flex-col gap-1.5">
            <div className="text-[11px] text-white/45">关联模式（陈智版 BagCode/BoxCode 语义随模式变化）</div>
            <div className="flex flex-wrap gap-1.5">
              {CCAS_SQL_AI_ASSOCIATION_MODES.map((opt) => {
                const active = opt.value === associationMode;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setAssociationMode(opt.value)}
                    disabled={streaming}
                    data-active={active}
                    className="px-2.5 py-1.5 rounded-md text-[11.5px] border transition data-[active=true]:bg-amber-300/12 data-[active=true]:border-amber-300/55 data-[active=true]:text-amber-200 hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{
                      borderColor: active ? undefined : 'rgba(255,255,255,0.10)',
                      color: active ? undefined : 'rgba(255,255,255,0.75)',
                      background: active ? undefined : 'rgba(255,255,255,0.03)',
                    }}
                    title={opt.hint}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 flex flex-col gap-2">
        <div className="text-[11px] text-white/45 flex items-center justify-between">
          <span>你的问题</span>
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-white/35">示例：</span>
            {QUICK_EXAMPLES.map((ex, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setQuestion(ex)}
                disabled={streaming}
                className="px-2 py-0.5 rounded text-[11px] text-white/55 hover:text-amber-200 hover:bg-amber-300/10 border border-white/8 hover:border-amber-300/35 transition disabled:opacity-50 disabled:cursor-not-allowed"
                title={ex}
              >
                {ex.length > 14 ? ex.slice(0, 14) + '…' : ex}
              </button>
            ))}
          </span>
        </div>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={4}
          placeholder="用大白话描述你想查 / 改什么数据；越具体效果越好。例：查 1109070016 这个箱码下挂了几个盒码，按采集时间排序"
          spellCheck={false}
          disabled={streaming}
          className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white/90 leading-relaxed placeholder:text-white/30 focus:outline-none focus:border-amber-300/40 transition disabled:opacity-60"
          style={{ resize: 'vertical', minHeight: 96 }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void handleGenerate();
            }
          }}
        />
        <div className="flex items-center gap-2">
          {streaming ? (
            <Button variant="danger" size="sm" onClick={handleStop}>
              <StopCircle className="w-3.5 h-3.5" />
              中止生成
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={handleGenerate} disabled={!question.trim()}>
              <Sparkles className="w-3.5 h-3.5" />
              生成 SQL
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={handleClear} disabled={!question && !answer}>
            <Eraser className="w-3.5 h-3.5" />
            清空
          </Button>
          <span className="text-[10.5px] text-white/35 ml-auto">Ctrl/Cmd + Enter 提交</span>
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-2" style={{ minHeight: 200 }}>
        <div className="shrink-0 flex items-center justify-between">
          <div className="text-[11px] text-white/45 flex items-center gap-2">
            <span>AI 答复</span>
            {streaming && phaseMsg && (
              <span className="text-amber-300/80 inline-flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-300/80 animate-pulse" />
                {phaseMsg}
              </span>
            )}
            {!streaming && phaseMsg && <span className="text-white/40">· {phaseMsg}</span>}
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="secondary" size="sm" onClick={handleCopySql} disabled={!answer}>
              <Copy className="w-3.5 h-3.5" />
              复制 SQL
            </Button>
            <Button variant="ghost" size="sm" onClick={handleCopyAll} disabled={!answer}>
              <Copy className="w-3.5 h-3.5" />
              复制全文
            </Button>
          </div>
        </div>

        {errorMsg && (
          <div className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-200/90 flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        <div
          className="flex-1 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {answer ? (
            <MarkdownContent content={answer} />
          ) : streaming ? (
            <div className="text-xs text-white/40">等待 AI 答复…</div>
          ) : (
            <div className="text-xs text-white/35 flex flex-col gap-1.5">
              <div>没有答复。先选数据库版本和关联模式（陈智版），描述你的问题再点「生成 SQL」。</div>
              <div className="text-white/30">提示：AI 只产出 SQL 文本，不会连数据库执行。请到 Navicat / DBeaver / SSMS 执行，并务必先在测试库验证。</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// 测试导出：纯函数 extractSqlBlocks 在 __tests__ 里断言
export const __test__ = { extractSqlBlocks };
