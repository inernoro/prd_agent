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
          @keyframes pulseHint {
            0%, 100% { box-shadow: 0 0 0 0 rgba(255, 209, 95, 0.28); }
            50% { box-shadow: 0 0 0 10px rgba(255, 209, 95, 0.0); }
          }
          @keyframes haloPulse {
            0%, 100% { opacity: 0.28; transform: scale(1); }
            50% { opacity: 0.52; transform: scale(1.06); }
          }
          @keyframes catBlink {
            0%, 44%, 48%, 100% { transform: scaleY(1); }
            46% { transform: scaleY(0.08); }
          }
          @keyframes tailSwing {
            0%, 100% { transform: rotate(10deg); }
            50% { transform: rotate(-10deg); }
          }
          @keyframes leftArmWave {
            0%, 100% { transform: rotate(6deg); }
            50% { transform: rotate(-9deg); }
          }
          @keyframes rightArmWave {
            0%, 100% { transform: rotate(-6deg); }
            50% { transform: rotate(9deg); }
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
                width: 320,
                height: 250,
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
              <svg viewBox="0 0 320 250" style={{ width: '100%', height: '100%', filter: 'drop-shadow(0 10px 24px rgba(2,8,22,0.36))' }}>
                <ellipse cx="160" cy="222" rx="78" ry="13" fill="rgba(113,148,228,0.22)" />

                <g style={{ transformOrigin: '218px 170px', animation: 'tailSwing 1.9s ease-in-out infinite' }}>
                  <path d="M212 168 C238 172 242 198 220 206" stroke="#24365f" strokeWidth="6" strokeLinecap="round" fill="none" />
                </g>

                <g style={{ transformOrigin: '114px 132px', animation: 'leftArmWave 1.6s ease-in-out infinite' }}>
                  <path d="M120 136 C108 118 98 102 86 88" stroke="#24365f" strokeWidth="6" strokeLinecap="round" fill="none" />
                  <ellipse cx="82" cy="81" rx="15" ry="12" fill="#f7fbff" stroke="#24365f" strokeWidth="4" />
                  <line x1="77" y1="78" x2="82" y2="83" stroke="#24365f" strokeWidth="2.5" strokeLinecap="round" />
                  <line x1="82" y1="78" x2="77" y2="83" stroke="#24365f" strokeWidth="2.5" strokeLinecap="round" />
                </g>

                <g style={{ transformOrigin: '206px 132px', animation: 'rightArmWave 1.6s ease-in-out infinite' }}>
                  <path d="M200 136 C212 118 222 102 234 88" stroke="#24365f" strokeWidth="6" strokeLinecap="round" fill="none" />
                  <ellipse cx="238" cy="81" rx="15" ry="12" fill="#f7fbff" stroke="#24365f" strokeWidth="4" />
                  <line x1="233" y1="78" x2="238" y2="83" stroke="#24365f" strokeWidth="2.5" strokeLinecap="round" />
                  <line x1="238" y1="78" x2="233" y2="83" stroke="#24365f" strokeWidth="2.5" strokeLinecap="round" />
                </g>

                <path
                  d="M160 206 C118 206 97 175 102 138 C106 109 125 92 160 91 C195 92 214 109 218 138 C223 175 202 206 160 206 Z"
                  fill="#f7fbff"
                  stroke="#24365f"
                  strokeWidth="4"
                />
                <ellipse cx="160" cy="170" rx="28" ry="22" fill="#edf4ff" />

                <circle cx="160" cy="103" r="42" fill="#f7fbff" stroke="#24365f" strokeWidth="4" />
                <path d="M132 74 L120 48 L144 68 Z" fill="#f7fbff" stroke="#24365f" strokeWidth="4" />
                <path d="M188 74 L200 48 L176 68 Z" fill="#f7fbff" stroke="#24365f" strokeWidth="4" />

                <path d="M133 72 L125 57 L141 67 Z" fill="#ffd7df" />
                <path d="M187 72 L195 57 L179 67 Z" fill="#ffd7df" />

                <g style={{ transformOrigin: '147px 103px', animation: 'catBlink 3.2s ease-in-out infinite' }}>
                  <line x1="141" y1="103" x2="151" y2="103" stroke="#24365f" strokeWidth="4" strokeLinecap="round" />
                </g>
                <g style={{ transformOrigin: '173px 103px', animation: 'catBlink 3.2s ease-in-out infinite' }}>
                  <line x1="167" y1="103" x2="177" y2="103" stroke="#24365f" strokeWidth="4" strokeLinecap="round" />
                </g>

                <circle cx="142" cy="112" r="4" fill="#ffd4de" />
                <circle cx="178" cy="112" r="4" fill="#ffd4de" />

                <path d="M160 110 L155 116 L165 116 Z" fill="#ff8fa5" stroke="#24365f" strokeWidth="2.5" strokeLinejoin="round" />
                <path d="M160 116 C154 123 148 123 144 118" stroke="#24365f" strokeWidth="3" strokeLinecap="round" fill="none" />
                <path d="M160 116 C166 123 172 123 176 118" stroke="#24365f" strokeWidth="3" strokeLinecap="round" fill="none" />

                <path d="M115 96 C102 96 92 98 85 104" stroke="#24365f" strokeWidth="3" strokeLinecap="round" fill="none" />
                <path d="M205 96 C218 96 228 98 235 104" stroke="#24365f" strokeWidth="3" strokeLinecap="round" fill="none" />

                <path d="M128 66 C132 48 146 38 160 38 C174 38 188 48 192 66 Z" fill="#ffd66f" stroke="#24365f" strokeWidth="4" />
                <rect x="124" y="64" width="72" height="14" rx="7" fill="#ffd66f" stroke="#24365f" strokeWidth="4" />
                <rect x="151" y="32" width="18" height="8" rx="4" fill="#ffd66f" stroke="#24365f" strokeWidth="4" />
                <path d="M126 72 C120 76 118 86 120 92" stroke="#24365f" strokeWidth="3" strokeLinecap="round" fill="none" />
                <path d="M194 72 C200 76 202 86 200 92" stroke="#24365f" strokeWidth="3" strokeLinecap="round" fill="none" />
              </svg>

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
              施工总监小喵：正在精修体验中
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

