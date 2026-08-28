/**
 * 「一键整理」区块 —— 对齐设计稿 B3。
 *
 * 稿面是一张 2×2 的整理方式网格，每张卡回答「这一种整理现在是什么状态」，
 * 网格下面是一条虚线的「自定义整理要求」，再下面是这次整理出来的结果。
 *
 * 整理方式清单来自后端注册表（`GET /api/document-store/transcribe-styles`），
 * **不在前端另抄一份**——后端加一种方式，这里就多一张卡，不需要改代码
 * （frontend-architecture：前端不维护业务映射表）。
 *
 * 状态判定在 `organizeStyles.ts` 里，是纯函数、有单测；这里只负责画。
 */
import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { listTranscribeStyles } from '@/services/real/documentStore';
import {
  describeOrganizeCards,
  type OrganizeStyle,
  type OrganizeCard,
} from '@/pages/document-store/organizeStyles';

export type OrganizeState = {
  /** 当前这份摘要用的整理方式（笔记条目的 transcribe_style_key） */
  currentStyleKey?: string | null;
  /** 这份摘要的生成时间（笔记条目的 updatedAt） */
  generatedAt?: string | null;
  /** 正在跑的那一种 */
  runningStyleKey?: string | null;
  /** 在途进度 0-100 */
  runningPercent?: number | null;
};

function StyleCard({ card, onPick }: { card: OrganizeCard; onPick: (key: string) => void }) {
  const done = card.state === 'done';
  const running = card.state === 'running';
  return (
    <button
      type="button"
      onClick={() => onPick(card.key)}
      title={card.description}
      // 稿面：已生成那张是黑底反白（当前生效的那一种，视觉最重），其余是白卡描边
      className="flex min-h-[72px] flex-col justify-center rounded-[14px] px-4 py-3 text-left"
      style={{
        background: done ? 'var(--button-primary-bg)' : 'var(--bg-card)',
        color: done ? 'var(--button-primary-fg)' : 'var(--text-primary)',
        border: done ? 'none' : '1px solid var(--border-faint)',
      }}
    >
      <span className="text-[14px] font-semibold">{card.label}</span>
      <span
        className="mt-0.5 text-[11.5px]"
        style={{
          // 生成中用强调色（它是这一刻唯一在动的东西）；已生成那张在黑底上要压一档亮度
          color: running ? 'var(--accent-fg-info)'
            : done ? 'color-mix(in srgb, var(--button-primary-fg) 62%, transparent)'
              : 'var(--text-muted)',
        }}
      >
        {card.hint}
      </span>
    </button>
  );
}

export function OrganizeStylePanel({
  state,
  onPick,
  allowCustom,
  resultText,
}: {
  state: OrganizeState;
  /**
   * 选了某种整理方式：宿主去发起 restyle。
   * 自定义那一条会带上用户写的要求（`styleKey: 'custom'` + `customPrompt`）。
   */
  onPick: (styleKey: string, customPrompt?: string) => void;
  /**
   * 是否提供「自定义整理要求」入口。它此前是一个 `onCustom` 回调，宿主接的却是
   * 「按当前这一种再整理一次」——点下去从不问要求，直接又跑了一遍预设风格
   * （Codex P2）。要求本来就该在这张面板里收，所以入口收回组件内部：
   * 展开一个输入框，写完再走同一个 `onPick`。
   */
  allowCustom?: boolean;
  /**
   * 结果卡正文（当前这份摘要的开头一段）；为空时不渲染结果卡。
   * 卡上那个小标签由本组件从注册表里取——宿主不必再传一份方式名，
   * 传了就会和网格上那张卡的名字各自漂移（形状 3）。
   */
  resultText?: string;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const [customPrompt, setCustomPrompt] = useState('');
  const [styles, setStyles] = useState<OrganizeStyle[]>([]);
  useEffect(() => {
    let stale = false;
    listTranscribeStyles()
      .then((res) => {
        if (stale || !res.success) return;
        setStyles(res.data?.items ?? []);
      })
      // 拉不到就不画网格，而不是退回一份前端硬编码的清单——
      // 那份清单会和后端注册表各自漂移（形状 3）
      .catch(() => undefined);
    return () => { stale = true; };
  }, []);

  // 「多久之前」要跟着走，否则停在「12 秒前」不动
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, []);

  const cards = useMemo(
    () => describeOrganizeCards(styles, { ...state, now: tick }),
    [state, styles, tick],
  );

  // 结果卡的小标签 = 当前生效的那一种整理方式，取自同一份 cards，与网格上那张黑卡同源
  const doneCard = cards.find(card => card.state === 'done');

  if (cards.length === 0) return null;

  return (
    <section style={{ scrollMarginTop: 100 }}>
      <div className="mb-2 flex items-baseline justify-between gap-2 px-1">
        <h3 className="text-[19px] font-bold text-token-primary" style={{ scrollMarginTop: 100 }}>一键整理</h3>
        {/* 稿面这句是承诺，不是说明文：整理只写摘要节，原始录音与原文一个字都不动 */}
        <span className="text-[11px] text-token-muted">不会修改原始录音与原文</span>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        {cards.map(card => <StyleCard key={card.key} card={card} onPick={onPick} />)}
      </div>

      {allowCustom && !customOpen && (
        <button
          type="button"
          onClick={() => setCustomOpen(true)}
          // 稿面这条是虚线框：它和上面四张不是同一类——上面是选一种现成的，这条是自己描述
          className="mt-2.5 flex min-h-12 w-full cursor-pointer items-center justify-center gap-1.5 rounded-[14px] text-[13px]"
          style={{ border: '1px dashed var(--border-default)', color: 'var(--text-secondary)' }}
        >
          <Plus size={14} /> 自定义整理要求
        </button>
      )}

      {allowCustom && customOpen && (
        <div
          className="mt-2.5 rounded-[14px] p-3"
          style={{ border: '1px dashed var(--border-default)', background: 'var(--bg-card)' }}
        >
          <textarea
            value={customPrompt}
            onChange={(event) => setCustomPrompt(event.target.value)}
            rows={3}
            autoFocus
            placeholder="想要什么样的整理？例如：按人物分段，只保留结论和待办"
            aria-label="自定义整理要求"
            className="w-full resize-none bg-transparent text-[13px] leading-relaxed outline-none"
            style={{ color: 'var(--text-primary)' }}
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={!customPrompt.trim()}
              onClick={() => {
                const prompt = customPrompt.trim();
                if (!prompt) return;
                setCustomOpen(false);
                onPick('custom', prompt);
              }}
              className="flex min-h-9 min-w-[64px] cursor-pointer items-center justify-center rounded-[8px] px-4 text-[12px] font-semibold disabled:opacity-50"
              style={{ background: 'var(--accent-fg-info)', color: 'var(--bg-card)' }}
            >
              开始整理
            </button>
            <button
              type="button"
              onClick={() => setCustomOpen(false)}
              className="flex min-h-9 min-w-[64px] cursor-pointer items-center justify-center rounded-[8px] px-4 text-[12px] font-semibold"
              style={{ border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {resultText && (
        <article
          className="mt-3 rounded-[14px] p-4"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-faint)' }}
        >
          {doneCard && <p className="mb-1.5 text-[11px] text-token-muted">{doneCard.label}</p>}
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-token-secondary">{resultText}</p>
        </article>
      )}
    </section>
  );
}
