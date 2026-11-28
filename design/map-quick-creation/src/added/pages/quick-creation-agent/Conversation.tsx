/**
 * 对话的两种说话人，一眼分得清：
 * - 你：靠右的主色浅底气泡，资料卡收在气泡里，下方一行写产出与模板；
 * - 快速创作：靠左，带头像与名字，不套气泡；它的状态（已保存、排队、进度、失败、完成）都是这一轮里的卡片，
 *   不再和你的消息交错成一列。
 */
import type { ReactNode } from 'react';
import { Sparkles } from 'lucide-react';

export function AgentTurn({ children, status }: { children: ReactNode; status?: ReactNode }) {
  return (
    <div className="qc-rise flex gap-2.5" data-turn="agent">
      <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] bg-[color:var(--accent-primary)] text-[color:var(--accent-on-primary)]" aria-hidden>
        <Sparkles size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex h-7 items-center gap-2 text-[12.5px]">
          <span className="font-medium text-token-primary">快速创作</span>
          {status && <span className="min-w-0 truncate text-token-muted">{status}</span>}
        </div>
        <div className="mt-1 flex flex-col gap-3">{children}</div>
      </div>
    </div>
  );
}

export function UserTurn({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <div className="qc-rise ml-auto flex w-full max-w-[92%] flex-col items-end gap-1.5" data-turn="user">
      {/* 气泡按内容收宽：一句话就一句话的宽，带资料卡时才撑开 */}
      <div className="flex w-fit max-w-full flex-col gap-2.5 rounded-[18px_18px_4px_18px] bg-[var(--selection-bg)] px-3 py-2.5">{children}</div>
      {meta && <div className="flex items-center gap-1.5 px-1 text-[11.5px] text-token-muted">{meta}</div>}
    </div>
  );
}
