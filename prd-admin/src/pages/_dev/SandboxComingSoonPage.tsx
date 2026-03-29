import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/design/Button';

const featureList = [
  '角色建模：总部、经销商、门店、业务员、导购员、消费者',
  '标识建模：物流码、营销二维码的分层关系可视化',
  '关系演示：出货、退货、调拨、扫码链路一图呈现',
];

const sceneList = [
  '渠道培训演示：把抽象流程讲清楚',
  '流程评审对齐：评审会现场快速对齐上下游认知',
  '异常链路复盘：窜货、漏扫、错配问题可视化还原',
];

export default function SandboxComingSoonPage() {
  const navigate = useNavigate();

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'radial-gradient(circle at 20% 0%, rgba(91,124,255,0.18), transparent 42%), #060d1d',
        color: '#e9f2ff',
        display: 'grid',
        placeItems: 'center',
        padding: 18,
      }}
    >
      <div
        style={{
          width: 'min(980px, 100%)',
          borderRadius: 18,
          border: '1px solid rgba(120,148,206,0.34)',
          background: 'rgba(7,14,30,0.82)',
          boxShadow: '0 20px 80px rgba(2,8,22,0.45)',
          padding: 24,
          display: 'grid',
          gap: 16,
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            width: 'fit-content',
            alignItems: 'center',
            gap: 8,
            borderRadius: 999,
            border: '1px solid rgba(255,206,116,0.45)',
            background: 'rgba(255,206,116,0.14)',
            color: '#ffe8b4',
            fontSize: 12,
            fontWeight: 700,
            padding: '4px 10px',
          }}
        >
          施工中
        </div>

        <div>
          <div style={{ fontSize: 28, fontWeight: 800, marginBottom: 8 }}>沙盘智能体还在施工中……敬请期待！</div>
          <div style={{ fontSize: 14, lineHeight: 1.8, color: 'rgba(214,228,255,0.88)' }}>
            我们正在把“看得见、摸得着、拖得动”的业务沙盘能力做成智能体。它会帮助你把
            <b> 角色-标识-动作</b> 关系拖拽成图，快速演示复杂业务链路，并用于评审和复盘。
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div
            style={{
              borderRadius: 12,
              border: '1px solid rgba(120,148,206,0.28)',
              background: 'rgba(10,20,42,0.66)',
              padding: 12,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: '#a7c6ff' }}>即将支持的能力</div>
            <div style={{ display: 'grid', gap: 8 }}>
              {featureList.map((item) => (
                <div key={item} style={{ fontSize: 12, color: 'rgba(221,235,255,0.88)', lineHeight: 1.7 }}>
                  • {item}
                </div>
              ))}
            </div>
          </div>

          <div
            style={{
              borderRadius: 12,
              border: '1px solid rgba(120,148,206,0.28)',
              background: 'rgba(10,20,42,0.66)',
              padding: 12,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: '#a7c6ff' }}>适用场景</div>
            <div style={{ display: 'grid', gap: 8 }}>
              {sceneList.map((item) => (
                <div key={item} style={{ fontSize: 12, color: 'rgba(221,235,255,0.88)', lineHeight: 1.7 }}>
                  • {item}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div
          style={{
            borderRadius: 12,
            border: '1px dashed rgba(120,148,206,0.45)',
            background: 'rgba(12,24,50,0.55)',
            padding: 12,
          }}
        >
          <div style={{ fontSize: 12, color: '#9fc2ff', marginBottom: 8, fontWeight: 700 }}>当前进度</div>
          <div style={{ display: 'grid', gap: 6, fontSize: 12, color: 'rgba(223,236,255,0.9)' }}>
            <div>已完成：基础画布与核心交互原型</div>
            <div>施工中：规则校验、模板化场景、协作能力</div>
            <div>即将开放：内测预约与上线通知</div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Button variant="primary" size="sm" className="whitespace-nowrap shrink-0">
            预约内测
          </Button>
          <Button variant="secondary" size="sm" className="whitespace-nowrap shrink-0">
            获取上线通知
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="whitespace-nowrap shrink-0"
            onClick={() => navigate('/_dev/sandbox-demo')}
          >
            查看当前演示原型
          </Button>
        </div>
      </div>
    </div>
  );
}

