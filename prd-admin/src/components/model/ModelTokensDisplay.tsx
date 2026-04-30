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
            <span className="text-token-count-input">输入: {inputText || '0'}</span>
          </div>
          <div className="text-xs">
            <span className="text-token-count-output">输出: {outputText || '0'}</span>
          </div>
        </div>
      }
    >
      <div
        className="flex items-center gap-1.5 cursor-help"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <span className="text-[13px] font-semibold text-token-primary">
          {totalText}
        </span>
        {isHovered && (
          <div className="flex items-center gap-1 text-[11px] text-token-muted">
            <span className="text-token-count-input">
              <ArrowDown size={10} className="inline" /> {inputText || '0'}
            </span>
            <span>/</span>
            <span className="text-token-count-output">
              <ArrowUp size={10} className="inline" /> {outputText || '0'}
            </span>
          </div>
        )}
      </div>
    </Tooltip>
  );
}
