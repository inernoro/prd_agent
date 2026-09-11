/**
 * 团队看板 —— 藏书阁「公共」二字的另一半。
 *
 * 书单解决「新人不知道该会什么」，这块解决「你不知道新人到底会不会」。
 * 所以它默认对全队可见：藏起来就退回原来那个「什么都不跟我说」的状态了。
 *
 * 视觉沿用页面的粗野骨架（墨边 + 纯偏移硬投影），颜色全部走 token。
 */
import { useEffect, useState } from 'react';
import { Users, TrendingDown } from 'lucide-react';
import { getBookshelfTeamBoard, type BookshelfTeamDto } from '@/services/real/bookshelf';
import { VOLUMES } from '@/lib/bookshelf/catalog';

const EDGE = '3px solid var(--shelf-edge)';
const EDGE_THIN = '2.5px solid var(--shelf-edge)';

export function TeamBoard({ volumeSkin }: { volumeSkin: { fg: string; box: string }[] }) {
  const [data, setData] = useState<BookshelfTeamDto | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await getBookshelfTeamBoard();
        if (!alive) return;
        if (res.success && res.data) { setData(res.data); setState('ready'); }
        else setState('failed');
      } catch {
        if (alive) setState('failed');
      }
    })();
    return () => { alive = false; };
  }, []);

  // 上游给什么都不许把整页带走。
  // 2026-09-11 线上事故：后端返回的 JSON 缺 error 键，不满足 apiClient 的 ApiResponse
  // 判据，data 于是不是看板那一层；memberCount 成了 undefined（既不等于 0、也不大于 0），
  // 下面这段的 map 照跑，读 undefined['vol-boot'] 把整个藏书阁炸成「页面渲染出错」。
  // 后端已对齐契约，这里再兜一道：看板拿不到数就降级成空态，不牵连书单。
  const memberCount = typeof data?.memberCount === 'number' && Number.isFinite(data.memberCount)
    ? data.memberCount : 0;
  const passedByVolume: Record<string, number> =
    data?.passedByVolume && typeof data.passedByVolume === 'object' ? data.passedByVolume : {};
  const members = Array.isArray(data?.members) ? data.members : [];
  const blindByVolume: Record<string, number> =
    data?.blindPassedByVolume && typeof data.blindPassedByVolume === 'object'
      ? data.blindPassedByVolume : {};
  const blindTotal = Object.values(blindByVolume).reduce((a, b) => a + (Number(b) || 0), 0);

  // 全队最薄弱的一卷：通关人数最少的那卷。没人考过任何卷时不出这句结论。
  const weakest = (() => {
    if (memberCount === 0) return null;
    const counts = VOLUMES.map((v, i) => ({ vol: v, i, n: passedByVolume[v.id] ?? 0 }));
    if (counts.every((c) => c.n === 0)) return null;
    return counts.reduce((min, c) => (c.n < min.n ? c : min), counts[0]);
  })();

  return (
    <section className="mt-6 p-6 sm:p-7 rounded-[28px]" style={{ background: 'var(--bg-card)', border: EDGE, boxShadow: '6px 6px 0 var(--shelf-edge)' }}>
      <div className="flex items-center gap-2.5 flex-wrap">
        <Users size={19} strokeWidth={2.6} />
        <h3 className="text-[20px] font-black tracking-[-0.02em]">团队看板</h3>
        {state === 'ready' && data && (
          <span className="px-2.5 py-1 rounded-full text-[11.5px] font-bold" style={{ background: 'var(--bg-base)', border: EDGE_THIN }}>
            {memberCount} 人有记录
          </span>
        )}
        {state === 'ready' && blindTotal > 0 && (
          <span className="px-2.5 py-1 rounded-full text-[11.5px] font-bold" style={{ background: 'var(--bg-base)', border: EDGE_THIN, color: 'var(--text-muted)' }}>
            {blindTotal} 次没读就考过
          </span>
        )}
      </div>

      {state === 'loading' && (
        <p className="mt-3 text-[13px] font-medium" style={{ color: 'var(--text-muted)' }}>正在读取团队进度…</p>
      )}

      {state === 'failed' && (
        <p className="mt-3 text-[13px] font-medium leading-[1.7]" style={{ color: 'var(--text-muted)' }}>
          team 接口没取到数据，团队进度暂时看不了。你自己的进度不受影响，照常记录。
        </p>
      )}

      {state === 'ready' && data && memberCount === 0 && (
        <p className="mt-3 text-[13px] font-medium leading-[1.7]" style={{ color: 'var(--text-secondary)' }}>
          还没有人开始读。你标记第一本书之后，这里就会出现记录——这块存在的意义就是让「谁读到哪」不用靠问。
        </p>
      )}

      {state === 'ready' && data && memberCount > 0 && (
        <>
          {/* 结论先行：一句挂着数字的判断，而不是让人自己读一排数去算 */}
          {weakest && (
            <div className="mt-4 flex items-start gap-2.5 px-4 py-3 rounded-[16px]" style={{ background: 'var(--bg-base)', border: EDGE_THIN }}>
              <TrendingDown size={17} strokeWidth={2.6} className="shrink-0 mt-0.5" style={{ color: volumeSkin[weakest.i]?.fg }} />
              <p className="text-[13.5px] font-bold leading-[1.65]">
                全队最薄弱的是<span style={{ color: volumeSkin[weakest.i]?.fg }}>「{weakest.vol.name}」</span>——
                {memberCount} 人里只有 {weakest.n} 人通关。{weakest.vol.painQuote}
              </p>
            </div>
          )}

          {/* 每卷通关人数 */}
          <div className="mt-4 grid gap-2 grid-cols-2 sm:grid-cols-4 xl:grid-cols-7">
            {VOLUMES.map((v, i) => {
              const n = passedByVolume[v.id] ?? 0;
              const blind = blindByVolume[v.id] ?? 0;
              const pct = memberCount > 0 ? Math.round((n / memberCount) * 100) : 0;
              const skin = volumeSkin[i % volumeSkin.length];
              return (
                <div key={v.id} className="p-3 rounded-[16px]" style={{ background: 'var(--bg-base)', border: EDGE_THIN }}>
                  <div className="text-[11px] font-bold" style={{ color: 'var(--text-muted)' }}>卷{'一二三四五六七'[i]}</div>
                  <div className="text-[14px] font-black tracking-[-0.01em] leading-[1.3]">{v.name}</div>
                  <div className="mt-2 flex items-center gap-1.5">
                    <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-card)', border: '2px solid var(--shelf-edge)' }}>
                      <div className="h-full transition-[width] duration-500" style={{ width: `${pct}%`, background: skin.fg }} />
                    </div>
                    <span className="text-[11px] font-bold shrink-0">{n}</span>
                  </div>
                  {blind > 0 && (
                    <div className="mt-1 text-[10.5px] font-bold" style={{ color: 'var(--text-muted)' }}>
                      另有 {blind} 人没读就考过
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* 成员行 */}
          <div className="mt-4 flex flex-col gap-2">
            {members.map((m) => (
              <div key={m.userId} className="flex items-center gap-3 px-4 py-2.5 rounded-[14px] flex-wrap" style={{ background: 'var(--bg-base)', border: EDGE_THIN }}>
                <span className="text-[13.5px] font-black min-w-[96px]">
                  {m.displayName ?? '未知成员'}
                </span>
                <span className="text-[12.5px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                  已读 {m.readCount} 本
                </span>
                <span className="text-[12.5px] font-bold" style={{ color: 'var(--text-secondary)' }}>
                  通关 {m.passedCount} / {VOLUMES.length} 卷
                </span>
                <div className="flex gap-1 ml-auto">
                  {VOLUMES.map((v, i) => (
                    <span
                      key={v.id}
                      title={v.name}
                      className="w-3.5 h-3.5 rounded-[4px]"
                      style={{
                        background: m.passedVolumeIds.includes(v.id) ? volumeSkin[i % volumeSkin.length].fg : 'transparent',
                        border: '2px solid var(--shelf-edge-soft)',
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
