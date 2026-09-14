/**
 * 手机档 · 卷页（终稿画板 1c）。
 *
 * 结构照稿：返回条 → 60px 卷序块 + 卷名三行 → 处境+药方主卡 → 考试入口行
 * → 书目分组卡（每本可展开「为什么在这一卷」+ 写一句）。
 *
 * 与桌面档最大的不同是**它是一屏独立页面**，不是落地页里换掉的一段列表。
 * 终稿的论证：七卷是七个并列项，用户要一眼扫完做对号入座，所以落地页只放清单；
 * 点进来才谈这一卷的细节。深链 ?vol= 天然对应这一层。
 */
import { useState } from 'react';
import { AS_TYPE, AS_SPACE, AS_SIZE } from '@/lib/appStoreTokens';
import { questionsOf } from '@/lib/bookshelf/exams';
import { stanceOf } from '@/lib/bookshelf/examContext';
import { useBookshelfStore } from '@/stores/bookshelfStore';
import type { Volume, BookEntry, Track } from '@/lib/bookshelf/types';
import {
  Eyebrow, SectionHead, GroupCard, GroupRow, FeaturedCard, NumberBox, Pill, NavBar, asStyle, GUTTER,
  BOTTOM_GAP,
} from './parts';

const TRACK_LABEL: Record<Track, string> = { dev: '开发', pm: '产品', both: '通用' };
const LEVEL_LABEL: Record<number, string> = { 1: '入门', 2: '进阶', 3: '硬骨头' };

const VOL_NUM = '一二三四五六七';

