import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, Package, ShieldCheck } from 'lucide-react';
import { viewSkillShare, type ViewSkillShareData } from '@/services';
import { useAuthStore } from '@/stores/authStore';
import { SkillContentBrowser } from '@/components/marketplace/SkillContentBrowser';
import { MapSectionLoader } from '@/components/ui/VideoLoader';

/**
 * 技能公开分享页 —— 免登录只读浏览 SKILL.md + 文件树。
 * 路由 /s/skill/:token，在 AppShell 之外，无鉴权 guard。
 * 复用 SkillContentBrowser（与详情弹窗同一内核）。
 */
export default function SkillShareViewPage() {
  const { token } = useParams<{ token: string }>();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [data, setData] = useState<ViewSkillShareData | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setLoading(false);
      setError({ code: 'NOT_FOUND', message: '缺少分享标识' });
      return;
    }
    setLoading(true);
    setError(null);
    viewSkillShare(token).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (res.success && res.data) {
        setData(res.data);
      } else {
        setError(res.error || { code: 'UNKNOWN', message: '加载失败' });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (loading) {
    return (
      <div
        className="flex h-screen w-screen items-center justify-center"
        style={{ background: 'var(--bg-primary, #0a0a0a)' }}
      >
        <MapSectionLoader text="正在加载分享的技能…" />
      </div>
    );
  }

  if (error || !data) {
    const isNotFound = error?.code === 'NOT_FOUND';
    const isExpired = error?.code === 'EXPIRED';
    return (
      <div
        className="flex h-screen w-screen flex-col items-center justify-center gap-3 px-6 text-center"
        style={{ background: 'var(--bg-primary, #0a0a0a)' }}
      >
        <div
          className="flex h-16 w-16 items-center justify-center rounded-full"
          style={{ background: 'rgba(239,68,68,0.15)' }}
        >
          <AlertCircle size={30} color="rgba(239,68,68,0.9)" />
        </div>
        <h2 className="text-[18px] font-semibold" style={{ color: 'var(--text-primary, #fff)' }}>
          {isNotFound ? '链接不存在' : isExpired ? '链接已过期' : '出错了'}
        </h2>
        <p className="text-[13px]" style={{ color: 'var(--text-muted, rgba(255,255,255,0.5))' }}>
          {isNotFound
            ? '该分享链接不存在或已被撤销'
            : isExpired
              ? '该分享链接已超过有效期'
              : error?.message || '加载失败'}
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex h-screen w-screen flex-col"
      style={{ background: 'var(--bg-primary, #0a0a0a)', color: 'var(--text-primary)' }}
    >
      {/* 顶部条 */}
      <div
        className="flex shrink-0 items-center gap-3 px-5 py-3 border-b"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}
      >
        <Package size={18} style={{ color: 'var(--accent-primary, rgba(56,189,248,0.9))' }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {data.skill.title || data.skillTitle}
          </div>
          <div className="flex items-center gap-1.5 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <ShieldCheck size={11} style={{ color: 'rgba(34,197,94,0.8)' }} />
            由 海鲜市场{data.createdByName ? ` · ${data.createdByName}` : ''} 分享（只读）
          </div>
        </div>
        {!isAuthenticated && (
          <a
            href="/login"
            className="shrink-0 text-[12px] underline underline-offset-2"
            style={{ color: 'var(--accent-primary, rgba(56,189,248,0.9))' }}
          >
            登录后可收藏 / 拿来吧
          </a>
        )}
      </div>

      {/* 内容 */}
      <div className="flex-1" style={{ minHeight: 0 }}>
        <SkillContentBrowser
          zipUrl={`/api/marketplace/skills/public/skill-share/${token}/zip-content`}
          sizeBytes={data.skill.zipSizeBytes}
        />
      </div>
    </div>
  );
}
