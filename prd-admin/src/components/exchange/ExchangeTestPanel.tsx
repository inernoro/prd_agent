import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { testExchange } from '@/services/real/exchanges';
import type { ModelExchange, ExchangeTestResult } from '@/types/exchange';
import {
  ArrowRight,
  Check,
  Code,
  ImagePlus,
  Link,
  Loader2,
  Play,
  Eye,
  Upload,
  X,
  Clock,
} from 'lucide-react';
import { useRef, useState } from 'react';

/** 转换器是否为 fal.ai 图片类型 */
function isFalImageType(type: string) {
  return ['fal-image', 'fal-image-edit'].includes(type);
}

/** 将 File 转为 base64 data URI（fal.ai 原生支持） */
function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const SIZE_OPTIONS = [
  { value: '512x512', label: '512 × 512' },
  { value: '1024x1024', label: '1024 × 1024' },
  { value: '1024x1792', label: '1024 × 1792 (竖版)' },
  { value: '1792x1024', label: '1792 × 1024 (横版)' },
];

/** 截断长 URL/DataURI 用于展示 */
function truncateUrl(url: string, max = 35): string {
  if (url.startsWith('data:')) return `data:image/… (${Math.round(url.length / 1024)}KB)`;
  return url.length > max ? url.slice(0, max) + '…' : url;
}

