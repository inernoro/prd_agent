/**
 * 结业考 —— 一卷一套题，交卷给分并逐题讲解。
 *
 * 设计要点（对齐 expectation-management.md）：
 *  - 答题时随时能看到「第几题 / 共几题」与已答进度，不让人心里没底。
 *  - 交卷后不只给分数，**每道题都展开解析**：答错的人要能带走一条可执行的改法，
 *    否则这套题只是个游戏。
 *  - 未答完不禁用交卷，但会明确提示还剩几题（不做沉默的禁用按钮）。
 */
import { useMemo, useState } from 'react';
import { CheckCircle2, XCircle, RotateCcw, Award } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { questionsOf, isPassed, PASS_RATE } from '@/lib/bookshelf/exams';
import { useBookshelfStore } from '@/stores/bookshelfStore';
import type { Volume } from '@/lib/bookshelf/types';

export function ExamDialog({
  volume,
  open,
  onOpenChange,
}: {
  volume: Volume | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const questions = useMemo(() => (volume ? questionsOf(volume.id) : []), [volume]);
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const recordExam = useBookshelfStore((s) => s.recordExam);

  const answeredCount = Object.keys(picked).length;
  const correctCount = questions.filter((q) => picked[q.id] === q.answer).length;
  const passed = isPassed(correctCount, questions.length);

  function reset() {
    setPicked({});
    setSubmitted(false);
  }

  function handleSubmit() {
    if (!volume) return;
    setSubmitted(true);
    recordExam({
      volumeId: volume.id,
      correct: correctCount,
      total: questions.length,
      passed: isPassed(correctCount, questions.length),
      takenAt: new Date().toISOString(),
    });
  }

  function handleClose(v: boolean) {
    if (!v) reset();
    onOpenChange(v);
  }

  if (!volume) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={handleClose}
      maxWidth={780}
      title={`卷${'一二三四五六七'[volume.index - 1]} · ${volume.name} —— 结业考`}
      description={
        submitted
          ? undefined
          : `共 ${questions.length} 题，答对 ${Math.ceil(questions.length * PASS_RATE)} 题及格。考的是判断，不是记忆。`
      }
      content={
        <div className="flex flex-col gap-3.5">
          {submitted && (
            <div
              className="flex items-center gap-3 rounded-[7px] p-3.5"
              style={{
                background: passed ? 'var(--bg-tertiary)' : 'var(--bg-secondary)',
                border: `1px solid ${passed ? 'var(--accent-fg-emerald)' : 'var(--border-default)'}`,
              }}
            >
              <Award
                size={36}
                style={{ color: passed ? 'var(--accent-fg-emerald)' : 'var(--text-muted)' }}
              />
              <div className="min-w-0">
                <div className="text-[17px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {correctCount} / {questions.length} 题 —— {passed ? '通过' : '未通过'}
                </div>
                <div className="text-[12.5px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                  {passed
                    ? '这一卷的判断题你已经站得住。往下一卷走。'
                    : '下面每题都有解析，看完再来一次。错的地方正是这一卷要治的。'}
                </div>
              </div>
            </div>
          )}

          {questions.map((q, qi) => {
            const chosen = picked[q.id];
            const right = chosen === q.answer;
            return (
              <div
                key={q.id}
                className="rounded-[7px] p-3.5"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-secondary)' }}
              >
                <div className="flex items-start gap-2 mb-2.5">
                  <span
                    className="shrink-0 text-[12px] font-bold px-2 py-0.5 rounded-md"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                  >
                    {qi + 1}
                  </span>
                  <p className="text-[14px] font-medium leading-[1.7]" style={{ color: 'var(--text-primary)' }}>
                    {q.stem}
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  {q.options.map((opt, oi) => {
                    const isChosen = chosen === oi;
                    const isAnswer = oi === q.answer;
                    // 交卷后：正确项恒定标绿；选错的那项标红。未交卷只标选中态。
                    const showRight = submitted && isAnswer;
                    const showWrong = submitted && isChosen && !isAnswer;
                    return (
                      <button
                        key={oi}
                        type="button"
                        disabled={submitted}
                        onClick={() => setPicked((p) => ({ ...p, [q.id]: oi }))}
                        className="flex items-start gap-2.5 text-left px-3 py-2 rounded-[6px] transition-colors duration-[120ms]"
                        style={{
                          background: showRight
                            ? 'var(--bg-tertiary)'
                            : isChosen
                              ? 'var(--bg-tertiary)'
                              : 'transparent',
                          border: `1px solid ${
                            showRight
                              ? 'var(--accent-fg-emerald)'
                              : showWrong
                                ? 'var(--accent-fg-danger)'
                                : isChosen
                                  ? 'var(--border-default)'
                                  : 'var(--border-secondary)'
                          }`,
                          cursor: submitted ? 'default' : 'pointer',
                        }}
                      >
                        <span
                          className="shrink-0 text-[12px] font-bold mt-0.5 w-[18px] h-[18px] rounded-[4px] grid place-items-center"
                          style={{
                            background: isChosen || showRight ? 'var(--bg-card-hover)' : 'transparent',
                            border: '1px solid var(--border-subtle)',
                            color: 'var(--text-secondary)',
                          }}
                        >
                          {'ABCD'[oi]}
                        </span>
                        <span className="text-[13px] leading-[1.7]" style={{ color: 'var(--text-primary)' }}>
                          {opt}
                        </span>
                        {showRight && (
                          <CheckCircle2 size={16} className="shrink-0 ml-auto mt-0.5" style={{ color: 'var(--accent-fg-emerald)' }} />
                        )}
                        {showWrong && (
                          <XCircle size={16} className="shrink-0 ml-auto mt-0.5" style={{ color: 'var(--accent-fg-danger)' }} />
                        )}
                      </button>
                    );
                  })}
                </div>

                {submitted && (
                  <div
                    className="mt-3 px-3 py-2 rounded-[6px] text-[12.5px] leading-[1.72]"
                    style={{
                      background: 'var(--bg-nested)',
                      borderLeft: `3px solid ${right ? 'var(--accent-fg-emerald)' : 'var(--accent-fg-amber)'}`,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {right ? '答对了。' : '为什么不是你选的那个：'}
                    </span>{' '}
                    {q.explain}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      }
      actions={
        submitted ? (
          <div className="flex items-center gap-2 justify-end w-full">
            <button
              type="button"
              onClick={reset}
              className="flex items-center gap-1.5 px-3.5 h-[30px] rounded-[6px] text-[12.5px] font-medium transition-colors"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
            >
              <RotateCcw size={14} /> 再考一次
            </button>
            <button
              type="button"
              onClick={() => handleClose(false)}
              className="px-3.5 h-[30px] rounded-[6px] text-[12.5px] font-medium"
              style={{ background: 'var(--gold-gradient)', color: 'var(--accent-on-gold)' }}
            >
              完成
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3 justify-between w-full">
            <span className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
              已答 {answeredCount} / {questions.length}
              {answeredCount < questions.length && ` —— 还剩 ${questions.length - answeredCount} 题`}
            </span>
            <button
              type="button"
              onClick={handleSubmit}
              className="px-4 h-[30px] rounded-[6px] text-[12.5px] font-medium transition-opacity duration-[120ms] hover:opacity-90"
              style={{ background: 'var(--gold-gradient)', color: 'var(--accent-on-gold)' }}
            >
              交卷
            </button>
          </div>
        )
      }
    />
  );
}
