/**
 * 手机档 · 考试（答题屏 + 结果屏 1d）。
 *
 * 结果屏（1d）照终稿画：分数 + 判词 + 一句解释 → 推荐书分组卡 → 逐题对错
 * → 底部吸底两个 pill。
 *
 * 答题屏终稿没画，按同一套档位表推导，判据是「它必须和 1d 是同一屏的两个阶段」：
 *   - 沿用 1d 的返回条与 20px 基准线，只把「分数区」换成「第几题 / 共几题」；
 *   - 题干走 15/600、选项走分组卡的行（14/16 padding + hairline），
 *     与 1d 的逐题块同构，交卷后原地变成解析，不换布局；
 *   - 底部同样吸底一个 pill，位置与「再考一次」重合——交卷前后手指不用移位。
 *
 * 分数、通关、推荐书一律问 `useExamSession`，这一层只负责画。
 */
import { useEffect, useRef } from 'react';
import { AS_TYPE, AS_SPACE, AS_SIZE } from '@/lib/appStoreTokens';
import { PASS_RATE } from '@/lib/bookshelf/exams';
import type { Volume, Track } from '@/lib/bookshelf/types';
import type { ExamSession } from '../useExamSession';
import {
  Eyebrow, SectionHead, GroupCard, GroupRow, NumberBox, Chevron, Pill, NavBar, asStyle, GUTTER,
  BOTTOM_GAP,
} from './parts';

const VOL_NUM = '一二三四五六七';
const TRACK_LABEL: Record<Track, string> = { dev: '开发', pm: '产品', both: '通用' };
const LEVEL_LABEL: Record<number, string> = { 1: '入门', 2: '进阶', 3: '硬骨头' };

/** 吸底动作条：负边距顶掉 gutter，自己补回，底色与页面同色挡住下方滚动内容。 */
function StickyActions({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: 'sticky', bottom: 0,
        margin: `24px -${GUTTER}px 0`,
        padding: `12px ${GUTTER}px ${BOTTOM_GAP}`,
        background: 'var(--bg-base)',
        display: 'flex', gap: 12,
      }}
    >
      {children}
    </div>
  );
}

