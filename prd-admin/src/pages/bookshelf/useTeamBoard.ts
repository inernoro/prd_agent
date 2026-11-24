/**
 * 团队看板的数据层 —— 桌面卡片与手机整屏共用这一份。
 *
 * 抽出来是因为里面有一段**用事故换来的防御**：2026-09-11 线上，后端返回的 JSON
 * 缺 error 键，不满足 apiClient 的 ApiResponse 判据，`data` 于是不是看板那一层；
 * `memberCount` 成了 undefined（既不等于 0、也不大于 0），渲染照跑，
 * 读 `undefined['vol-boot']` 把整个藏书阁炸成「页面渲染出错」。
 *
 * 这段防御抄成两份，就等于把那次事故的修复只装在其中一半上——而另一半
 * 看起来一模一样（形状 3：判据分裂后各自漂移）。所以它只能有一处。
 */
import { useEffect, useState } from 'react';
import { getBookshelfTeamBoard, type BookshelfTeamDto } from '@/services/real/bookshelf';
import { VOLUMES } from '@/lib/bookshelf/catalog';
import type { Volume } from '@/lib/bookshelf/types';

export interface TeamBoardView {
  state: 'loading' | 'ready' | 'failed';
  raw: BookshelfTeamDto | null;
  memberCount: number;
  passedByVolume: Record<string, number>;
  blindByVolume: Record<string, number>;
  blindTotal: number;
  members: NonNullable<BookshelfTeamDto['members']>;
  /** 全队最薄弱的一卷（通关人数最少）。没人考过任何卷时为 null——不硬凑一句结论。 */
  weakest: { vol: Volume; i: number; n: number } | null;
}

export function useTeamBoard(): TeamBoardView {
  const [raw, setRaw] = useState<BookshelfTeamDto | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await getBookshelfTeamBoard();
        if (!alive) return;
        if (res.success && res.data) { setRaw(res.data); setState('ready'); }
        else setState('failed');
      } catch {
        if (alive) setState('failed');
      }
    })();
    return () => { alive = false; };
  }, []);

  const memberCount = typeof raw?.memberCount === 'number' && Number.isFinite(raw.memberCount)
    ? raw.memberCount : 0;
  const passedByVolume: Record<string, number> =
    raw?.passedByVolume && typeof raw.passedByVolume === 'object' ? raw.passedByVolume : {};
  const members = Array.isArray(raw?.members) ? raw.members : [];
  const blindByVolume: Record<string, number> =
    raw?.blindPassedByVolume && typeof raw.blindPassedByVolume === 'object'
      ? raw.blindPassedByVolume : {};
  const blindTotal = Object.values(blindByVolume).reduce((a, b) => a + (Number(b) || 0), 0);

  const weakest = (() => {
    if (memberCount === 0) return null;
    const counts = VOLUMES.map((v, i) => ({ vol: v, i, n: passedByVolume[v.id] ?? 0 }));
    if (counts.every((c) => c.n === 0)) return null;
    return counts.reduce((min, c) => (c.n < min.n ? c : min), counts[0]);
  })();

  return { state, raw, memberCount, passedByVolume, blindByVolume, blindTotal, members, weakest };
}
