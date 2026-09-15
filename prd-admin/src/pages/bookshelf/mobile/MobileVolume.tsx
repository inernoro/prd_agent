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
import { AS_TYPE, AS_SPACE, AS_SIZE } from '@/lib/appStoreTokens';
import { questionsOf } from '@/lib/bookshelf/exams';
import { stanceOf } from '@/lib/bookshelf/examContext';
import { useBookshelfStore } from '@/stores/bookshelfStore';
import { useImageryAsset } from '@/hooks/useImagery';
import { bookshelfVolumeSlot } from '@/lib/imagery';
import type { Volume, BookEntry, Track } from '@/lib/bookshelf/types';
import {
  Eyebrow, SectionHead, GroupCard, GroupRow, FeaturedCard, NumberBox, Pill, NavBar, asStyle, GUTTER,
  BOTTOM_GAP,
} from './parts';
import { CoverBanner } from '../covers';

const TRACK_LABEL: Record<Track, string> = { dev: '开发', pm: '产品', both: '通用' };
const LEVEL_LABEL: Record<number, string> = { 1: '入门', 2: '进阶', 3: '硬骨头' };

const VOL_NUM = '一二三四五六七';

/**
 * 书目行。
 *
 * 改版前这里点一下是**就地展开**「为什么在这一卷」加一个写心得的输入框 —— 也就是说，
 * 用户在藏书阁里能做的全部事情，就是往里填东西。现在点一下进书页读精读稿，
 * 那两样都挪到了书页里（写心得排在读完之后，它是锦上添花不是唯一内容）。
 */
function BookRow({
  book,
  accent,
  read,
  onToggleRead,
  onOpen,
  hasNote,
}: {
  book: BookEntry;
  accent: string;
  read: boolean;
  onToggleRead: () => void;
  onOpen: () => void;
  hasNote: boolean;
}) {
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
          onClick={onOpen}
          style={{ flex: 1, minWidth: 0, textAlign: 'left', border: 0, background: 'transparent', padding: 0, color: 'inherit' }}
        >
          <div style={{ ...asStyle(AS_TYPE.itemTitle), lineHeight: 1.3, textWrap: 'pretty' }}>《{book.title}》</div>
          <div style={{ marginTop: 3, ...asStyle(AS_TYPE.itemSubtitle), color: 'var(--text-muted)' }}>
            {book.author} · {TRACK_LABEL[book.track]} · {LEVEL_LABEL[book.level]}
            {hasNote && <span style={{ marginLeft: 6, color: accent }}>已记一句</span>}
          </div>
          <div style={{ marginTop: 8, ...asStyle(AS_TYPE.heroSubtitle), lineHeight: 1.4, color: 'var(--text-secondary)', textWrap: 'pretty' }}>
            <span style={{ fontWeight: 600, color: accent }}>读完你能</span> {book.takeaway}
          </div>
          <div style={{ marginTop: 8, ...asStyle(AS_TYPE.pill), color: accent }}>读精读稿 ›</div>
        </button>
      </div>
    </div>
  );
}

export function MobileVolume({
  volume,
  skin,
  onBack,
  onOpenBook,
  onStartExam,
}: {
  volume: Volume;
  skin: { fg: string; box: string };
  onBack: () => void;
  onOpenBook: (bookId: string) => void;
  onStartExam: () => void;
}) {
  const readBookIds = useBookshelfStore((s) => s.readBookIds);
  const toggleRead = useBookshelfStore((s) => s.toggleRead);
  const bookNotes = useBookshelfStore((s) => s.bookNotes);
  const examResults = useBookshelfStore((s) => s.examResults);

  const total = volume.books.length;
  const read = volume.books.filter((b) => readBookIds.includes(b.id)).length;
  const questionCount = questionsOf(volume.id).length;
  const result = examResults[volume.id];
  const index = volume.index - 1;
  /* 卷面图，没生成就不渲染那一条（CoverBanner 自己返回 null），版式照旧成立 */
  const cover = useImageryAsset(bookshelfVolumeSlot(volume.id) ?? '');

  return (
    <div style={{ padding: `0 ${GUTTER}px ${BOTTOM_GAP}` }}>
      <NavBar backLabel="藏书阁" onBack={onBack} accent={skin.fg} trailing={
        <span style={{ ...asStyle(AS_TYPE.heroSubtitle), color: 'var(--text-muted)' }}>已读 {read}/{total}</span>
      } />

      {/*
        通栏卷面图。外层这一屏有 20px 左右 padding，所以要用负边距顶掉它才贴得到边；
        这与落地页那条横滑卡正好相反——那边外层左右是 0，再加负边距就会横向溢出。
        渐变终点是页面底色而不是卡片底色，否则图的下沿会在页面上露出一条色差。
      */}
      {cover && (
        <div style={{ margin: `12px -${GUTTER}px 0` }}>
          <CoverBanner src={cover} height={168} radius={0} fadeTo="var(--bg-base)" />
        </div>
      )}

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
            onOpen={() => onOpenBook(b.id)}
            hasNote={(bookNotes[b.id] ?? '').trim().length > 0}
          />
        ))}
      </GroupCard>
    </div>
  );
}