export function MobileExam({
  volume,
  skin,
  session,
  onBack,
}: {
  volume: Volume;
  skin: { fg: string; box: string };
  session: ExamSession;
  onBack: () => void;
}) {
  const {
    questions, picked, pick, submitted, submit, reset,
    answeredCount, correctCount, passed, readBooks, totalBooks, stance, suggestedBooks,
  } = session;

  const topRef = useRef<HTMLDivElement>(null);
  // 交卷后滚回顶部：分数是这一屏的头条，让它出现在用户眼前，
  // 而不是让人从最后一题往回翻去找自己考了多少（expectation-management：变化要可感知）。
  useEffect(() => {
    if (submitted) topRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [submitted]);

  const title = stance === 'blind' ? '摸底测' : '结业考';
  const verdict = stance === 'blind'
    ? (passed ? '底子在 · 裸考不计入通关' : '有缺口 · 裸考不计入通关')
    : (passed ? '通过' : '未通过');
  const verdictColor = passed && stance !== 'blind' ? skin.fg : 'var(--accent-fg-amber)';

  const resultMsg = stance === 'blind'
    ? `你是在一本没读的情况下考的（这一卷共 ${totalBooks} 本）。${passed ? '底子在，但看板只记读过再考过的。' : '错的那几处正是这一卷要治的。'}`
    : stance === 'complete'
      ? `整卷 ${totalBooks} 本读完后考的。${passed ? '这一卷的判断题你已经站得住，往下一卷走。' : '读完还错这几道，说明这几处没读透——解析在下面。'}`
      : `读了 ${readBooks}/${totalBooks} 本后考的。${passed ? '这一卷的判断题你已经站得住，往下一卷走。' : '下面每题都有解析，看完再来一次。'}`;

  return (
    <div style={{ padding: `0 ${GUTTER}px 0` }}>
      <div ref={topRef} />
      <NavBar backLabel={volume.name} onBack={onBack} title={title} accent={skin.fg} />

      <div style={{ marginTop: 12 }}>
        <Eyebrow>卷{VOL_NUM[volume.index - 1]} · {volume.name} · {questions.length} 题</Eyebrow>

        {submitted ? (
          <>
            <div style={{ marginTop: 6, display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ ...asStyle(AS_TYPE.heroTitleStrong), whiteSpace: 'nowrap', flex: 'none' }}>
                {correctCount} / {questions.length}
              </span>
              <span style={{ ...asStyle(AS_TYPE.pill), color: verdictColor }}>{verdict}</span>
            </div>
            <p style={{ margin: '10px 0 0', ...asStyle(AS_TYPE.heroSubtitle), lineHeight: 1.45, color: 'var(--text-secondary)', textWrap: 'pretty' }}>
              {resultMsg}
            </p>
          </>
        ) : (
          <>
            <div style={{ marginTop: 6, display: 'flex', alignItems: 'baseline', gap: 12 }}>
              <span style={{ ...asStyle(AS_TYPE.heroTitleStrong), whiteSpace: 'nowrap', flex: 'none' }}>
                {answeredCount} / {questions.length}
              </span>
              <span style={{ ...asStyle(AS_TYPE.pill), color: 'var(--text-muted)' }}>
                {answeredCount < questions.length ? `还剩 ${questions.length - answeredCount} 题` : '都答完了'}
              </span>
            </div>
            <p style={{ margin: '10px 0 0', ...asStyle(AS_TYPE.heroSubtitle), lineHeight: 1.45, color: 'var(--text-secondary)', textWrap: 'pretty' }}>
              {stance === 'blind'
                ? `这一卷你还没开始读，这次是摸底。考的是判断，不是记忆——做完就知道该先读哪本。`
                : `答对 ${Math.ceil(questions.length * PASS_RATE)} 题及格。考的是判断，不是记忆。`}
            </p>
          </>
        )}
      </div>

      {submitted && suggestedBooks.length > 0 && (
        <>
          <div style={{ marginTop: AS_SPACE.sectionGap }}>
            <SectionHead eyebrow="错的那几处，这两本正好治" title={`建议从这${suggestedBooks.length === 1 ? '本' : '两本'}开始`} />
          </div>
          <GroupCard style={{ marginTop: AS_SPACE.titleGap }}>
            {suggestedBooks.map((b, i) => (
              <GroupRow key={b.id}>
                <NumberBox fg={skin.fg} box={skin.box} size={AS_SIZE.rowBoxSize} fontSize={17}>{i + 1}</NumberBox>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={asStyle(AS_TYPE.itemTitle)}>《{b.title}》</div>
                  <div style={{ marginTop: 2, ...asStyle(AS_TYPE.itemSubtitle), color: 'var(--text-muted)' }}>
                    {b.author} · {TRACK_LABEL[b.track]} · {LEVEL_LABEL[b.level]}
                  </div>
                </div>
                <Chevron />
              </GroupRow>
            ))}
          </GroupCard>
        </>
      )}

      <div style={{ marginTop: AS_SPACE.sectionGap }}>
        <SectionHead
          eyebrow={submitted ? '逐题' : '判断题'}
          title={submitted ? '错在哪、为什么' : '选一个你认为对的'}
        />
      </div>

      <GroupCard style={{ marginTop: AS_SPACE.titleGap }}>
        {questions.map((q, qi) => {
          const chosen = picked[q.id];
          const right = chosen === q.answer;
          return (
            <div key={q.id} style={{ padding: `${AS_SPACE.listItemPaddingY}px ${AS_SPACE.listItemPaddingX}px`, borderTop: '1px solid var(--border-faint)' }}>
              <div style={{ display: 'flex', gap: 12 }}>
                <span
                  style={{
                    width: 22, height: 22, flex: 'none', marginTop: 1,
                    borderRadius: AS_SPACE.pillRadius,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 13, fontWeight: 800, lineHeight: 1,
                    background: submitted
                      ? (right ? skin.fg : 'var(--accent-fg-danger)')
                      : (chosen === undefined ? 'transparent' : 'var(--text-muted)'),
                    border: submitted || chosen !== undefined ? 0 : '1.5px solid var(--border-default)',
                    color: 'var(--bg-base)',
                  }}
                >
                  {submitted ? (right ? '✓' : '✕') : (chosen === undefined ? '' : qi + 1)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ ...asStyle(AS_TYPE.pill), fontWeight: 600, lineHeight: 1.4, textWrap: 'pretty' }}>{q.stem}</div>

                  {!submitted && (
                    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {q.options.map((opt, oi) => {
                        const on = chosen === oi;
                        return (
                          <button
                            key={oi}
                            type="button"
                            // 机读锚点：验收脚本按它取选项。
                            // 靠「按钮文字里有没有 A」去找会误中返回钮「‹ 驭 AI」，
                            // 点下去直接退出考试，而脚本只会报「交卷按钮找不到」。
                            data-exam-option={oi}
                            onClick={() => pick(q.id, oi)}
                            style={{
                              display: 'flex', gap: 10, alignItems: 'flex-start', textAlign: 'left',
                              padding: '10px 12px', borderRadius: AS_SPACE.iconRadius,
                              border: 0, background: on ? 'var(--bg-sunken)' : 'transparent',
                              color: 'inherit',
                              outline: on ? `1.5px solid ${skin.fg}` : 'none',
                            }}
                          >
                            <span style={{ ...asStyle(AS_TYPE.itemSubtitle), fontWeight: 800, color: on ? skin.fg : 'var(--text-muted)', flex: 'none', lineHeight: 1.45 }}>
                              {'ABCD'[oi]}
                            </span>
                            <span style={{ ...asStyle(AS_TYPE.itemSubtitle), lineHeight: 1.45, color: 'var(--text-secondary)', textWrap: 'pretty' }}>
                              {opt}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {submitted && (
                    <>
                      <div style={{ marginTop: 8, ...asStyle(AS_TYPE.itemSubtitle), lineHeight: 1.4, color: 'var(--text-muted)' }}>
                        <span style={{ fontWeight: 600 }}>你选</span> · {chosen === undefined ? '未作答' : q.options[chosen]}
                      </div>
                      {!right && (
                        <div style={{ marginTop: 4, ...asStyle(AS_TYPE.itemSubtitle), lineHeight: 1.4, color: skin.fg }}>
                          <span style={{ fontWeight: 600 }}>正确</span> · {q.options[q.answer]}
                        </div>
                      )}
                      <div
                        style={{
                          marginTop: 8, padding: '10px 12px', borderRadius: AS_SPACE.iconRadius,
                          background: 'var(--bg-sunken)', ...asStyle(AS_TYPE.itemSubtitle),
                          lineHeight: 1.45, color: 'var(--text-secondary)', textWrap: 'pretty',
                        }}
                      >
                        {q.explain}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </GroupCard>

      <StickyActions>
        {submitted ? (
          <>
            <Pill block height={44} accent={skin.fg} onClick={reset}>再考一次</Pill>
            <Pill block height={44} tone="soft" onClick={onBack}>回到这一卷</Pill>
          </>
        ) : (
          <Pill block height={44} accent={skin.fg} onClick={submit}>
            交卷{answeredCount < questions.length ? ` · 还剩 ${questions.length - answeredCount} 题` : ''}
          </Pill>
        )}
      </StickyActions>
    </div>
  );
}
