import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import AskDock from './AskDock';
import type { AskSource } from './askTypes';

interface Props {
  source: AskSource;
  title: string;
  welcome?: string | null;
  openingQuestions: string[];
  allowAnonymous: boolean;
  /**
   * 隐藏入口（全屏演示态 / 评论抽屉在上层）。父级判定后传进来，
   * 组件自己不去猜"现在是不是全屏"。
   */
  hidden?: boolean;
}

/**
 * 量一次 iOS 手势条的高度。
 *
 * 形变要把几何写成数字喂给 WAAPI，而 `env(safe-area-inset-bottom)` 只能在 CSS 里求值，
 * 拿不到数。所以塞一个高度等于该 env 的隐形探针进 DOM，量完就撤。
 * 不补这一段的话，手机上收起的胶囊和起手长条会压在手势条上——主操作点不准。
 */
function measureSafeBottom(): number {
  if (typeof document === 'undefined') return 0;
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;left:0;bottom:0;width:0;height:env(safe-area-inset-bottom, 0px);'
    + 'pointer-events:none;visibility:hidden';
  document.body.appendChild(probe);
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return Number.isFinite(h) ? h : 0;
}

/**
 * 访客页「向我提问」的挂载点。
 *
 * 走 createPortal 挂到 body：托管页面本体在 iframe 里，浮层必须在 iframe 之外、
 * MAP 页面之内——注入托管 HTML 要放行 CORS 到对象存储域名、处理 srcDoc 下的 null
 * origin，还会打开一个 XSS 面，代价远大于收益。
 *
 * 本组件只负责「挂载 + 量视口」；四态与形变全在 AskDock 里，因为那是同一个 DOM 节点
 * 从头变到尾，拆开两个组件就没法形变了。
 */
export default function AskWidget({
  source, title, welcome, openingQuestions, allowAnonymous, hidden,
}: Props) {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false,
  );
  const [safeBottom, setSafeBottom] = useState(0);

  useEffect(() => {
    const sync = () => {
      setIsMobile(window.innerWidth < 768);
      setSafeBottom(measureSafeBottom());
    };
    sync();
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', sync);
    return () => {
      window.removeEventListener('resize', sync);
      window.removeEventListener('orientationchange', sync);
    };
  }, []);

  if (typeof document === 'undefined') return null;

  // hidden 时 AskDock 内部只是 display:none，**不卸载**——卸载会连同 useAskStream 的
  // messages 与 sessionId 一起销毁：切去评论再切回来对话就没了，流式输出中途切走那次
  // 请求还会无人认领地跑完（钱花了、答案没人看见）。藏与卸的区别就在这。
  return createPortal(
    <AskDock
      source={source}
      title={title}
      welcome={welcome}
      openingQuestions={openingQuestions}
      allowAnonymous={allowAnonymous}
      isMobile={isMobile}
      safeBottom={safeBottom}
      hidden={hidden}
    />,
    document.body,
  );
}
