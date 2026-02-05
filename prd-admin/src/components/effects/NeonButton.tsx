import React from 'react';

/**
 * 霓虹灯按钮 - 基于 thirdparty/ref/下一步.html
 * 玻璃态按钮，悬停时有霓虹光晕效果
 */

type NeonColor = 'pink' | 'blue' | 'green';

interface NeonButtonProps {
  text?: string;
  color?: NeonColor;
  onClick?: () => void;
  className?: string;
}

const NEON_COLORS: Record<NeonColor, string> = {
  pink: '#ff1f71',
  blue: '#2db2ff',
  green: '#1eff45',
};

export function NeonButton({ text = 'Next Step', color = 'pink', onClick, className }: NeonButtonProps) {
  const neonColor = NEON_COLORS[color];

  return (
    <>
      <style>{`
        .neon-btn {
          position: relative;
          width: 200px;
          height: 50px;
          display: flex;
          justify-content: center;
          align-items: center;
        }
        .neon-btn a, .neon-btn button {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          display: flex;
          justify-content: center;
          align-items: center;
          background: rgba(255, 255, 255, 0.05);
          box-shadow: 0 15px 15px rgba(0, 0, 0, 0.3);
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          border-top: 1px solid rgba(255, 255, 255, 0.1);
          border-left: none;
          border-right: none;
          border-radius: 30px;
          padding: 10px;
          letter-spacing: 1px;
          text-decoration: none;
          overflow: hidden;
          color: #fff;
          font-weight: 400;
          font-size: 14px;
          z-index: 1;
          transition: 0.5s;
          backdrop-filter: blur(15px);
          cursor: pointer;
        }
        .neon-btn:hover a,
        .neon-btn:hover button {
          letter-spacing: 3px;
        }
        .neon-btn a::before,
        .neon-btn button::before {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          width: 50%;
          height: 100%;
          background: linear-gradient(to left, rgba(255, 255, 255, 0.15), transparent);
          transform: skewX(45deg) translate(0);
          transition: 0.5s;
          filter: blur(0px);
        }
        .neon-btn:hover a::before,
        .neon-btn:hover button::before {
          transform: skewX(45deg) translate(200px);
        }
        .neon-btn::before {
          content: "";
          position: absolute;
          left: 50%;
          transform: translateX(-50%);
          bottom: -5px;
          width: 30px;
          height: 10px;
          border-radius: 10px;
          transition: 0.5s;
          transition-delay: 0s;
        }
        .neon-btn:hover::before {
          bottom: 0;
          height: 50%;
          width: 80%;
          border-radius: 30px;
        }
        .neon-btn::after {
          content: "";
          position: absolute;
          left: 50%;
          transform: translateX(-50%);
          top: -5px;
          width: 30px;
          height: 10px;
          border-radius: 10px;
          transition: 0.5s;
          transition-delay: 0s;
        }
        .neon-btn:hover::after {
          top: 0;
          height: 50%;
          width: 80%;
          border-radius: 30px;
        }
      `}</style>
      <div
        className={`neon-btn ${className || ''}`}
        style={{
          // @ts-ignore CSS custom properties
          '--neon-color': neonColor,
        }}
      >
        <style>{`
          .neon-btn[style*="--neon-color"]::before,
          .neon-btn[style*="--neon-color"]::after {
            background: var(--neon-color);
            box-shadow: 0 0 5px var(--neon-color),
                        0 0 15px var(--neon-color),
                        0 0 30px var(--neon-color),
                        0 0 60px var(--neon-color);
          }
        `}</style>
        <button onClick={onClick}>{text}</button>
      </div>
    </>
  );
}

/** 多个霓虹按钮展示 */
export function NeonButtonGroup() {
  return (
    <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', justifyContent: 'center' }}>
      <NeonButton text="Next Step" color="pink" />
      <NeonButton text="Continue" color="blue" />
      <NeonButton text="Proceed" color="green" />
    </div>
  );
}
