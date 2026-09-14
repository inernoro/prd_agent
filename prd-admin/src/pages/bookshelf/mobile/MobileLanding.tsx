/**
 * 手机档 · 落地页（终稿画板 2a）。
 *
 * 顺序照稿，而这个顺序本身是论证过的：
 *   标题 + 一句话 → 角色 chip → 处境卡横滑 → 七卷清单 → 进度/看板两行入口
 *
 * 被甩链接进来的人不需要先看卷名，需要先看到「说的是不是我」，所以处境句
 * 是首屏主体；一个已读为 0 的新人，进度不是他此刻要看的，所以压到七卷之后。
 *
 * 七卷用**清单**不用横滑：七个并列项要一眼扫完做对号入座，横滑一次只见一个，
 * 折叠还要多点一次。每行 68px，整组一屏装得下。
 */
import { AS_TYPE, AS_SPACE, AS_SIZE } from '@/lib/appStoreTokens';
import { VOLUMES, PAIN_REMEDIES, ALL_BOOKS, findVolume } from '@/lib/bookshelf/catalog';
import { countsAsPassed } from '@/lib/bookshelf/examContext';
import { useBookshelfStore } from '@/stores/bookshelfStore';
import type { Track } from '@/lib/bookshelf/types';
import {
  Eyebrow, SectionHead, GroupCard, GroupRow, FeaturedCard, NumberBox, Chevron, asStyle, GUTTER,
  BOTTOM_GAP,
} from './parts';

const VOL_NUM = '一二三四五六七';

/**
 * 角色筛选。终稿画了八个 chip（全部 / 开发者 / 产品经理 / 测试 / 设计 / 运维 /
 * 技术负责人 / 新人），但书目的 track 只有 dev / pm / both 三种取值——后五个
 * 点下去会是空列表。设计师自己在稿子顶部也标注了「新角色需先补 catalog 数据」。
 *
 * 这里只放有数据的三个：**宁可少一个入口，也不给一条走进空屋子的路**
 * （no-rootless-tree：不假定不存在的能力）。补了 catalog 数据再把它们加回来。
 */
export type RoleFilter = 'all' | 'dev' | 'pm';
const ROLES: { key: RoleFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'dev', label: '开发者' },
  { key: 'pm', label: '产品经理' },
];
export function matchRole(track: Track, f: RoleFilter) {
  return f === 'all' || track === f || track === 'both';
}