function BookRow({
  book,
  accent,
  read,
  onToggleRead,
  note,
  onSaveNote,
}: {
  book: BookEntry;
  accent: string;
  read: boolean;
  onToggleRead: () => void;
  note: string | undefined;
  onSaveNote: (v: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(note ?? '');

  return (
    <div style={{ padding: `${AS_SPACE.listItemPaddingY}px ${AS_SPACE.listItemPaddingX}px`, borderTop: '1px solid var(--border-faint)' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        {/*
          勾选圈是这一屏唯一带描边的东西（1.5px）。稿子把其余描边全去掉了，
          留它是因为「还没勾」必须看得出是一个可点的空圈，而不是一块装饰。
        */}
        <button
          type="button"
          aria-label={read ? '取消已读' : '标记已读'}
          aria-pressed={read}
          onClick={onToggleRead}
          style={{
            width: 22, height: 22, flex: 'none', marginTop: 1, padding: 0,
            borderRadius: AS_SPACE.pillRadius,
            border: `1.5px solid ${read ? accent : 'var(--border-default)'}`,
            background: read ? accent : 'transparent',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 800, color: 'var(--bg-base)', lineHeight: 1,
          }}
        >
          {read ? '✓' : ''}
        </button>

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{ flex: 1, minWidth: 0, textAlign: 'left', border: 0, background: 'transparent', padding: 0, color: 'inherit' }}
        >
          <div style={{ ...asStyle(AS_TYPE.itemTitle), lineHeight: 1.3, textWrap: 'pretty' }}>《{book.title}》</div>
          <div style={{ marginTop: 3, ...asStyle(AS_TYPE.itemSubtitle), color: 'var(--text-muted)' }}>
            {book.author} · {TRACK_LABEL[book.track]} · {LEVEL_LABEL[book.level]}
          </div>
          <div style={{ marginTop: 8, ...asStyle(AS_TYPE.heroSubtitle), lineHeight: 1.4, color: 'var(--text-secondary)', textWrap: 'pretty' }}>
            <span style={{ fontWeight: 600, color: accent }}>读完你能</span> {book.takeaway}
          </div>
        </button>
      </div>

      {expanded && (
        <>
          <div
            style={{
              margin: '12px 0 0 34px', padding: '12px 14px',
              borderRadius: AS_SPACE.iconRadius, background: 'var(--bg-sunken)',
            }}
          >
            <Eyebrow>为什么在这一卷</Eyebrow>
            <div style={{ marginTop: 6, ...asStyle(AS_TYPE.itemSubtitle), lineHeight: 1.45, color: 'var(--text-secondary)', textWrap: 'pretty' }}>
              {book.why}
            </div>
          </div>
          {/*
            唯一的「学习」动作。在此之前藏书阁只有「我点了已读」这个自我声明——
            一个勾证明不了什么。写一句「打算在哪用它」才是真读过的痕迹。
            不设门槛：不写照样能标已读、能考。
          */}
          <textarea
            value={draft}
            maxLength={200}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => { if (draft !== (note ?? '')) onSaveNote(draft); }}
            placeholder="打算在哪用它？一句话就够。"
            style={{
              margin: '8px 0 0 34px', width: 'calc(100% - 34px)', minHeight: 44,
              borderRadius: AS_SPACE.iconRadius, background: 'var(--bg-input)',
              border: 0, outline: 'none', resize: 'none',
              padding: '12px 14px', ...asStyle(AS_TYPE.heroSubtitle), lineHeight: 1.4,
              color: 'var(--text-primary)', fontFamily: 'inherit',
            }}
          />
        </>
      )}
    </div>
  );
}

export function MobileVolume({
  volume,
  skin,
  onBack,
  onStartExam,
}: {
  volume: Volume;
  skin: { fg: string; box: string };
  onBack: () => void;
  onStartExam: () => void;
}) {
  const readBookIds = useBookshelfStore((s) => s.readBookIds);
  const toggleRead = useBookshelfStore((s) => s.toggleRead);
  const bookNotes = useBookshelfStore((s) => s.bookNotes);
  const setNote = useBookshelfStore((s) => s.setNote);
  const examResults = useBookshelfStore((s) => s.examResults);

  const total = volume.books.length;
  const read = volume.books.filter((b) => readBookIds.includes(b.id)).length;
  const questionCount = questionsOf(volume.id).length;
  const result = examResults[volume.id];
  const index = volume.index - 1;

  return (
    <div style={{ padding: `0 ${GUTTER}px ${BOTTOM_GAP}` }}>
      <NavBar backLabel="藏书阁" onBack={onBack} accent={skin.fg} trailing={
        <span style={{ ...asStyle(AS_TYPE.heroSubtitle), color: 'var(--text-muted)' }}>已读 {read}/{total}</span>
      } />

      <div style={{ marginTop: 12, display: 'flex', gap: 16, alignItems: 'center' }}>
        <NumberBox fg={skin.fg} box={skin.box} size={AS_SIZE.gridIconSize} fontSize={28}>
          {VOL_NUM[index]}
        </NumberBox>
        <div style={{ minWidth: 0 }}>
          <Eyebrow>卷{VOL_NUM[index]} · {total} 本 · {questionCount} 道判断题</Eyebrow>
          <div style={{ marginTop: 4, ...asStyle(AS_TYPE.sectionTitle) }}>{volume.name}</div>
          <div style={{ marginTop: 4, ...asStyle(AS_TYPE.heroSubtitle), color: 'var(--text-secondary)' }}>{volume.subtitle}</div>
        </div>
      </div>

      <FeaturedCard style={{ marginTop: 24 }}>
        <Eyebrow color={skin.fg}>说的是不是你</Eyebrow>
        <div style={{ marginTop: 8, ...asStyle(AS_TYPE.quote), textWrap: 'pretty' }}>{volume.painQuote}</div>
        <div style={{ marginTop: 12, ...asStyle(AS_TYPE.heroSubtitle), lineHeight: 1.45, color: 'var(--text-secondary)', textWrap: 'pretty' }}>
          {volume.cure}
        </div>
      </FeaturedCard>

      {questionCount > 0 && (
        <GroupCard style={{ marginTop: 12 }}>
          <GroupRow style={{ borderTop: 0 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {/*
                标题逐字照稿：「先摸个底」，题数留给副标题，不在这里再缀一次。
                姿态判断仍走 stanceOf（examContext 是唯一判定源），
                只是这一屏的措辞与桌面的 examEntryLabel 不同——
                共享的是判断，不是文案。
              */}
              <div style={asStyle(AS_TYPE.itemTitle)}>
                {result ? '再考一次' : stanceOf(read, total) === 'blind' ? '先摸个底' : '结业考'}
              </div>
              <div style={{ marginTop: 2, ...asStyle(AS_TYPE.itemSubtitle), color: 'var(--text-muted)' }}>
                {result
                  ? `上次 ${result.correct}/${result.total} · 错题解析随时能再看`
                  : `${questionCount} 道判断题 · 一本没读也能考，读完再考一次`}
              </div>
            </div>
            <Pill onClick={onStartExam} accent={skin.fg}>{result ? '再考' : '开始'}</Pill>
          </GroupRow>
        </GroupCard>
      )}

      <div style={{ marginTop: AS_SPACE.sectionGap }}>
        <SectionHead eyebrow="书目" title={`${total} 本，按门槛从入门排到硬骨头`} />
      </div>

      <GroupCard style={{ marginTop: AS_SPACE.titleGap }}>
        {volume.books.map((b) => (
          <BookRow
            key={b.id}
            book={b}
            accent={skin.fg}
            read={readBookIds.includes(b.id)}
            onToggleRead={() => toggleRead(b.id)}
            note={bookNotes[b.id]}
            onSaveNote={(v) => setNote(b.id, v)}
          />
        ))}
      </GroupCard>
    </div>
  );
}
