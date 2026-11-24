/**
 * 手机档 · 团队看板（终稿未画，按同一套档位表推导）。
 *
 * 推导依据是落地页那两行入口：它和「我的进度」并列，所以它必须读起来
 * 像同一套东西——分组卡 + 17/13 两行 + hairline，而不是把桌面那块
 * 带墨边硬投影的大卡片塞进 390。
 *
 * 顺序按 conclusion-before-numbers：先一句挂着数字的判断（最薄弱的是哪一卷），
 * 再是每卷通关人数，最后才是成员明细。不让人自己读一排数去算。
 *
 * 数据与防御来自 useTeamBoard，与桌面同源。
 */
import { AS_TYPE, AS_SPACE, AS_SIZE } from '@/lib/appStoreTokens';
import { VOLUMES } from '@/lib/bookshelf/catalog';
import { useTeamBoard } from '../useTeamBoard';
import {
  SectionHead, GroupCard, GroupRow, FeaturedCard, NumberBox, Eyebrow, NavBar, Pill, asStyle, GUTTER,
  BOTTOM_GAP,
} from './parts';

const VOL_NUM = '一二三四五六七';

export function MobileBoard({
  skinOf,
  onBack,
}: {
  skinOf: (volumeId: string) => { fg: string; box: string };
  onBack: () => void;
}) {
  const { state, memberCount, passedByVolume, blindByVolume, blindTotal, members, weakest } = useTeamBoard();

  return (
    <div style={{ padding: `0 ${GUTTER}px ${BOTTOM_GAP}` }}>
      <NavBar backLabel="藏书阁" onBack={onBack} title="团队看板" />

      <div style={{ marginTop: 12 }}>
        {/*
          一个人都没有的时候不说「0 人有记录」——那是把一句废话摆在最显眼的位置。
          没数就说这块是干嘛的，有数才报数。
        */}
        <Eyebrow>
          {state === 'ready' && memberCount > 0
            ? `${memberCount} 人有记录${blindTotal > 0 ? ` · ${blindTotal} 次没读就考过` : ''}`
            : '谁在读什么、谁通关了哪一卷'}
        </Eyebrow>
        <div style={{ marginTop: 4, ...asStyle(AS_TYPE.sectionTitle) }}>团队看板</div>
      </div>

      {state === 'loading' && (
        <p style={{ marginTop: 12, ...asStyle(AS_TYPE.itemSubtitle), color: 'var(--text-muted)' }}>正在读取团队进度…</p>
      )}

      {state === 'failed' && (
        <p style={{ marginTop: 12, ...asStyle(AS_TYPE.itemSubtitle), lineHeight: 1.7, color: 'var(--text-muted)' }}>
          team 接口没取到数据，团队进度暂时看不了。你自己的进度不受影响，照常记录。
        </p>
      )}

      {state === 'ready' && memberCount === 0 && (
        <>
          <p style={{ marginTop: 12, ...asStyle(AS_TYPE.heroSubtitle), lineHeight: 1.6, color: 'var(--text-secondary)', textWrap: 'pretty' }}>
            还没有人开始读。你标记第一本书之后，这里就会出现记录——这块存在的意义就是让「谁读到哪」不用靠问。
          </p>
          {/*
            空态给下一步，不把人晾在一屏白底上（guided-exploration：空状态必须有引导 + 主操作）。
            这里的下一步就是回七卷去挑一本——「第一个标记的人」正是这块缺的那个人。
          */}
          <div style={{ marginTop: 24, display: 'flex' }}>
            <Pill onClick={onBack} height={44}>去挑第一本</Pill>
          </div>
        </>
      )}

      {state === 'ready' && memberCount > 0 && (
        <>
          {weakest && (
            <FeaturedCard style={{ marginTop: 24 }}>
              <Eyebrow color={skinOf(weakest.vol.id).fg}>结论</Eyebrow>
              <div style={{ marginTop: 8, ...asStyle(AS_TYPE.quote), textWrap: 'pretty' }}>
                全队最薄弱的是「{weakest.vol.name}」——{memberCount} 人里只有 {weakest.n} 人通关。
              </div>
              <div style={{ marginTop: 12, ...asStyle(AS_TYPE.heroSubtitle), lineHeight: 1.45, color: 'var(--text-secondary)', textWrap: 'pretty' }}>
                {weakest.vol.painQuote}
              </div>
            </FeaturedCard>
          )}

          <div style={{ marginTop: AS_SPACE.sectionGap }}>
            <SectionHead eyebrow="每卷通关人数" title={`${memberCount} 人里，各卷站得住的有几个`} />
          </div>
          <GroupCard style={{ marginTop: AS_SPACE.titleGap }}>
            {VOLUMES.map((v) => {
              const n = passedByVolume[v.id] ?? 0;
              const blind = blindByVolume[v.id] ?? 0;
              const pct = memberCount > 0 ? Math.round((n / memberCount) * 100) : 0;
              const skin = skinOf(v.id);
              return (
                <GroupRow key={v.id} style={{ padding: '12px 16px' }}>
                  <NumberBox fg={skin.fg} box={skin.box} size={AS_SIZE.rowBoxSize} fontSize={20}>
                    {VOL_NUM[v.index - 1]}
                  </NumberBox>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={asStyle(AS_TYPE.itemTitle)}>{v.name}</div>
                    <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, height: 4, borderRadius: AS_SPACE.pillRadius, background: 'var(--shelf-inset)', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: skin.fg, transition: 'width 500ms' }} />
                      </div>
                      <span style={{ ...asStyle(AS_TYPE.itemSubtitle), color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {n} 人{blind > 0 ? ` · 另 ${blind} 裸考` : ''}
                      </span>
                    </div>
                  </div>
                </GroupRow>
              );
            })}
          </GroupCard>

          <div style={{ marginTop: AS_SPACE.sectionGap }}>
            <SectionHead eyebrow="成员" title="谁读到哪了" />
          </div>
          <GroupCard style={{ marginTop: AS_SPACE.titleGap }}>
            {members.map((m) => (
              <GroupRow key={m.userId} align="flex-start">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={asStyle(AS_TYPE.itemTitle)}>{m.displayName ?? '未知成员'}</div>
                  <div style={{ marginTop: 2, ...asStyle(AS_TYPE.itemSubtitle), color: 'var(--text-muted)' }}>
                    {/* 「已读」是自己点的勾，「心得」是真写下过的字 —— 后者才说明读进去了 */}
                    已读 {m.readCount} 本 · 心得 {m.noteCount ?? 0} 条 · 通关 {m.passedCount}/{VOLUMES.length} 卷
                  </div>
                  <div style={{ marginTop: 8, display: 'flex', gap: 4 }}>
                    {VOLUMES.map((v) => (
                      <span
                        key={v.id}
                        title={v.name}
                        style={{
                          width: 14, height: 14, borderRadius: 4,
                          background: m.passedVolumeIds.includes(v.id) ? skinOf(v.id).fg : 'var(--shelf-inset)',
                        }}
                      />
                    ))}
                  </div>
                </div>
              </GroupRow>
            ))}
          </GroupCard>
        </>
      )}
    </div>
  );
}
