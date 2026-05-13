import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { resolveShortLink } from '@/services';
import type { ShortLinkTargetType } from '@/services';
import { BlackHoleVortex } from '@/components/effects/BlackHoleVortex';
import ShareViewPage from './ShareViewPage';

const SUPPORTED_TARGETS: ShortLinkTargetType[] = ['web_page'];

/**
 * 统一短链入口 /s/:slug
 *
 * - 纯数字 slug → 调 /api/short-links/{seq} 拿到 (targetType, token) → 渲染对应分享视图组件
 * - 非数字 slug → 直接 404（老链接走 /s/wp/:token，不会落到这里）
 *
 * URL 保持 /s/{seq} 不变（不做 navigate，符合"短链就是短"的初衷）。
 */
export default function ShortLinkRouter() {
  const { slug } = useParams<{ slug: string }>();
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'error'; title: string; detail?: string }
    | { kind: 'resolved'; targetType: ShortLinkTargetType; token: string }
  >({ kind: 'loading' });

  useEffect(() => {
    if (!slug) {
      setState({ kind: 'error', title: '链接不存在' });
      return;
    }
    if (!/^\d+$/.test(slug)) {
      setState({ kind: 'error', title: '链接不存在', detail: '短链 ID 必须是数字' });
      return;
    }

    let cancelled = false;
    setState({ kind: 'loading' });
    resolveShortLink(slug).then(res => {
      if (cancelled) return;
      if (!res.success) {
        setState({
          kind: 'error',
          title: '链接不存在',
          detail: res.error?.message,
        });
        return;
      }
      const { targetType, token } = res.data;
      if (!SUPPORTED_TARGETS.includes(targetType)) {
        setState({
          kind: 'error',
          title: '暂不支持的分享类型',
          detail: `targetType=${targetType}`,
        });
        return;
      }
      setState({ kind: 'resolved', targetType, token });
    });

    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (state.kind === 'loading') {
    return <div style={{ position: 'fixed', inset: 0, background: '#0a0a0a' }} />;
  }

  if (state.kind === 'error') {
    return (
      <div style={{
        position: 'fixed', inset: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#0a0a0a',
      }}>
        <div style={{ position: 'absolute', inset: 0 }}><BlackHoleVortex /></div>
        <div style={{
          position: 'relative',
          padding: '40px 32px', textAlign: 'center',
          borderRadius: 16,
          background: 'rgba(255,255,255,0.06)',
          backdropFilter: 'blur(20px)',
          border: '1px solid rgba(255,255,255,0.1)',
          maxWidth: 360,
        }}>
          <div style={{
            width: 64, height: 64, borderRadius: '50%',
            background: 'rgba(239, 68, 68, 0.15)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 20px',
          }}>
            <AlertCircle size={32} color="rgba(239, 68, 68, 0.9)" />
          </div>
          <h2 style={{ color: '#fff', margin: '0 0 8px', fontSize: 20, fontWeight: 600 }}>
            {state.title}
          </h2>
          {state.detail && (
            <p style={{ color: 'rgba(255,255,255,0.6)', margin: 0, fontSize: 13 }}>
              {state.detail}
            </p>
          )}
        </div>
      </div>
    );
  }

  // 目前仅 web_page 接入；将来其他分享类型在此分派即可
  if (state.targetType === 'web_page') {
    return <ShareViewPage tokenOverride={state.token} />;
  }

  return null;
}
