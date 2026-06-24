import { useEffect, useRef } from 'react';
import { api } from '@/services/api';
import { AiPreviewModal } from '@/components/streaming';
import { useAiPreviewStream } from '@/lib/useAiPreviewStream';

interface Props {
  open: boolean;
  text: string;
  onClose: () => void;
  onApply: (polished: string) => void;
}

/**
 * 日常记录 AI 润色弹窗 — 收编到通用 AiPreviewModal + useAiPreviewStream 实现。
 *
 * 历史: 原 234 行自有实现含 useSseStream 管理 + 自渲染 portal/header/footer/thinking 折叠面板。
 * 已全部移到通用基础设施 (doc/rule.frontend.streaming-text.md), 本文件只剩"打开时自动 start, apply 应用"
 * 这条粘合逻辑。
 */
export function DailyLogPolishPopover({ open, text, onClose, onApply }: Props) {
  const startedRef = useRef(false);

  const stream = useAiPreviewStream({
    url: api.reportAgent.dailyLogs.polish(),
    onApply: (final) => onApply(final),
  });

  // open 切换为 true 时自动 start 一次; 关闭时重置 startedRef 让下次 open 重新触发
  useEffect(() => {
    if (open && !startedRef.current) {
      startedRef.current = true;
      stream.start({ text });
    }
    if (!open) {
      startedRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 当用户从外部 close (icon X / ESC / 蒙版) 时, 调 onClose 通知父级
  const handleCancel = () => {
    stream.cancel();
    onClose();
  };

  const handleApply = () => {
    stream.apply();
    onClose();
  };

  return (
    <AiPreviewModal
      open={open && stream.open}
      text={stream.text}
      thinking={stream.thinking}
      streaming={stream.streaming}
      phaseMessage={stream.phaseMessage}
      error={stream.error}
      model={stream.model}
      title="AI 润色日常记录"
      subtitle="点击应用将替换为润色后的文本"
      onApply={handleApply}
      onCancel={handleCancel}
      onRegenerate={() => stream.regenerate({ text })}
      applyLabel="应用润色"
    />
  );
}