export function MobileLanding({
  role,
  onRole,
  skinOf,
  onOpenVolume,
  onOpenBoard,
}: {
  role: RoleFilter;
  onRole: (r: RoleFilter) => void;
  skinOf: (volumeId: string) => { fg: string; box: string };
  onOpenVolume: (volumeId: string) => void;
  onOpenBoard: () => void;
}) {
  const readBookIds = useBookshelfStore((s) => s.readBookIds);
  const bookNotes = useBookshelfStore((s) => s.bookNotes);
  const examResults = useBookshelfStore((s) => s.examResults);

  const visible = ALL_BOOKS.filter((b) => matchRole(b.track, role));
  const readCount = visible.filter((b) => readBookIds.includes(b.id)).length;
  const noteCount = Object.values(bookNotes).filter((v) => v.trim().length > 0).length;
  const passedCount = VOLUMES.filter((v) => {
    const r = examResults[v.id];
    return r ? countsAsPassed(r.passed, r.readAtExam, r.totalAtExam) : false;
  }).length;

  /**
   * 横滑卡组自己带 gutter，容器不带——所以这里**不能**再加负边距。
   * 加了会让 rail 的 border box 往两边各超出 20px，右侧直接横向溢出。
   * （落地页的外层是 `padding: 4px 0 48px`，左右为 0；只有那些自带左右 padding
   *  的区块才需要负边距去顶掉它。）
   */
  const railStyle = {
    display: 'flex',
    gap: 12,
    overflowX: 'auto',
    padding: `0 ${GUTTER}px`,
    scrollSnapType: 'x mandatory',
    scrollbarWidth: 'none',
  } as const;

  return (
    <div style={{ padding: `4px 0 ${BOTTOM_GAP}` }}>
      <div style={{ padding: `0 ${GUTTER}px` }}>
        <Eyebrow color="var(--accent-fg-emerald)">
          公共藏书阁 · {VOLUMES.length} 卷 {ALL_BOOKS.length} 本
        </Eyebrow>
        <h1 style={{ margin: '8px 0 0', ...asStyle(AS_TYPE.heroTitleStrong) }}>
          看到我，算你有福了
        </h1>
        <p style={{ margin: '10px 0 0', ...asStyle(AS_TYPE.heroSubtitle), lineHeight: 1.4, color: 'var(--text-secondary)', textWrap: 'pretty' }}>
          七卷不按学科排，按你会在哪一步卡住排。从最像你的那条进去。
        </p>
      </div>

      <div style={{ ...railStyle, marginTop: AS_SPACE.titleGap, gap: 8, scrollSnapType: undefined }}>
        {ROLES.map((r) => {
          const on = r.key === role;
          return (
            <button
              key={r.key}
              type="button"
              onClick={() => onRole(r.key)}
              style={{
                height: AS_SPACE.chipHeight,
                flex: 'none',
                padding: `0 14px`,
                borderRadius: AS_SPACE.pillRadius,
                border: 0,
                display: 'flex',
                alignItems: 'center',
                ...asStyle(AS_TYPE.pill),
                whiteSpace: 'nowrap',
                background: on ? 'var(--text-primary)' : 'var(--bg-card)',
                color: on ? 'var(--bg-base)' : 'var(--text-secondary)',
              }}
            >
              {r.label}
            </button>
          );
        })}
        <div style={{ width: 8, flex: 'none' }} />
      </div>

      <div style={{ marginTop: AS_SPACE.sectionGap, padding: `0 ${GUTTER}px` }}>
        <SectionHead eyebrow="从你的痛处进来" title="这些处境，是不是很眼熟" />
      </div>

      <div style={{ ...railStyle, marginTop: AS_SPACE.titleGap }}>
        {PAIN_REMEDIES.map((p) => {
          const vol = findVolume(p.volumeId);
          if (!vol) return null;
          const skin = skinOf(p.volumeId);
          const count = vol.books.filter((b) => matchRole(b.track, role)).length;
          return (
            <FeaturedCard
              key={p.quote}
              style={{
                width: AS_SIZE.shelfCardWidth,
                flex: 'none',
                scrollSnapAlign: 'start',
                minHeight: 176,
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                boxSizing: 'border-box',
                cursor: 'pointer',
              }}
            >
              <button
                type="button"
                onClick={() => onOpenVolume(p.volumeId)}
                style={{
                  display: 'flex', flexDirection: 'column', gap: 12, flex: 1,
                  border: 0, background: 'transparent', padding: 0, textAlign: 'left', color: 'inherit',
                }}
              >
                <Eyebrow color={skin.fg}>卷{VOL_NUM[vol.index - 1]} · {vol.name}</Eyebrow>
                <div style={{ ...asStyle(AS_TYPE.quote), textWrap: 'pretty' }}>{p.quote}</div>
                <div style={{ ...asStyle(AS_TYPE.itemSubtitle), lineHeight: 1.4, color: 'var(--text-secondary)', textWrap: 'pretty', flex: 1 }}>
                  {p.diagnosis}
                </div>
                <div style={{ ...asStyle(AS_TYPE.pill), color: skin.fg }}>去这一卷 · {count} 本 ›</div>
              </button>
            </FeaturedCard>
          );
        })}
        <div style={{ width: 8, flex: 'none' }} />
      </div>

      <div style={{ marginTop: AS_SPACE.sectionGap, padding: `0 ${GUTTER}px` }}>
        <SectionHead eyebrow="从「代码能跑」到「能替别人兜底」" title="七卷" />
      </div>

      <GroupCard style={{ margin: `${AS_SPACE.titleGap}px ${GUTTER}px 0` }}>
        {VOLUMES.map((v) => {
          const skin = skinOf(v.id);
          const count = v.books.filter((b) => matchRole(b.track, role)).length;
          const r = examResults[v.id];
          const passed = r ? countsAsPassed(r.passed, r.readAtExam, r.totalAtExam) : false;
          return (
            <GroupRow key={v.id} onClick={() => onOpenVolume(v.id)} style={{ padding: '12px 16px' }}>
              <NumberBox fg={skin.fg} box={skin.box} size={AS_SIZE.rowBoxSize} fontSize={20}>
                {VOL_NUM[v.index - 1]}
              </NumberBox>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={asStyle(AS_TYPE.itemTitle)}>
                  {v.name}
                  {passed && <span style={{ marginLeft: 6, ...asStyle(AS_TYPE.eyebrow), color: skin.fg }}>通关</span>}
                </div>
                <div
                  style={{
                    marginTop: 2, ...asStyle(AS_TYPE.itemSubtitle), color: 'var(--text-muted)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}
                >
                  {v.subtitle}
                </div>
              </div>
              <span style={{ ...asStyle(AS_TYPE.heroSubtitle), color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                {count} 本
              </span>
              <Chevron />
            </GroupRow>
          );
        })}
      </GroupCard>

      <GroupCard style={{ margin: `${AS_SPACE.sectionGap}px ${GUTTER}px 0` }}>
        {/*
          终稿在这一行也画了雪佛龙，但没有定义它通向哪一屏——而这一行的两个数字
          本身就是「我的进度」的全部内容，点进去没有更多东西可看。
          留一个按了不动的箭头比不画更糟（它承诺了一个不存在的下一步），所以这里不画。
          日后真做了进度详情页，把 Chevron 和 onClick 一起加回来。
        */}
        <GroupRow style={{ borderTop: 0 }}>
          <div style={{ flex: 1 }}>
            <div style={asStyle(AS_TYPE.itemTitle)}>我的进度</div>
            <div style={{ marginTop: 2, ...asStyle(AS_TYPE.itemSubtitle), color: 'var(--text-muted)' }}>
              已读 {readCount}/{visible.length} · 心得 {noteCount} · 通关 {passedCount}/{VOLUMES.length}
            </div>
          </div>
        </GroupRow>
        <GroupRow onClick={onOpenBoard}>
          <div style={{ flex: 1 }}>
            <div style={asStyle(AS_TYPE.itemTitle)}>团队看板</div>
            <div style={{ marginTop: 2, ...asStyle(AS_TYPE.itemSubtitle), color: 'var(--text-muted)' }}>
              谁在读什么、谁通关了哪一卷
            </div>
          </div>
          <Chevron />
        </GroupRow>
      </GroupCard>
    </div>
  );
}
