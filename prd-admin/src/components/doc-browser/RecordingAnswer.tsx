/**
 * 「问这场录音」的回答区 —— 对齐设计稿 B4。
 *
 * 稿面把回答排成三段：
 *   提问气泡（右对齐） → 「结论」+ 答案正文 → 「引用录音 · N 处」+ 引用卡
 *
 * 引用是从正文里**提出来**的，不是正文里一颗时间药丸：药丸点得到，
 * 但读者看不出被引的是哪句话，得自己跳过去看。提成卡片之后，
 * 「结论」和「凭什么这么说」并排摆着。
 *
 * 单独成文件而不是留在 `TranscriptKaraoke` 里，是为了让**对照台**能用同一份组件
 * 喂一份定稿回答出图——否则台架要么在组件上开一个只给测试用的后门，
 * 要么照着重画一遍（那样判分判的是副本，真组件改了副本不会跟着变，形状 6）。
 */
import { Play } from 'lucide-react';
import { resolveAnswerCitations } from '@/components/doc-browser/transcriptSegments';

/** mm:ss，与转录列表同一口径（分钟补两位）。 */
function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '';
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

export function RecordingAnswer({
  question,
  answer,
  segments,
  onSeek,
}: {
  /** 这条回答对应的提问；为空则不渲染气泡 */
  question?: string;
  answer: string;
  segments: Array<{ start: number; end: number; text: string; speaker?: string }>;
  onSeek?: (sec: number) => void;
}) {
  const { conclusion, citations } = resolveAnswerCitations(answer, segments);
  if (!answer) return null;

  return (
    <div
      className="mt-3 rounded-[11px] p-3"
      // 稿面这张卡是「深底 + 1px 亮边」：描边把它和页面底色分开，纯填充块少一层层次
      style={{ background: 'var(--bg-nested)', border: '1px solid var(--border-faint)' }}
      aria-live="polite"
    >
      {question && (
        <p
          className="mb-3 ml-auto w-fit max-w-[85%] rounded-[12px] px-3 py-2 text-[13px] leading-relaxed"
          style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}
        >
          {question}
        </p>
      )}
      <p className="text-[11px] font-semibold" style={{ color: 'var(--accent-fg-success)' }}>结论</p>
      {/*
        稿面这段结论是**大号常规字重**的陈述句，明显大过卡里其余文字——它就是这张卡的答案本身。
        压成小号粗体之后，它和「引用录音 · N 处」那类标签落在同一档，读者一眼看不出哪句才是回答。
      */}
      <p className="mt-1 whitespace-pre-wrap text-[18px] font-medium leading-relaxed text-token-primary">
        {conclusion}
      </p>
      {citations.length > 0 && (
        <>
          <p className="mt-3 text-[11px] text-token-muted">引用录音 · {citations.length} 处</p>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {citations.map(citation => (
              <button
                key={citation.start}
                type="button"
                onClick={() => onSeek?.(citation.start)}
                className="flex items-center gap-3 rounded-[11px] p-2.5 text-left"
                style={{ background: 'var(--bg-elevated)' }}
                title="从引用位置播放"
              >
                <span
                  className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full"
                  style={{ background: 'var(--accent-fg-info)', color: 'var(--bg-card)' }}
                  aria-hidden
                >
                  <Play size={13} fill="currentColor" style={{ marginLeft: 1 }} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-[13px] leading-relaxed text-token-primary">{citation.text}</span>
                  <span className="mt-0.5 block text-[11px] text-token-muted">
                    {formatClock(citation.start)}{citation.speaker ? ` · ${citation.speaker}` : ''}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px]" style={{ color: 'var(--accent-fg-info)' }}>点击引用即播放对应片段</p>
        </>
      )}
    </div>
  );
}
