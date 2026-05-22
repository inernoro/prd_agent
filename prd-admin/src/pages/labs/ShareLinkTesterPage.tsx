import { useState } from 'react';
import { Link2, ExternalLink, Search, AlertCircle, CheckCircle2, Copy, Check } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { PageHeader } from '@/components/design/PageHeader';
import { toast } from '@/lib/toast';
import { resolveShortLinkSlug } from '@/services';
import type { ShortLinkResolved } from '@/services/real/shortLinks';

/**
 * 分享链接体检（实验室工具）
 *
 * 用户提到："怎么测试很重要哦，做一个曾经分享的链接测试，我来测测看"。
 * 本页面承担"P1 URL 统一"的人工验收工具：粘贴任意 slug（数字 seq 或字母 token），
 * 后端解析得 (targetType, token, seq)，并列出 3 种 URL 形态让用户挨个点击验证：
 *
 *   1. 统一长链 `/s/{token}`        ← P1 主推，不可枚举
 *   2. 超短链   `/s/{seq}`          ← 数字短易传播，须配强密码
 *   3. 旧版前缀链 `/s/wp/{token}`   ← 仅 web_page 有，向后兼容
 *
 * 每种 URL 都用 origin 拼绝对路径展示 + 在新标签页打开，方便对比 URL bar 变化。
 */

const TYPE_LABELS: Record<string, string> = {
  web_page: '网页托管',
  report: '周报',
  document_store: '知识库',
  workflow: '工作流',
  skill: '技能',
  defect: '缺陷分享',
  toolbox: '百宝箱',
};

const LEGACY_PATH: Record<string, (t: string) => string | null> = {
  web_page: (t) => `/s/wp/${t}`,
  report: (t) => `/s/report-team/${t}`,
  skill: (t) => `/s/skill/${t}`,
  document_store: () => null, // /library/share/:token SPA 路由历史缺失，无可用旧版链（debt -1）
  workflow: () => null, // 工作流没有旧版独立路径，新旧都走 /s/{token}
};

