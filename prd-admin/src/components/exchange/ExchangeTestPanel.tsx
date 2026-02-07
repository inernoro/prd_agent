import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { testExchange } from '@/services/real/exchanges';
import type { ModelExchange, ExchangeTestResult } from '@/types/exchange';
import {
  ArrowRight,
  Check,
  Loader2,
  Play,
  Eye,
  X,
  Clock,
} from 'lucide-react';
import { useState } from 'react';

const SAMPLE_REQUESTS: Record<string, string> = {
  passthrough: JSON.stringify(
    {
      messages: [{ role: 'user', content: 'Hello, how are you?' }],
      model: 'gpt-4o',
      max_tokens: 100,
    },
    null,
    2
  ),
  'fal-image-edit': JSON.stringify(
    {
      prompt: 'A beautiful sunset over the ocean',
      model: 'nano-banana-pro',
      n: 1,
      size: '1024x1024',
    },
    null,
    2
  ),
};

export function ExchangeTestPanel({
  exchange,
  onClose,
}: {
  exchange: ModelExchange;
  onClose: () => void;
}) {
  const [requestBody, setRequestBody] = useState(
    SAMPLE_REQUESTS[exchange.transformerType] ?? SAMPLE_REQUESTS.passthrough ?? '{}'
  );
  const [result, setResult] = useState<ExchangeTestResult | null>(null);
  const [loading, setLoading] = useState(false);

  const handleTest = async (dryRun: boolean) => {
    setLoading(true);
    setResult(null);
    try {
      const res = await testExchange(exchange.id, requestBody, dryRun);
      if (res.success) {
        setResult(res.data);
      } else {
        setResult({
          standardRequest: requestBody,
          transformedRequest: null,
          rawResponse: null,
          transformedResponse: null,
          error: res.error?.message ?? '请求失败',
          httpStatus: null,
          durationMs: null,
        });
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* 头部信息 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">测试中继:</span>
          <span className="font-medium">{exchange.name}</span>
          <code className="px-1.5 py-0.5 rounded bg-muted/40 font-mono text-[11px]">
            {exchange.transformerType}
          </code>
          <ArrowRight size={14} className="text-muted-foreground" />
          <span className="text-muted-foreground truncate max-w-[300px]">{exchange.targetUrl}</span>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground">
          <X size={16} />
        </button>
      </div>

      {/* 输入区域 */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-sm font-medium">标准请求体 (OpenAI 格式)</label>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleTest(true)}
              disabled={loading}
            >
              <Eye size={13} className="mr-1" />
              仅预览转换
            </Button>
            <Button
              size="sm"
              onClick={() => handleTest(false)}
              disabled={loading}
            >
              {loading ? (
                <Loader2 size={13} className="mr-1 animate-spin" />
              ) : (
                <Play size={13} className="mr-1" />
              )}
              发送测试
            </Button>
          </div>
        </div>
        <textarea
          className="w-full px-3 py-2 rounded-lg border border-border bg-background text-xs font-mono resize-none"
          rows={6}
          value={requestBody}
          onChange={e => setRequestBody(e.target.value)}
          spellCheck={false}
        />
      </div>

      {/* 结果区域：三列 */}
      {result && (
        <div className="space-y-3">
          {/* 状态栏 */}
          <div className="flex items-center gap-3 text-xs">
            {result.isDryRun && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full"
                style={{ background: 'rgba(59,130,246,0.12)', color: 'rgba(59,130,246,0.95)', border: '1px solid rgba(59,130,246,0.28)' }}>
                <Eye size={11} /> 预览模式
              </span>
            )}
            {result.httpStatus != null && (
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full"
                style={
                  result.httpStatus >= 200 && result.httpStatus < 300
                    ? { background: 'rgba(34,197,94,0.12)', color: 'rgba(34,197,94,0.95)', border: '1px solid rgba(34,197,94,0.28)' }
                    : { background: 'rgba(239,68,68,0.12)', color: 'rgba(239,68,68,0.95)', border: '1px solid rgba(239,68,68,0.28)' }
                }
              >
                {result.httpStatus >= 200 && result.httpStatus < 300 ? <Check size={11} /> : <X size={11} />}
                HTTP {result.httpStatus}
              </span>
            )}
            {result.durationMs != null && (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Clock size={11} /> {result.durationMs}ms
              </span>
            )}
            {result.error && (
              <span className="text-destructive">{result.error}</span>
            )}
          </div>

          {/* 三列面板 */}
          <div className="grid grid-cols-3 gap-3">
            {/* 第一列：转换后的请求 */}
            <GlassCard className="p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <span className="w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center text-[10px] font-bold">1</span>
                转换后请求
              </div>
              <pre className="text-[11px] font-mono text-foreground/80 whitespace-pre-wrap break-all max-h-[320px] overflow-auto bg-muted/20 rounded p-2">
                {result.transformedRequest ?? '(转换失败)'}
              </pre>
            </GlassCard>

            {/* 第二列：原始响应 */}
            <GlassCard className="p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <span className="w-5 h-5 rounded-full bg-amber-500/15 text-amber-500 flex items-center justify-center text-[10px] font-bold">2</span>
                原始响应
              </div>
              <pre className="text-[11px] font-mono text-foreground/80 whitespace-pre-wrap break-all max-h-[320px] overflow-auto bg-muted/20 rounded p-2">
                {result.rawResponse ?? (result.isDryRun ? '(预览模式，未发送请求)' : '(无响应)')}
              </pre>
            </GlassCard>

            {/* 第三列：标准化响应 */}
            <GlassCard className="p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <span className="w-5 h-5 rounded-full bg-green-500/15 text-green-500 flex items-center justify-center text-[10px] font-bold">3</span>
                标准化响应
              </div>
              <pre className="text-[11px] font-mono text-foreground/80 whitespace-pre-wrap break-all max-h-[320px] overflow-auto bg-muted/20 rounded p-2">
                {result.transformedResponse ?? (result.isDryRun ? '(预览模式，未发送请求)' : '(转换失败或无数据)')}
              </pre>
            </GlassCard>
          </div>
        </div>
      )}
    </div>
  );
}
