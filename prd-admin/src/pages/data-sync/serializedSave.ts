/**
 * 「整份覆盖写」的连续改动串行化。
 *
 * 对外同步名单这类接口收的是整份名单，不是增量。若每次改动都从 props 快照重新算一份
 * 完整名单，连着两次改动就都基于同一份没变过的值：先移除 A 的那次发出的名单里还留着 B，
 * 后移除 B 的那次发出的名单里又把 A 放了回去——后到的覆盖先到的，撤销被悄悄取消。
 * 而票据鉴权每次都读这份名单，所以这不是显示错，是权限错。
 *
 * 解法是把控制反过来：调用方传「怎么改」（mutate），由这里对着**最新的一份**求值。
 * 提取成独立模块是为了能脱开 React 直接测——本仓库前端没有 jsdom/RTL，
 * 组件级渲染测试跑不起来，留在组件里就等于没有任何东西钉住这个不变量。
 */

export interface SerializedSaveDeps<T> {
  /** 取最新一份（组件里是 ref.current，不是 props 快照）。 */
  getLatest: () => T | null;
  /** 落到最新一份 + 界面上（乐观更新，紧接着的下一次改动就基于它算）。 */
  commit: (value: T) => void;
  /**
   * 真正写服务端。ok=false 时回滚。
   *
   * 第二个参数是「这次改动是基于哪一份算出来的」——整份覆盖写要带着它做条件更新，
   * 否则另一个管理员同时在改时，后到的那次会把对方刚移走的条目放回来。
   * 串行化只管本页连点，管不了跨会话。
   *
   * 失败时也可以给 confirmed：服务端说「你手上这份过期了」并回了最新的那份时，
   * 界面该退到**最新**那份，而不是退回提交者原来看到的旧值。
   */
  persist: (value: T, base: T) => Promise<{ ok: boolean; confirmed?: Partial<T>; error?: string }>;
  setBusy: (busy: boolean) => void;
  isBusy: () => boolean;
  onError: (message: string) => void;
  /** persist 失败且没给原因时用的兜底文案。 */
  fallbackErrorMessage: string;
}

export function createSerializedSaver<T extends object>(deps: SerializedSaveDeps<T>) {
  return async function save(mutate: (prev: T) => T): Promise<void> {
    const previous = deps.getLatest();
    // 还没加载出来、或上一次还没落地时不动手：整份覆盖写叠在一起没有正确语义。
    if (!previous || deps.isBusy()) return;

    const next = mutate(previous);
    deps.setBusy(true);
    deps.commit(next);

    const res = await deps.persist(next, previous);
    deps.setBusy(false);

    if (!res.ok) {
      deps.onError(res.error || deps.fallbackErrorMessage);
      // 没存上就退回去，否则界面显示的名单比服务端窄，人以为撤销成功了。
      // 服务端带回了最新那份（并发冲突）就退到它，退回旧值等于让人对着过期数据再试一次。
      deps.commit(res.confirmed ? { ...previous, ...res.confirmed } : previous);
      return;
    }

    deps.commit({ ...next, ...(res.confirmed ?? {}) });
  };
}
