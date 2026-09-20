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
 * 考试是卷页之上的第三层，不进 URL：考到一半的卷子不该被分享出去，刷新重来才是对的。
 * 但「不进 URL」不等于「与 URL 无关」——它记的是**在哪一卷上**开的考（examIsActive），
 * 只记一个布尔量会被浏览器返回甩下（见那个函数的注释）。
 */
import { useEffect, useState } from 'react';
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

/**
 * 考试这一屏现在开着吗。
 *
 * 判据不是「有没有点过开始考」，是「**这一卷**上点过开始考」。
 * 只留一个布尔量会漏掉浏览器返回：考试不进 URL（考到一半的卷子不该被分享出去），
 * 于是手势返回只改 ?vol=、不经过 MobileExam 的 onBack，那个布尔量就一直挂着。
 * 接着从落地页点开另一卷 —— 它会直接渲染成那一卷的考试屏，而且带着上一卷的
 * 作答与交卷结果：用户还没开始考，屏幕上已经有答案和成绩了。
 *
 * 所以把它绑在卷上，让「离开这一卷」这件事自动把考试关掉，不必再去记得手工清。
 */
export function examIsActive(volumeId: string | null, examOfVolumeId: string | null): boolean {
  return volumeId !== null && volumeId === examOfVolumeId;
}

export function BookshelfMobile({ skinOf }: { skinOf: (volumeId: string) => { fg: string; box: string } }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [role, setRole] = useState<RoleFilter>('all');
  const [examOfVolume, setExamOfVolume] = useState<string | null>(null);

  const volume = selectedVolumeFromUrl(searchParams.get('vol'));
  const volumeId = volume?.id ?? null;
  const book = selectedBookFromUrl(volume, searchParams.get('book'));
  const onBoard = searchParams.get('board') === '1';
  const examing = examIsActive(volumeId, examOfVolume);
  const session = useExamSession(examing ? volume : null);

  // 换卷（含返回到落地页）即散场。上面那个判据已经保证不会画错一帧，
  // 这里只是把记号擦掉，免得原路返回时半张旧卷子又冒出来。
  useEffect(() => { setExamOfVolume(null); }, [volumeId]);

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
        onBack={() => { setExamOfVolume(null); session.reset(); }}
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
        onStartExam={() => { session.reset(); setExamOfVolume(volume.id); }}
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
