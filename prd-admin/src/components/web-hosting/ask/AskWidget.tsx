import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageCircleQuestion } from 'lucide-react';
import AskPanel from './AskPanel';
import type { AskSource } from './askTypes';

interface Props {
  source: AskSource;
  title: string;
  welcome?: string | null;
  openingQuestions: string[];
  allowAnonymous: boolean;
  /**
   * 隐藏入口（全屏演示态等）。父级判定后传进来，
   * 组件自己不去猜"现在是不是全屏"。
   */
  hidden?: boolean;
}

/**
 * 右下角「向我提问」入口 + 抽屉。
 *
 * 走 createPortal 挂到 body：托管页面本体在 iframe 里，浮层必须在 iframe 之外、
 * MAP 页面之内——注入托管 HTML 要放行 CORS 到对象存储域名、处理 srcDoc 下的 null
 * origin，还会打开一个 XSS 面，代价远大于收益。
 *
 * 收起状态只存在 React state 里，不落 localStorage：这是"这一次访问要不要开着"，
 * 不是设备级偏好。
 */
export default function AskWidget({
  source, title, welcome, openingQuestions, allowAnonymous, hidden,
}: Props) {
  const [open, setOpen] = useState(false);
  /** 打开过至少一次。之后面板常驻挂载，收起只藏不卸——理由见下方渲染处注释 */
  const [hasOpened, setHasOpened] = useState(false);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false,
  );

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Esc 关闭：抽屉是覆盖层，用户的第一反应就是按 Esc。
  // hidden 时（评论抽屉/全屏演示在上层）不抢 Esc——那时候盖在最上面的不是我们。
  useEffect(() => {
    if (!open || hidden) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, hidden]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      {/* hidden（全屏演示 / 评论抽屉在上层）时只藏入口，**不卸载**整棵子树——
          早先这里是 `if (hidden) return null`，切去评论再切回来对话就没了，
          流式输出中途切走那次请求还会无人认领地跑完。藏与卸的区别就在这。 */}
      {!open && !hidden && (
        <button
          onClick={() => { setOpen(true); setHasOpened(true); }}
          aria-label="向我提问"
          style={{
            position: 'fixed',
            right: 18,
            // 移动端上移，避开 iOS 底部手势条
            bottom: isMobile ? 'calc(18px + env(safe-area-inset-bottom, 0px))' : 18,
            zIndex: 55,
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 16px', borderRadius: 999, border: 'none',
            background: 'var(--button-primary-bg)',
            // 主操作面必须走 button-primary 这对 token：accent 底配浅色字只有 2.92:1，
            // 达不到对比度下限（守卫见 inkPalette.test.ts）
            color: 'var(--button-primary-fg)',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
            boxShadow: 'var(--shadow-glass-floating)',
          }}
        >
          <MessageCircleQuestion size={17} />
          向我提问
        </button>
      )}

      {/* 一旦打开过就保持挂载，收起只是 display:none。
          卸载会连同 useAskStream 的 messages 与 sessionId 一起销毁：重开是一段空对话；
          若在流式输出中途收起，那次 fetch 也没有卸载清理、会继续跑到底——钱花了、答案没人看见。
          没打开过的访客不挂载，避免给所有人白付一个组件。 */}
      {(open || hasOpened) && (
        <AskPanel
          source={source}
          title={title}
          welcome={welcome}
          openingQuestions={openingQuestions}
          allowAnonymous={allowAnonymous}
          isMobile={isMobile}
          hidden={hidden || !open}
          onClose={() => setOpen(false)}
        />
      )}
    </>,
    document.body,
  );
}
