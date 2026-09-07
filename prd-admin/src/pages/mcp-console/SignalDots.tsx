import { capabilityVisual } from './capabilityRegistry';
import { tierLabel, type CapabilityTier } from './signalEncoding';

/**
 * 一块能力 = 一个点。
 *
 * **三档必须靠形状分得开，不能只靠颜色。** 实心 / 圆环 / 虚线圈是三种不同的形状，
 * 把整屏调成灰度也读得出来；颜色只承担「这是哪一块能力」，而那一层另有两道冗余：
 * 每个点自带可读名字（读屏与长按都拿得到），点一下还能展开逐块的文字清单。
 *
 * 这条是这个方向落地时最该守住的一处 —— 设计稿上写明了它的代价是
 * 「色点要学一次才认得，且对色觉障碍不友好」，所以颜色一律不做唯一通道。
 */
export function CapabilityDot({
  capKey,
  title,
  tier,
}: {
  capKey: string;
  title: string;
  tier: CapabilityTier;
}) {
  // 按 **key** 查视觉登记表。按 title 查会全部落到兜底中性色，
  // 五个点长得一模一样 —— 颜色这一路通道当场作废，而界面照常渲染、测试照常绿。
  const color = capabilityVisual(capKey).text;
  const label = `${title} · ${tierLabel(tier)}`;
  const base = 'block h-[11px] w-[11px] shrink-0 rounded-full';

  if (tier === 'write' || tier === 'full') {
    // 实心 = 这把钥匙对这块能力拿满了。「能写」与「已开」形状相同，说法由 tierLabel 分开：
    // 只有读档的能力拿满了也不能写，不能因为形状一样就说成一样。
    return <span role="img" aria-label={label} title={label} className={base} style={{ background: color }} />;
  }
  if (tier === 'read') {
    // 圆环：中心透空 —— 与实心是两种形状，不是同一形状的两种深浅
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className={base}
        style={{ border: `2px solid ${color}`, background: 'transparent' }}
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={base}
      style={{ border: '1px dashed var(--border-default)', background: 'transparent' }}
    />
  );
}

/**
 * 图例 —— 整屏只出现这一次。
 *
 * 它替代的是原来每张客户端卡上重复一遍的那两三句解释：那些话每张卡说一次，
 * 两台客户端就是两遍、五台就是五遍，而它们讲的是同一件常识。
 * 常识讲一次就够，每把钥匙自己的例外才值得占卡片上的位置。
 */
export function SignalLegend() {
  return (
    <div
      className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 rounded-[11px] px-3 py-2"
      style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border-subtle)' }}
    >
      <span className="text-[10.5px]" style={{ color: 'var(--text-disabled)' }}>
        能力
      </span>
      <LegendItem label="能写 / 已开">
        <span className="block h-[9px] w-[9px] rounded-full" style={{ background: 'var(--text-secondary)' }} />
      </LegendItem>
      <LegendItem label="只能看">
        <span
          className="block h-[9px] w-[9px] rounded-full"
          style={{ border: '2px solid var(--text-secondary)' }}
        />
      </LegendItem>
      <LegendItem label="未开">
        <span
          className="block h-[9px] w-[9px] rounded-full"
          style={{ border: '1px dashed var(--border-default)' }}
        />
      </LegendItem>
      <LegendItem label="手动钉死">
        <span className="block h-[11px] w-[3px] rounded-sm" style={{ background: 'var(--accent-primary)' }} />
      </LegendItem>
    </div>
  );
}

function LegendItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
      {children}
      {label}
    </span>
  );
}
