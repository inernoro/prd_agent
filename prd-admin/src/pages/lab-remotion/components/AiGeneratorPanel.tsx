import { useState, useCallback, useRef } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { cn } from '@/lib/cn';
import { Sparkles, Loader2, AlertCircle, Wand2 } from 'lucide-react';
import { runModelLabStream } from '@/services';
import { REMOTION_SYSTEM_PROMPT, buildUserPrompt } from '../lib/remotionPrompt';
import { compileRemotionCode, type CompileResult } from '../lib/dynamicCompiler';
import { CodeEditor } from './CodeEditor';

interface AiGeneratorPanelProps {
  onGenerated: (result: CompileResult) => void;
  className?: string;
}

// 预设的示例 prompt
const EXAMPLE_PROMPTS = [
  { label: 'Matrix 代码雨', prompt: '创建一个 Matrix 风格的绿色代码雨效果，黑色背景，字符从上往下飘落' },
  { label: '故障文字', prompt: '创建一个 Glitch 故障风格的文字效果，文字是 "ERROR"，有抖动和颜色偏移' },
  { label: '呼吸光环', prompt: '创建一个呼吸灯效果的圆形光环，颜色在蓝色和紫色之间渐变，有脉冲动画' },
  { label: '弹跳文字', prompt: '创建一个文字逐个字母弹跳出现的动画，文字内容是 "Hello Remotion"' },
  { label: '粒子爆炸', prompt: '创建一个从中心向外爆炸的彩色粒子效果，粒子数量 50 个' },
  { label: '进度条', prompt: '创建一个炫酷的圆形进度条动画，从 0% 到 100%，带有数字显示' },
];

export function AiGeneratorPanel({ onGenerated, className }: AiGeneratorPanelProps) {
  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedCode, setGeneratedCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const abortControllerRef = useRef<AbortController | null>(null);

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim() || isGenerating) return;

    setIsGenerating(true);
    setError(null);
    setGeneratedCode('');
    setStreamingText('');

    abortControllerRef.current = new AbortController();

    try {
      let fullResponse = '';

      await runModelLabStream({
        input: {
          suite: 'custom',
          promptText: buildUserPrompt(prompt),
          systemPromptOverride: REMOTION_SYSTEM_PROMPT,
          includeMainModelAsStandard: true,  // 自动使用系统主模型
          params: {
            temperature: 0.7,
            maxTokens: 4000,
            timeoutMs: 60000,
            maxConcurrency: 1,
            repeatN: 1,
          },
        },
        onEvent: (event) => {
          if (!event.data) return;

          try {
            const parsed = JSON.parse(event.data);

            // 处理流式内容 - event: model + type: delta
            if (event.event === 'model' && parsed.type === 'delta' && parsed.content) {
              fullResponse += parsed.content;
              setStreamingText(fullResponse);
            }
            // 处理完成 - event: run + type: runDone
            else if (event.event === 'run' && parsed.type === 'runDone') {
              // 完成，尝试编译
              const result = compileRemotionCode(fullResponse);
              setGeneratedCode(result.code || fullResponse);

              if (result.success) {
                onGenerated(result);
              } else {
                setError(result.error || '编译失败');
              }
            }
            // 处理错误
            else if (parsed.type === 'error') {
              setError(parsed.errorMessage || parsed.message || '生成失败');
            }
          } catch {
            // 忽略解析错误
          }
        },
        signal: abortControllerRef.current.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setError(err.message);
      }
    } finally {
      setIsGenerating(false);
    }
  }, [prompt, isGenerating, onGenerated]);

  const handleCancel = useCallback(() => {
    abortControllerRef.current?.abort();
    setIsGenerating(false);
  }, []);

  const handleExampleClick = useCallback((examplePrompt: string) => {
    setPrompt(examplePrompt);
  }, []);

  const handleRetryCompile = useCallback(() => {
    if (generatedCode || streamingText) {
      const result = compileRemotionCode(generatedCode || streamingText);
      if (result.success) {
        setError(null);
        onGenerated(result);
      } else {
        setError(result.error || '编译失败');
      }
    }
  }, [generatedCode, streamingText, onGenerated]);

  const handleCodeChange = useCallback((newCode: string) => {
    setGeneratedCode(newCode);
    setError(null);
  }, []);

  const handleRunCode = useCallback((code: string) => {
    const result = compileRemotionCode(code);
    if (result.success) {
      setError(null);
      onGenerated(result);
    } else {
      setError(result.error || '编译失败');
    }
  }, [onGenerated]);

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {/* Prompt 输入区 */}
      <GlassCard padding="md" glow accentHue={270}>
        <div className="flex items-center gap-2 mb-3">
          <Wand2 size={16} className="text-purple-400" />
          <h3 className="text-sm font-medium text-[var(--text-primary)]">AI 动画生成</h3>
        </div>

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="描述你想要的动画效果...&#10;例如：创建一个 Matrix 风格的绿色代码雨效果"
          className="w-full h-24 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] resize-none focus:outline-none focus:border-purple-500/50"
          disabled={isGenerating}
        />

        <div className="flex gap-2 mt-3">
          {isGenerating ? (
            <button
              onClick={handleCancel}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
            >
              <Loader2 size={16} className="animate-spin" />
              取消生成
            </button>
          ) : (
            <button
              onClick={handleGenerate}
              disabled={!prompt.trim()}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-purple-500 hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors"
            >
              <Sparkles size={16} />
              生成动画
            </button>
          )}
        </div>
      </GlassCard>

      {/* 示例 Prompts */}
      <GlassCard padding="sm" variant="subtle">
        <div className="text-xs text-[var(--text-secondary)] mb-2">试试这些效果：</div>
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLE_PROMPTS.map((example) => (
            <button
              key={example.label}
              onClick={() => handleExampleClick(example.prompt)}
              className="px-2 py-1 text-xs rounded-md bg-white/5 hover:bg-white/10 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              disabled={isGenerating}
            >
              {example.label}
            </button>
          ))}
        </div>
      </GlassCard>

      {/* 错误提示 */}
      {error && (
        <GlassCard padding="sm" accentHue={0}>
          <div className="flex items-start gap-2 text-red-400">
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-sm">{error}</div>
              {(generatedCode || streamingText) && (
                <button
                  onClick={handleRetryCompile}
                  className="mt-2 text-xs underline hover:no-underline"
                >
                  重试编译
                </button>
              )}
            </div>
          </div>
        </GlassCard>
      )}

      {/* 生成的代码预览 / 编辑器 */}
      {(streamingText || generatedCode) && (
        <div className="flex-1 min-h-0 flex flex-col">
          {isGenerating ? (
            <GlassCard padding="none" className="flex-1 overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10">
                <Loader2 size={14} className="animate-spin text-purple-400" />
                <span className="text-xs text-[var(--text-secondary)]">正在生成...</span>
              </div>
              <pre className="p-3 text-xs font-mono text-[var(--text-secondary)] overflow-auto max-h-[300px] whitespace-pre-wrap">
                {streamingText}
              </pre>
            </GlassCard>
          ) : (
            <CodeEditor
              code={generatedCode || streamingText}
              onChange={handleCodeChange}
              onRun={handleRunCode}
              height={280}
              className="flex-1"
            />
          )}
        </div>
      )}
    </div>
  );
}
