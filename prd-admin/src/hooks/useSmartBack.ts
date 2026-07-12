/**
 * useSmartBack — 统一「返回上一页」语义（浏览器返回/手机右滑返回的同源逻辑）。
 *
 * 背景（2026-07-12 用户反馈）：手机右滑返回、鼠标侧键返回总是落到奇怪的导航页，
 * 而不是真正跳转过来的那个上一页。根因有二：
 *   1. 各页返回按钮硬编码 navigate('/某列表')——这是 push 一个新条目，不是弹栈，
 *      会让 history 越走越深，浏览器返回要按好几次、且经过用户没浏览过的页面；
 *   2. 裸 navigate(-1) 在「新标签页直达 / 刷新后 / 登录跳转后」没有站内上一条时，
 *      会退到登录页甚至外站。
 *
 * 本 hook 的语义：有站内上一条历史 → navigate(-1)（真弹栈，与手势返回一致）；
 * 没有 → replace 到 fallback（不再堆新条目）。
 *
 * 判定依据：react-router v7 的 BrowserRouter 会在 window.history.state 写入
 * { idx } —— 本标签页内由路由管理的历史序号。idx > 0 说明栈里确有站内上一条。
 */
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

/** 本标签页内是否存在可安全返回的站内上一条历史。 */
export function canGoBackInApp(): boolean {
  const state = window.history.state as { idx?: number } | null;
  return typeof state?.idx === 'number' && state.idx > 0;
}

/**
 * 返回一个「智能返回」回调。
 * @param fallback 无站内历史时的兜底目的地（默认首页），以 replace 方式跳转。
 */
export function useSmartBack(fallback: string = '/') {
  const navigate = useNavigate();
  return useCallback(() => {
    if (canGoBackInApp()) {
      navigate(-1);
    } else {
      navigate(fallback, { replace: true });
    }
  }, [navigate, fallback]);
}
