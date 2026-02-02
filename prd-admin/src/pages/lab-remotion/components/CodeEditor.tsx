import Editor from '@monaco-editor/react';
import { GlassCard } from '@/components/design/GlassCard';
import { Code2, Copy, Check, Play } from 'lucide-react';
import { useState, useCallback } from 'react';

interface CodeEditorProps {
  code: string;
  onChange?: (code: string) => void;
  onRun?: (code: string) => void;
  readOnly?: boolean;
  height?: string | number;
  className?: string;
}

export function CodeEditor({
  code,
  onChange,
  onRun,
  readOnly = false,
  height = 300,
  className,
}: CodeEditorProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('复制失败', err);
    }
  }, [code]);

  const handleRun = useCallback(() => {
    onRun?.(code);
  }, [code, onRun]);

  return (
    <GlassCard padding="none" className={className}>
      {/* 工具栏 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <div className="flex items-center gap-2">
          <Code2 size={14} className="text-[var(--text-secondary)]" />
          <span className="text-xs text-[var(--text-secondary)]">
            {readOnly ? '生成的代码' : '代码编辑器'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {onRun && (
            <button
              onClick={handleRun}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-white/10 text-green-400 transition-colors"
              title="运行代码"
            >
              <Play size={12} />
              运行
            </button>
          )}
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-white/10 text-[var(--text-secondary)] transition-colors"
            title="复制代码"
          >
            {copied ? (
              <>
                <Check size={12} className="text-green-400" />
                <span className="text-green-400">已复制</span>
              </>
            ) : (
              <>
                <Copy size={12} />
                复制
              </>
            )}
          </button>
        </div>
      </div>

      {/* 编辑器 */}
      <Editor
        height={height}
        defaultLanguage="typescript"
        value={code}
        onChange={(value) => onChange?.(value || '')}
        theme="vs-dark"
        options={{
          readOnly,
          minimap: { enabled: false },
          fontSize: 13,
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          tabSize: 2,
          automaticLayout: true,
          padding: { top: 12, bottom: 12 },
          scrollbar: {
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8,
          },
          overviewRulerBorder: false,
          hideCursorInOverviewRuler: true,
          renderLineHighlight: 'none',
          contextmenu: false,
        }}
      />
    </GlassCard>
  );
}
