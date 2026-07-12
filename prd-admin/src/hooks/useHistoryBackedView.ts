/**
 * useHistoryBackedView — 让「同路由内的全屏级视图切换」进浏览器历史。
 *
 * 背景（2026-07-12 用户反馈第二阶段）：百宝箱/知识库/周报/涌现/技能/缺陷(移动端)/工作流执行
 * 等页面的「列表 → 详情/编辑器」只是 useState / zustand 字段切换，URL 与 history 完全不动。
 * 用户感知是「进了新页面」，但历史里没有这一步——手机右滑返回/浏览器返回弹出的是进入该
 * Agent 之前的条目（往往是首页/launcher 导航页），而不是回到列表。
 *
 * 本 hook 把这类视图的开/关与 URL query 双向同步：
 *   - 视图打开（value 由 null 变为非空，或在两个非空视图间切换）→ push 一条 `?{param}=value`
 *   - 手势/浏览器返回弹掉该 query → 自动调用 onExit 关闭视图（回到列表）
 *   - 内部返回按钮关闭视图（value 变 null）→ 弹掉我们 push 的那条历史（与手势等价）；
 *     若该 query 并非本会话 push（深链直达），则 replace 清掉，不误退出站外
 *   - 刷新/深链/前进带着 query 进来 → 调 onRestore 恢复视图；恢复不了（数据未加载等）
 *     返回 false，hook 用 replace 清掉 query 并回落列表态
 *
 * 副作用红利：接入的视图从此可刷新、可复制 URL 分享（onRestore 可恢复时）。
 *
 * 用法：
 *   useHistoryBackedView({
 *     param: 'defectId',
 *     value: selectedDefectId,                  // null = 视图关闭
 *     onExit: () => setSelectedDefectId(null),  // 返回手势 → 关视图
 *     onRestore: (id) => trySelect(id),         // 可选：深链/刷新恢复；返回 false 表示恢复失败
 *   });
 */
import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { canGoBackInApp } from './useSmartBack';

export interface HistoryBackedViewOptions {
  /** URL query 参数名（页面内唯一） */
  param: string;
  /** 当前视图标识；null 表示视图关闭（列表态） */
  value: string | null;
  /** URL 侧把 param 弹掉（手势/浏览器返回）时关闭视图 */
  onExit: () => void;
  /**
   * URL 带 param 而视图关闭（深链/刷新/前进）时恢复视图。
   * 返回 false 表示无法恢复（如目标已被删除），hook 会 replace 清掉 param 并回落列表态。
   * 省略时视为不可恢复。
   */
  onRestore?: (value: string) => boolean | void;
  /**
   * 恢复所需的数据是否已就绪（默认 true）。依赖异步加载数据做恢复的页面（如百宝箱
   * 需要 items 列表）传入加载完成信号：未就绪时 hook 保留 param 挂起恢复，就绪后自动
   * 重试一次，避免「刷新/深链进来时数据还没到，param 被立刻清掉回落列表」。
   */
  restoreReady?: boolean;
}

/** 一次 value/urlValue 变化应执行的动作（纯决策，供单测覆盖） */
export type HistoryViewAction =
  | { kind: 'none' }
  | { kind: 'push' }        // 状态侧打开/切换视图 → push param
  | { kind: 'pop' }         // 状态侧关闭且本会话 push 过 → navigate(-1) 真弹栈
  | { kind: 'clean' }       // 状态侧关闭但 param 非本会话 push → replace 清 param
  | { kind: 'exit' }        // URL 侧弹掉 param（手势返回）→ 关闭视图
  | { kind: 'restore' };    // URL 侧出现/变更 param → 恢复视图（失败则 clean + exit）

export interface HistoryViewSnapshot {
  mounted: boolean;
  pushed: boolean;
  canGoBack: boolean;
  prevValue: string | null;
  value: string | null;
  prevUrl: string | null;
  urlValue: string | null;
}

