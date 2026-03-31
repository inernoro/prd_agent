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
        background:
          'radial-gradient(circle at 16% -10%, rgba(139,92,246,0.35), transparent 40%), radial-gradient(circle at 90% 0%, rgba(59,130,246,0.28), transparent 35%), #060d1d',
        color: '#e9f2ff',
        display: 'grid',
        placeItems: 'center',
        padding: 18,
      }}
    >
      <style>
        {`
          @keyframes heroFloat {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-6px); }
          }
          @keyframes catShellBreath {
            0%, 100% { transform: scale(1); box-shadow: 0 18px 40px rgba(4,10,24,0.42); }
            50% { transform: scale(1.02); box-shadow: 0 22px 48px rgba(40,120,255,0.22); }
          }
          @keyframes catGlowBreath {
            0%, 100% { opacity: 0.34; transform: scale(1); }
            50% { opacity: 0.58; transform: scale(1.06); }
          }
          @keyframes pulseHint {
            0%, 100% { box-shadow: 0 0 0 0 rgba(255, 209, 95, 0.28); }
            50% { box-shadow: 0 0 0 10px rgba(255, 209, 95, 0.0); }
          }
          @keyframes haloPulse {
            0%, 100% { opacity: 0.28; transform: scale(1); }
            50% { opacity: 0.52; transform: scale(1.06); }
          }
          @keyframes progressMove {
            0% { background-position: 0 0; }
            100% { background-position: 36px 0; }
          }
          @keyframes sparkleDrift {
            0%, 100% { opacity: 0.35; transform: translateY(0) scale(0.95); }
            50% { opacity: 1; transform: translateY(-4px) scale(1.06); }
          }
        `}
      </style>
      <div
        style={{
          width: 'min(980px, 100%)',
          borderRadius: 18,
          border: '1px solid rgba(166,191,255,0.35)',
          background: 'linear-gradient(180deg, rgba(12,20,40,0.92), rgba(8,14,30,0.9))',
          boxShadow: '0 20px 80px rgba(2,8,22,0.45), inset 0 1px 0 rgba(255,255,255,0.05)',
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
            border: '1px solid rgba(255,206,116,0.65)',
            background: 'linear-gradient(90deg, rgba(255,206,116,0.22), rgba(255,138,102,0.18))',
            color: '#fff1c7',
            fontSize: 12,
            fontWeight: 700,
            padding: '4px 10px',
            animation: 'pulseHint 1.8s ease-in-out infinite',
          }}
        >
          预热中
        </div>

        <div>
          <div style={{ fontSize: 28, fontWeight: 800, marginBottom: 8 }}>沙盘智能体还在施工中……敬请期待！</div>
          <div style={{ fontSize: 14, lineHeight: 1.8, color: 'rgba(214,228,255,0.88)' }}>
            我们正在把“看得见、摸得着、拖得动”的业务沙盘能力做成智能体。它会帮助你把
            <b> 角色-标识-动作</b> 关系拖拽成图，快速演示复杂业务链路，并用于评审和复盘。
          </div>
        </div>

        <div
          style={{
            borderRadius: 12,
            border: '1px solid rgba(120,148,206,0.34)',
            background: 'rgba(10,20,42,0.75)',
            padding: '20px 16px 14px',
          }}
        >
          <div
            style={{
              position: 'relative',
              width: '100%',
              maxWidth: 720,
              margin: '0 auto',
              textAlign: 'center',
            }}
          >
            <div
              style={{
                position: 'relative',
                width: 360,
                height: 260,
                margin: '0 auto',
                animation: 'heroFloat 2.2s ease-in-out infinite',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  borderRadius: '50%',
                  background: 'radial-gradient(circle at 50% 55%, rgba(138,176,255,0.26), rgba(69,112,214,0.05) 65%, transparent 78%)',
                  animation: 'haloPulse 2.2s ease-in-out infinite',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'grid',
                  placeItems: 'center',
                }}
              >
                <div
                  style={{
                    width: 236,
                    height: 236,
                    borderRadius: 32,
                    border: '1px solid rgba(147,176,255,0.45)',
                    background: 'linear-gradient(180deg, rgba(19,35,72,0.72), rgba(11,24,52,0.78))',
                    backdropFilter: 'blur(4px)',
                    WebkitBackdropFilter: 'blur(4px)',
                    display: 'grid',
                    placeItems: 'center',
                    position: 'relative',
                    animation: 'catShellBreath 2.6s ease-in-out infinite',
                    overflow: 'hidden',
                    boxShadow: '0 10px 26px rgba(12,24,52,0.42), inset 0 1px 0 rgba(255,255,255,0.16)',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      inset: -18,
                      borderRadius: 40,
                      background: 'radial-gradient(circle at 50% 45%, rgba(120,167,255,0.28), transparent 62%)',
                      animation: 'catGlowBreath 2.6s ease-in-out infinite',
                      pointerEvents: 'none',
                    }}
                  />
                  <img
                    src="/images/sandbox-cat.gif"
                    alt="施工中小猫"
                    style={{
                      width: 212,
                      height: 212,
                      objectFit: 'contain',
                      position: 'relative',
                      zIndex: 1,
                      filter:
                        'drop-shadow(0 10px 24px rgba(2,8,22,0.3)) drop-shadow(0 0 10px rgba(131,167,255,0.22))',
                    }}
                  />
                </div>
              </div>

              <div
                style={{
                  position: 'absolute',
                  right: 56,
                  top: 42,
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  background: '#ffd66f',
                  animation: 'sparkleDrift 1.1s ease-in-out infinite',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  right: 38,
                  top: 70,
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: '#9ec0ff',
                  animation: 'sparkleDrift 1.1s ease-in-out infinite',
                  animationDelay: '0.25s',
                }}
              />
            </div>

            <div
              style={{
                display: 'inline-block',
                borderRadius: 8,
                border: '1px solid rgba(120,148,206,0.36)',
                background: 'rgba(15,28,56,0.85)',
                padding: '7px 11px',
                fontSize: 13,
                fontWeight: 700,
                color: '#dfeaff',
                marginBottom: 8,
              }}
            >
              施工总监小喵：正在全力施工中
            </div>
            <div
              style={{
                height: 12,
                borderRadius: 999,
                border: '1px solid rgba(120,148,206,0.35)',
                background:
                  'repeating-linear-gradient(45deg, rgba(255,209,95,0.36) 0, rgba(255,209,95,0.36) 10px, rgba(255,138,102,0.36) 10px, rgba(255,138,102,0.36) 20px)',
                backgroundSize: '36px 36px',
                animation: 'progressMove 1.1s linear infinite',
                marginBottom: 8,
              }}
            />
            <div style={{ fontSize: 12, color: 'rgba(214,228,255,0.9)' }}>
              当前施工重点：规则校验、模板场景、团队协作与分享能力。
            </div>
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

