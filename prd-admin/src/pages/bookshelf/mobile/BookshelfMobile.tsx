/**
 * 手机档 · 藏书阁外壳（两级导航）。
 *
 * 终稿把落地页与卷页拆成了两层。这一层负责「现在该画哪一屏」，
 * 判据只有一个：URL 上有没有 ?vol=。
 *
 *   无 ?vol=                 → 落地页（七卷清单）
 *   ?vol=<认得出的卷>        → 卷页
 *   ?vol=<卷>&book=<书>      → 书页（精读稿那一屏）
 *   ?vol=<认不出的值>        → 落地页（不静默回落到卷一——那会让一个拼错的链接
 *                              看起来像「正常打开了卷一」，用户永远不知道自己打错了）
 *
 * 书页是第三层，**进 URL**，与考试那一层刚好相反：一篇精读稿就是要能甩给同事看的，
 * 而考到一半的卷子不该被分享出去。
 *
 * 桌面档的 ?vol= 语义不同：它永远选中一卷，认不出就回落首卷（resolveVolumeFromUrl）。
 * 两个问题不一样（「选中哪一卷」vs「选中了吗」），所以是两个函数，但住在同一个
 * 文件里、由同一组守卫覆盖——不是各写一份散在两处（形状 3：判据分裂后各自漂移）。
 *
 * 考试是卷页之上的第三层（同一个 ?vol= 加一个本地状态），不进 URL：
 * 考到一半的卷子不该被分享出去，刷新重来才是对的。
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { VOLUMES, findVolume } from '@/lib/bookshelf/catalog';
import type { Volume, BookEntry } from '@/lib/bookshelf/types';
import { useExamSession } from '../useExamSession';
import { MobileLanding, type RoleFilter } from './MobileLanding';
import { MobileVolume } from './MobileVolume';
import { MobileBook } from './MobileBook';
import { MobileExam } from './MobileExam';
import { MobileBoard } from './MobileBoard';

/**
 * 手机档的 ?vol= 解析：认得出就给那一卷，否则给 null（= 停在落地页）。
 * 与桌面的 `resolveVolumeFromUrl` 是同一份 URL 的两个问题，刻意分开命名。
 */
export function selectedVolumeFromUrl(raw: string | null): Volume | null {
  if (!raw) return null;
  return findVolume(raw) ?? null;
}

/**
 * 手机档的 ?book= 解析：这本书必须真的在**这一卷**里。
 *
 * 只按 id 全局找的话，`?vol=vol-boot&book=b-ddia` 会打开卷一的壳子装卷四的书，
 * 返回键回到一个它根本不属于的卷 —— 一条拼错的链接就能造出一个自相矛盾的页面。
 */
export function selectedBookFromUrl(volume: Volume | null, raw: string | null): BookEntry | null {
  if (!volume || !raw) return null;
  return volume.books.find((b) => b.id === raw) ?? null;
}

export function BookshelfMobile({ skinOf }: { skinOf: (volumeId: string) => { fg: string; box: string } }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [role, setRole] = useState<RoleFilter>('all');
  const [examing, setExaming] = useState(false);

  const volume = selectedVolumeFromUrl(searchParams.get('vol'));
  const book = selectedBookFromUrl(volume, searchParams.get('book'));
  const onBoard = searchParams.get('board') === '1';
  const session = useExamSession(examing ? volume : null);

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams);
    if (value === null) next.delete(key); else next.set(key, value);
    setSearchParams(next, { replace: false });
  }
  const openVolume = (id: string) => setParam('vol', id);
  const backToLanding = () => setParam('vol', null);
  const openBook = (id: string) => setParam('book', id);
  const backToVolume = () => setParam('book', null);

  if (onBoard) return <MobileBoard skinOf={skinOf} onBack={() => setParam('board', null)} />;

  // 书页排在考试之前：从书页点「开始考」不是它的路径，两者不会同时成立。
  if (volume && book) {
    return (
      <MobileBook
        book={book}
        volume={volume}
        skin={skinOf(volume.id)}
        onBack={backToVolume}
      />
    );
  }

  if (volume && examing) {
    return (
      <MobileExam
        volume={volume}
        skin={skinOf(volume.id)}
        session={session}
        onBack={() => { setExaming(false); session.reset(); }}
      />
    );
  }

  if (volume) {
    return (
      <MobileVolume
        volume={volume}
        skin={skinOf(volume.id)}
        onBack={backToLanding}
        onOpenBook={openBook}
        onStartExam={() => { session.reset(); setExaming(true); }}
      />
    );
  }

  return (
    <MobileLanding
      role={role}
      onRole={setRole}
      skinOf={skinOf}
      onOpenVolume={openVolume}
      onOpenBoard={() => setParam('board', '1')}
    />
  );
}

/** 守卫用：卷序汉字与 VOLUMES 一一对应，改卷数要一起改。 */
export const VOLUME_COUNT = VOLUMES.length;