export function resolveHistoryViewAction(s: HistoryViewSnapshot): HistoryViewAction {
  if (!s.mounted) {
    // 首次挂载：URL 带着 param 进来（深链/刷新）→ 恢复视图；
    // 视图已开着但 URL 没有 param（sessionStorage/store 持久化自动恢复）→ 补 push，
    // 保证「进页面即落在详情」时返回手势仍能先关详情回列表。
    if (s.urlValue && s.urlValue !== s.value) return { kind: 'restore' };
    if (s.value && !s.urlValue) return { kind: 'push' };
    return { kind: 'none' };
  }
  if (s.value !== s.prevValue) {
    // 状态侧发起（页面代码打开/关闭了视图）
    if (s.value && s.urlValue !== s.value) return { kind: 'push' };
    if (!s.value && s.urlValue) {
      return s.pushed && s.canGoBack ? { kind: 'pop' } : { kind: 'clean' };
    }
    return { kind: 'none' };
  }
  if (s.urlValue !== s.prevUrl) {
    // URL 侧发起（popstate 返回/前进、外部写入）
    if (!s.urlValue && s.value) return { kind: 'exit' };
    if (s.urlValue && s.urlValue !== s.value) return { kind: 'restore' };
  }
  return { kind: 'none' };
}

export function useHistoryBackedView({ param, value, onExit, onRestore, restoreReady = true }: HistoryBackedViewOptions) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlValue = searchParams.get(param);

  // 本会话内是否由本 hook push 过 param（区分「弹栈关闭」与「深链直达后 replace 清理」）
  const pushedRef = useRef(false);
  const prevValueRef = useRef<string | null>(null);
  const prevUrlRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  // 数据未就绪时挂起的恢复目标：restoreReady 翻 true 后重试（Codex P2：
  // 异步加载数据的页面不能在挂载瞬间就把深链 param 清掉）
  const pendingRestoreRef = useRef<string | null>(null);

  // 回调走 ref，避免调用方内联函数导致 effect 每轮重跑
  const onExitRef = useRef(onExit);
  const onRestoreRef = useRef(onRestore);
  onExitRef.current = onExit;
  onRestoreRef.current = onRestore;

  useEffect(() => {
    const writeParams = (mutate: (p: URLSearchParams) => void, replace: boolean) => {
      // 从 window.location.search 取当前值，避免闭包里的 searchParams 过期覆盖别的参数
      const next = new URLSearchParams(window.location.search);
      mutate(next);
      setSearchParams(next, { replace });
    };
    /** 立即尝试恢复；数据未就绪则挂起等 restoreReady，彻底恢复不了才清 param 回落列表 */
    const attemptRestore = (target: string) => {
      if (!restoreReady) {
        pendingRestoreRef.current = target;
        return;
      }
      pendingRestoreRef.current = null;
      const ok = onRestoreRef.current ? onRestoreRef.current(target) !== false : false;
      if (!ok) {
        // 恢复失败：清 param 并回落列表态，避免「URL 说开着、界面是列表」的分裂
        writeParams((p) => p.delete(param), true);
        onExitRef.current();
      }
    };

    // 先处理挂起的恢复：URL 已变/页面已自行恢复则放弃；数据就绪则重试
    if (pendingRestoreRef.current) {
      if (!urlValue || urlValue !== pendingRestoreRef.current || value === urlValue) {
        pendingRestoreRef.current = null;
      } else if (restoreReady) {
        prevValueRef.current = value;
        prevUrlRef.current = urlValue;
        attemptRestore(urlValue);
        return;
      }
    }

    const action = resolveHistoryViewAction({
      mounted: mountedRef.current,
      pushed: pushedRef.current,
      canGoBack: canGoBackInApp(),
      prevValue: prevValueRef.current,
      value,
      prevUrl: prevUrlRef.current,
      urlValue,
    });
    mountedRef.current = true;
    prevValueRef.current = value;
    prevUrlRef.current = urlValue;

    switch (action.kind) {
      case 'push':
        writeParams((p) => p.set(param, value as string), false);
        pushedRef.current = true;
        break;
      case 'pop':
        pushedRef.current = false;
        navigate(-1);
        break;
      case 'clean':
        pushedRef.current = false;
        writeParams((p) => p.delete(param), true);
        break;
      case 'exit':
        pushedRef.current = false;
        onExitRef.current();
        break;
      case 'restore':
        attemptRestore(urlValue as string);
        break;
      case 'none':
        break;
    }
  }, [value, urlValue, param, navigate, setSearchParams, restoreReady]);
}
