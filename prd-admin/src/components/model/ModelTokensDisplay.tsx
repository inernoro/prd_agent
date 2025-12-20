import { ArrowDown, ArrowUp } from 'lucide-react';
import { formatCompactZh } from '@/lib/formatStats';
import { Tooltip } from '@/components/ui/Tooltip';
import { useState } from 'react';

/**
 * Tokens 合并显示组件：默认显示总量，hover 展开拆分
 */
export function ModelTokensDisplay({
  inputTokens,
  outputTokens,
}: {
  inputTokens: number;
  outputTokens: number;
  titlePrefix?: string;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const total = inputTokens + outputTokens;
  const totalText = total > 0 ? formatCompactZh(total) : null;
  const inputText = inputTokens > 0 ? formatCompactZh(inputTokens) : null;
  const outputText = outputTokens > 0 ? formatCompactZh(outputTokens) : null;

  if (!totalText) return null;

  return (
    <Tooltip
      content={
        <div className="flex flex-col gap-1">
          <div className="text-xs">
            <span style={{ color: 'rgba(168,85,247,0.95)' }}>输入: {inputText || '0'}</span>
          </div>
          <div className="text-xs">
            <span style={{ color: 'rgba(34,197,94,0.95)' }}>输出: {outputText || '0'}</span>
          </div>
        </div>
      }
    >
      <div
        className="flex items-center gap-1.5 cursor-help"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          {totalText}
        </span>
        {isHovered && (
          <div className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <span style={{ color: 'rgba(168,85,247,0.95)' }}>
              <ArrowDown size={10} className="inline" /> {inputText || '0'}
            </span>
            <span>/</span>
            <span style={{ color: 'rgba(34,197,94,0.95)' }}>
              <ArrowUp size={10} className="inline" /> {outputText || '0'}
            </span>
          </div>
        )}
      </div>
    </Tooltip>
  );
}