export default function ShareLinkTesterPage() {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ShortLinkResolved | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleResolve = async () => {
    const slug = input.trim();
    if (!slug) {
      toast.error('请输入 slug', '可以是数字 Seq 或字母 Token');
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await resolveShortLinkSlug(slug);
      if (!res.success || !res.data) {
        setError(res.error?.message || '解析失败');
        return;
      }
      setResult(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '网络异常');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    });
  };

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  // 构造 3 种 URL 形态
  type UrlItem = { label: string; key: string; path: string; note: string; recommended?: boolean };
  const buildUrls = (r: ShortLinkResolved): UrlItem[] => {
    const items: UrlItem[] = [
      {
        label: '统一长链（P1 推荐）',
        key: 'unified',
        path: `/s/${r.token}`,
        note: 'base64 token 72 bits 熵，不可枚举猜测；URL 干净统一，所有类型同格式',
        recommended: true,
      },
      {
        label: '超短链',
        key: 'short',
        path: `/s/${r.seq}`,
        note: '数字 seq 可被遍历枚举，必须配强密码；适合口述/手抄/二维码',
      },
    ];
    const legacyPath = LEGACY_PATH[r.targetType]?.(r.token);
    if (legacyPath) {
      items.push({
        label: '旧版带前缀链（兼容用）',
        key: 'legacy',
        path: legacyPath,
        note: 'P1 之前的形态，已废弃但仍可访问；新分享不再生成此格式',
      });
    }
    return items;
  };

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-sunken)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-default)',
  };

  return (
    <div className="flex flex-col gap-5 h-full min-h-0 p-6 overflow-y-auto">
      <PageHeader
        title="分享链接体检"
        description={
          <span className="flex items-center gap-2">
            <Link2 size={14} />
            粘贴任意 slug 看后端解析；对比 3 种 URL 形态的打开效果，验收 P1 URL 统一
          </span>
        }
      />

      <GlassCard className="p-5">
        <div className="flex flex-col gap-3">
          <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
            输入 slug（数字 seq 或字母 token，从已分享的 URL 中复制）
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleResolve();
              }}
              placeholder="例如：47 或 Xa3kZpQ8mFvw"
              className="flex-1 px-3 py-2 rounded-lg text-sm outline-none font-mono"
              style={inputStyle}
            />
            <Button onClick={handleResolve} disabled={loading || !input.trim()}>
              <Search size={14} />
              {loading ? '解析中…' : '解析'}
            </Button>
          </div>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            提示：在任何分享弹窗里复制链接后，把 `/s/` 后面的部分粘到这里。
            两种形态都能识别 —— 纯数字按 Seq 反查，字母按 Token 反查。
          </p>
        </div>
      </GlassCard>

      {error && (
        <GlassCard className="p-5" style={{ borderColor: 'rgba(239, 68, 68, 0.5)' }}>
          <div className="flex items-center gap-2">
            <AlertCircle size={18} style={{ color: '#ef4444' }} />
            <div>
              <div className="text-sm font-medium" style={{ color: '#ef4444' }}>
                解析失败
              </div>
              <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                {error}
              </div>
            </div>
          </div>
        </GlassCard>
      )}

      {result && (
        <>
          <GlassCard className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle2 size={18} style={{ color: '#22c55e' }} />
              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                解析成功
              </span>
              <Badge variant="subtle">
                {TYPE_LABELS[result.targetType] ?? result.targetType}
              </Badge>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <div>
                <span style={{ color: 'var(--text-muted)' }}>资源类型：</span>
                <span className="font-mono" style={{ color: 'var(--text-primary)' }}>
                  {result.targetType}
                </span>
              </div>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Seq：</span>
                <span className="font-mono" style={{ color: 'var(--text-primary)' }}>
                  {result.seq}
                </span>
              </div>
              <div className="col-span-2">
                <span style={{ color: 'var(--text-muted)' }}>Token：</span>
                <span className="font-mono break-all" style={{ color: 'var(--text-primary)' }}>
                  {result.token}
                </span>
              </div>
            </div>
          </GlassCard>

          <div>
            <h3 className="text-sm font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>
              3 种 URL 形态 — 逐个点击打开比对 URL bar 变化
            </h3>
            <div className="flex flex-col gap-3">
              {buildUrls(result).map((item) => {
                const fullUrl = origin + item.path;
                return (
                  <GlassCard
                    key={item.key}
                    className="p-4"
                    style={
                      item.recommended
                        ? { borderColor: 'rgba(34, 197, 94, 0.4)' }
                        : undefined
                    }
                  >
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                          {item.label}
                        </span>
                        {item.recommended && (
                          <Badge variant="success">推荐</Badge>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleCopy(fullUrl, item.key)}
                        >
                          {copiedKey === item.key ? <Check size={14} /> : <Copy size={14} />}
                          复制
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => window.open(item.path, '_blank', 'noopener')}
                        >
                          <ExternalLink size={14} />
                          新标签打开
                        </Button>
                      </div>
                    </div>
                    <div
                      className="px-3 py-2 rounded text-xs font-mono break-all"
                      style={{ background: 'var(--bg-sunken)', color: 'var(--text-primary)' }}
                    >
                      {fullUrl}
                    </div>
                    <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                      {item.note}
                    </p>
                  </GlassCard>
                );
              })}
            </div>
          </div>

          <GlassCard className="p-4" style={{ background: 'rgba(59, 130, 246, 0.08)' }}>
            <div className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              <strong>P1 验收要点：</strong>
              <ul className="mt-2 ml-4 list-disc space-y-1">
                <li>"统一长链" 应当 100% 可打开，URL bar 始终保持 <code>/s/{'{token}'}</code> 形式（web_page 类型）；
                  其它类型当前会跳转到旧路径（P1.next 待解决，见 <code>doc/debt.share-link-security.md</code>）</li>
                <li>"超短链" 和 "统一长链" 都汇到同一个 ShortLink 索引，
                  应当显示相同内容（互为别名）</li>
                <li>"旧版前缀链" 仅 web_page / report / skill / document_store 有；
                  workflow 历史就一直用 <code>/s/{'{token}'}</code> 不需要兼容旧路径</li>
              </ul>
            </div>
          </GlassCard>
        </>
      )}
    </div>
  );
}
