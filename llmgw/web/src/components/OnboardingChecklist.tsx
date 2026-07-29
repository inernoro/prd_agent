// 新人轨：四步派生清单。
//
// 教程页（Quickstart）是中间轨道——它假设你已经知道自己要什么。真正的新人在它之前
// 就卡住了：不知道现在缺团队、缺成员、缺密钥，还是缺一次真实调用。本组件只回答
// 「你还差哪一步」，每步一个 CTA，**零解释段落**——解释归教程页，这里不复述。
//
// 两条不变量：
//   1. 四项全成立即整体返回 null。熟人两周后再也不会看到它，不需要「关闭」按钮，
//      也就没有「关了以后再也找不回来」的问题。
//   2. 当前角色到不了那个页面时渲染「由管理员完成」，不渲染死链——
//      viewer / billing 点不动的步骤也不该把清单永远钉在页面上。
import { ArrowRight, Check } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useOnboardingState } from '@/lib/onboarding';
import { GAP, INSET_BLOCK } from '@/lib/surface';
import { BODY_TEXT, HINT_TEXT } from '@/lib/typography';

export function OnboardingChecklist() {
  const { loading, complete, steps } = useOnboardingState();

  // 加载中也不占位：清单是提示不是内容，闪一下骨架比不显示更吵。
  if (loading || complete) return null;

  return (
    <div style={{ ...INSET_BLOCK, display: 'flex', flexDirection: 'column', gap: GAP.tight }}>
      {steps.map((step) => (
        <div key={step.id} style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, minHeight: 26 }}>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              width: 16,
              height: 16,
              borderRadius: 999,
              border: `1px solid ${step.done ? 'transparent' : 'var(--border-subtle)'}`,
              background: step.done ? 'var(--ok)' : 'transparent',
              color: 'var(--accent-contrast)',
            }}
          >
            {step.done ? <Check size={11} strokeWidth={3} /> : null}
          </span>
          <span
            style={{
              ...BODY_TEXT,
              flex: 1,
              minWidth: 0,
              color: step.done ? 'var(--text-muted)' : 'var(--text-primary)',
              textDecoration: step.done ? 'line-through' : 'none',
            }}
          >
            {step.label}
          </span>
          {step.done ? null : step.actionable ? (
            <Link className="lg-secondary-link" to={step.to}>去完成 <ArrowRight size={13} /></Link>
          ) : (
            <span style={HINT_TEXT}>由管理员完成</span>
          )}
        </div>
      ))}
    </div>
  );
}
