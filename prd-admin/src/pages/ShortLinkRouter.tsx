import { useEffect, useState } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { resolveShortLinkSlug } from '@/services';
import type { ShortLinkTargetType } from '@/services';
import { BlackHoleVortex } from '@/components/effects/BlackHoleVortex';
import ShareViewPage from './ShareViewPage';

/**
 * 统一短链入口 /s/:slug
 *
 * P1 URL 统一（2026-05-20）：放开了"slug 必须纯数字"的限制
 * - 纯数字 slug (`/s/47`) → 后端按 Seq 解析
 * - 字母 slug (`/s/Xa3kZpQ8mFvw`) → 后端按 Token 解析
 * 两种 URL 都走同一调度组件、显示同样的 ShareView，URL bar 保持原始路径不变。
 *
 * 渲染策略（按 targetType）：
 * - web_page  → 直接 mount ShareViewPage（tokenOverride prop）—— URL 完全不变
 * - report / document_store / workflow → 当前 ViewPage 还没接 tokenOverride，
 *   先 Navigate 到旧专用路径 `/s/report-team/...` 等保证功能可用；
 *   下一次 commit 把 ViewPage 改造完毕后即可改为直接 mount，彻底消除 URL 跳转
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

    let cancelled = false;
    setState({ kind: 'loading' });
    resolveShortLinkSlug(slug)
      .then(res => {
        if (cancelled) return;
        if (!res.success || !res.data) {
          setState({
            kind: 'error',
            title: '链接不存在',
            detail: res.error?.message,
          });
          return;
        }
        const { targetType, token } = res.data;
        setState({ kind: 'resolved', targetType, token });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // 防御性兜底：res.data 形态异常导致回调抛 / 网络层意外抛
        // 都让组件离开 loading，避免黑屏永驻
        setState({
          kind: 'error',
          title: '链接解析失败',
          detail: err instanceof Error ? err.message : String(err),
        });
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

  // 目前仅 web_page 接入；将来其他分享类型在此 switch 增加分支即可。
  // default 显式 fallback 一个 error 页，避免新加 targetType 但忘了添加 case 时
  // 用户看到完全空白页（bugbot low #77adffb8）。
  return renderTarget(state.targetType, state.token);
}

function renderTarget(targetType: ShortLinkTargetType, token: string) {
  switch (targetType) {
    case 'web_page':
      // ShareViewPage 已支持 tokenOverride，直接 mount，URL bar 不变
      return <ShareViewPage tokenOverride={token} />;
    case 'report':
      // 周报历史专用路由存在且有效
      return <Navigate to={`/s/report-team/${token}`} replace />;
    case 'skill':
      // 技能分享历史专用路由
      return <Navigate to={`/s/skill/${token}`} replace />;
    case 'document_store':
      // 知识库历史用 /library/share/:token；当前 App.tsx 尚未注册该 Route（独立缺陷，下条 debt 项）
      // 这里跳转保持与 DocumentStorePage 创建分享 URL 一致；至少不发明新地址造成多套破链
      return <Navigate to={`/library/share/${token}`} replace />;
    case 'workflow':
      // 工作流没有专用 ViewPage SPA 路由，历史一直走 /s/{token} 走本 Router；
      // 显示 Unsupported 让用户知道路径，避免跳转到不存在的地址造成静默 404
      return <UnsupportedTargetError targetType={targetType} />;
    default:
      return <UnsupportedTargetError targetType={targetType} />;
  }
}

function UnsupportedTargetError({ targetType }: { targetType: string }) {
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
          background: 'rgba(245, 158, 11, 0.15)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 20px',
        }}>
          <AlertCircle size={32} color="rgba(245, 158, 11, 0.9)" />
        </div>
        <h2 style={{ color: '#fff', margin: '0 0 8px', fontSize: 20, fontWeight: 600 }}>
          暂不支持的分享类型
        </h2>
        <p style={{ color: 'rgba(255,255,255,0.6)', margin: 0, fontSize: 13 }}>
          targetType={targetType}
        </p>
      </div>
    </div>
  );
}