export function ExchangeTestPanel({
  exchange,
  onClose,
}: {
  exchange: ModelExchange;
  onClose: () => void;
}) {
  const showVisual = isFalImageType(exchange.transformerType);
  const [mode, setMode] = useState<'visual' | 'json'>(showVisual ? 'visual' : 'json');

  // ===== Visual form state =====
  const [prompt, setPrompt] = useState('a futuristic city skyline at sunset with flying cars');
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [size, setSize] = useState('1024x1024');
  const [numImages, setNumImages] = useState(1);
  const [urlInput, setUrlInput] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ===== JSON mode state =====
  const [requestBody, setRequestBody] = useState(() => {
    if (!showVisual) {
      return JSON.stringify(
        { messages: [{ role: 'user', content: 'Hello, how are you?' }], model: 'gpt-4o', max_tokens: 100 },
        null, 2
      );
    }
    return '{}';
  });

  // ===== Result state =====
  const [result, setResult] = useState<ExchangeTestResult | null>(null);
  const [loading, setLoading] = useState(false);

  // Build JSON from visual form
  const buildJsonFromForm = () => {
    const body: Record<string, unknown> = {
      prompt,
      model: 'auto',
      n: numImages,
      size,
    };
    if (imageUrls.length > 0) {
      body.image_urls = imageUrls;
    }
    return JSON.stringify(body, null, 2);
  };

  // Sync visual → JSON when switching
  const switchToJson = () => {
    if (mode === 'visual') setRequestBody(buildJsonFromForm());
    setMode('json');
  };

  const switchToVisual = () => {
    if (mode === 'json') {
      try {
        const obj = JSON.parse(requestBody);
        if (obj.prompt) setPrompt(obj.prompt);
        if (Array.isArray(obj.image_urls)) setImageUrls(obj.image_urls);
        if (obj.size) setSize(obj.size);
        if (obj.n) setNumImages(obj.n);
      } catch { /* ignore parse error */ }
    }
    setMode('visual');
  };

  // Handle test
  const handleTest = async (dryRun: boolean) => {
    const body = mode === 'visual' ? buildJsonFromForm() : requestBody;
    setLoading(true);
    setResult(null);
    try {
      const res = await testExchange(exchange.id, body, dryRun);
      if (res.success) {
        setResult(res.data);
      } else {
        setResult({
          standardRequest: body,
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

  // Image upload → base64 data URI（fal.ai 原生支持 data URI）
  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const dataUri = await fileToDataUri(file);
        setImageUrls(prev => [...prev, dataUri]);
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const addUrlInput = () => {
    const url = urlInput.trim();
    if (!url) return;
    setImageUrls(prev => [...prev, url]);
    setUrlInput('');
  };

  const removeImage = (idx: number) => {
    setImageUrls(prev => prev.filter((_, i) => i !== idx));
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files.length > 0) {
      handleFileUpload(e.dataTransfer.files);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
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

      {/* 模式切换 + 操作按钮 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          {showVisual && (
            <>
              <button
                className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md transition-colors ${
                  mode === 'visual'
                    ? 'bg-primary/15 text-primary border border-primary/30'
                    : 'bg-muted/40 text-muted-foreground hover:bg-muted/60 border border-transparent'
                }`}
                onClick={switchToVisual}
              >
                <ImagePlus size={12} /> 可视化
              </button>
              <button
                className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md transition-colors ${
                  mode === 'json'
                    ? 'bg-primary/15 text-primary border border-primary/30'
                    : 'bg-muted/40 text-muted-foreground hover:bg-muted/60 border border-transparent'
                }`}
                onClick={switchToJson}
              >
                <Code size={12} /> JSON
              </button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => handleTest(true)} disabled={loading}>
            <Eye size={13} className="mr-1" /> 仅预览转换
          </Button>
          <Button size="sm" onClick={() => handleTest(false)} disabled={loading}>
            {loading ? <Loader2 size={13} className="mr-1 animate-spin" /> : <Play size={13} className="mr-1" />}
            发送测试
          </Button>
        </div>
      </div>

      {/* ===== 可视化模式：左右两栏 ===== */}
      {mode === 'visual' && showVisual && (
        <div className="space-y-3">
          {/* 两栏：左边 prompt，右边图片 */}
          <div className="grid grid-cols-2 gap-4">
            {/* 左栏：提示词 */}
            <div className="space-y-1">
              <label className="block text-sm font-medium">提示词 (Prompt)</label>
              <textarea
                className="w-full h-[200px] px-3 py-2 rounded-lg border border-border bg-background text-sm resize-none"
                placeholder="描述你想生成的图片..."
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
              />
            </div>

            {/* 右栏：参考图片 */}
            <div className="space-y-1">
              <label className="block text-sm font-medium">
                参考图片
                <span className="text-muted-foreground font-normal ml-1">(有 → 图生图，无 → 文生图)</span>
              </label>

              <div className="h-[200px] flex flex-col">
                {/* 已添加的图片 */}
                {imageUrls.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-1.5 max-h-[100px] overflow-auto">
                    {imageUrls.map((url, idx) => (
                      <div key={idx} className="group relative">
                        <div className="w-[72px] h-[72px] rounded-lg border border-border overflow-hidden bg-muted/30 flex items-center justify-center">
                          {url.startsWith('data:') ? (
                            <img src={url} alt={`图 ${idx + 1}`} className="w-full h-full object-cover" />
                          ) : (
                            <img
                              src={url}
                              alt={`图 ${idx + 1}`}
                              className="w-full h-full object-cover"
                              onError={e => {
                                const el = e.target as HTMLImageElement;
                                el.style.display = 'none';
                                const parent = el.parentElement;
                                if (parent) {
                                  const fallback = document.createElement('div');
                                  fallback.className = 'text-muted-foreground text-[8px] p-1 text-center break-all leading-tight';
                                  fallback.textContent = truncateUrl(url, 30);
                                  parent.appendChild(fallback);
                                }
                              }}
                            />
                          )}
                        </div>
                        <button
                          className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-destructive text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={() => removeImage(idx)}
                        >
                          <X size={8} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* 上传拖拽区 */}
                <div
                  className={`flex-1 min-h-[60px] border-2 border-dashed border-border/60 rounded-lg flex items-center justify-center hover:border-primary/40 transition-colors cursor-pointer ${
                    imageUrls.length > 0 ? '' : ''
                  }`}
                  onClick={() => !uploading && fileInputRef.current?.click()}
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={e => handleFileUpload(e.target.files)}
                  />
                  {uploading ? (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 size={13} className="animate-spin" /> 转换中...
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Upload size={13} />
                      点击或拖拽上传
                      <span className="text-[10px] text-muted-foreground/50">(转为 Base64)</span>
                    </span>
                  )}
                </div>

                {/* URL 粘贴 */}
                <div className="flex items-center gap-1.5 mt-1.5">
                  <Link size={11} className="text-muted-foreground shrink-0" />
                  <input
                    className="flex-1 px-2 py-1 rounded border border-border bg-background text-[11px]"
                    placeholder="粘贴图片 URL..."
                    value={urlInput}
                    onChange={e => setUrlInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') addUrlInput(); }}
                  />
                  <button
                    className="px-2 py-1 text-[11px] rounded border border-border hover:bg-muted/50 text-muted-foreground disabled:opacity-40"
                    onClick={addUrlInput}
                    disabled={!urlInput.trim()}
                  >
                    添加
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* 底部一行：尺寸 + 数量 */}
          <div className="grid grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1 text-muted-foreground">尺寸</label>
              <select
                className="w-full px-2.5 py-1.5 rounded-lg border border-border bg-background text-sm"
                value={size}
                onChange={e => setSize(e.target.value)}
              >
                {SIZE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1 text-muted-foreground">生成数量</label>
              <input
                type="number"
                min={1}
                max={4}
                className="w-full px-2.5 py-1.5 rounded-lg border border-border bg-background text-sm"
                value={numImages}
                onChange={e => setNumImages(Math.max(1, parseInt(e.target.value) || 1))}
              />
            </div>
          </div>
        </div>
      )}

      {/* ===== JSON 模式 ===== */}
      {mode === 'json' && (
        <div>
          <label className="block text-sm font-medium mb-1">标准请求体 (OpenAI 格式)</label>
          <textarea
            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-xs font-mono resize-none"
            rows={8}
            value={requestBody}
            onChange={e => setRequestBody(e.target.value)}
            spellCheck={false}
          />
        </div>
      )}

      {/* 结果区域 */}
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
            <GlassCard className="p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <span className="w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center text-[10px] font-bold">1</span>
                转换后请求
              </div>
              <pre className="text-[11px] font-mono text-foreground/80 whitespace-pre-wrap break-all max-h-[320px] overflow-auto bg-muted/20 rounded p-2">
                {result.transformedRequest ?? '(转换失败)'}
              </pre>
            </GlassCard>

            <GlassCard className="p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <span className="w-5 h-5 rounded-full bg-amber-500/15 text-amber-500 flex items-center justify-center text-[10px] font-bold">2</span>
                原始响应
              </div>
              <pre className="text-[11px] font-mono text-foreground/80 whitespace-pre-wrap break-all max-h-[320px] overflow-auto bg-muted/20 rounded p-2">
                {result.rawResponse ?? (result.isDryRun ? '(预览模式，未发送请求)' : '(无响应)')}
              </pre>
            </GlassCard>

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
