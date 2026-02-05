import React from 'react';

/**
 * 发光边框卡片 - 基于 thirdparty/ref/特效卡片.html
 * 带有彩色流动边框和悬停光晕效果
 */

interface GlowingCardProps {
  title?: string;
  label?: string;
  className?: string;
  children?: React.ReactNode;
}

export function GlowingCard({ title = 'Glowing shadows', label = 'cool', className, children }: GlowingCardProps) {
  return (
    <>
      <style>{`
        @property --glow-hue {
          syntax: "<number>";
          inherits: true;
          initial-value: 0;
        }
        @property --glow-rotate {
          syntax: "<number>";
          inherits: true;
          initial-value: 0;
        }
        @property --glow-bg-y {
          syntax: "<number>";
          inherits: true;
          initial-value: 0;
        }
        @property --glow-bg-x {
          syntax: "<number>";
          inherits: true;
          initial-value: 0;
        }
        .glowing-card-wrapper {
          --card-color: hsl(260deg 100% 3%);
          --text-color: hsl(260deg 10% 55%);
          --card-radius: 24px;
          --border-width: 3px;
          --animation-speed: 4s;
          --glow-hue: 0;
          width: 100%;
          max-width: 320px;
          aspect-ratio: 1.5/1;
          color: white;
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          z-index: 2;
          border-radius: var(--card-radius);
          cursor: pointer;
        }
        .glowing-card-wrapper:hover .glowing-card-inner {
          mix-blend-mode: darken;
          --text-color: white;
          box-shadow: 0 0 1vw 0.15vw rgba(255, 255, 255, 0.2);
        }
        .glowing-card-wrapper:hover .glowing-card-inner:before {
          --glow-bg-size: 15;
          animation-play-state: paused;
        }
        .glowing-card-wrapper:hover .glow-spot {
          --glow-blur: 1.5;
          --glow-opacity: 0.6;
          --glow-scale: 2.5;
          animation-play-state: paused;
        }
        .glowing-card-inner {
          position: absolute;
          width: 100%;
          height: 100%;
          background: var(--card-color);
          border-radius: calc(var(--card-radius) * 0.9);
          display: flex;
          align-items: center;
          justify-content: center;
          flex-direction: column;
          gap: 8px;
          font-weight: 800;
          text-transform: uppercase;
          font-size: 14px;
          color: var(--text-color);
          padding: 24px;
          transition: box-shadow 0.3s;
        }
        .glowing-card-inner:before {
          content: "";
          display: block;
          position: absolute;
          width: calc(100% + var(--border-width));
          height: calc(100% + var(--border-width));
          border-radius: calc(var(--card-radius) * 0.9);
          box-shadow: 0 0 20px black;
          mix-blend-mode: color-burn;
          z-index: -1;
          background: #292929 radial-gradient(
            30% 30% at calc(var(--glow-bg-x) * 1%) calc(var(--glow-bg-y) * 1%),
            hsl(calc(var(--glow-hue) * 1deg), 100%, 90%) 0%,
            hsl(calc(var(--glow-hue) * 1deg), 100%, 80%) 20%,
            hsl(calc(var(--glow-hue) * 1deg), 100%, 60%) 40%,
            transparent 100%
          );
          animation: glow-hue-anim var(--animation-speed) linear infinite,
                     glow-rotate-bg var(--animation-speed) linear infinite;
        }
        .glowing-card-inner .label {
          display: inline-block;
          padding: 0.25em 0.5em;
          border-radius: 4px;
          background: var(--text-color);
          color: black;
          font-weight: 900;
          font-size: 12px;
        }
        .glow-spot {
          --glow-blur: 6;
          --glow-opacity: 1;
          --glow-scale: 1.5;
          display: block;
          position: absolute;
          width: 60px;
          height: 60px;
          animation: glow-rotate var(--animation-speed) linear infinite;
          transform: rotateZ(calc(var(--glow-rotate) * 1deg));
          transform-origin: center;
          border-radius: 1000px;
        }
        .glow-spot:after {
          content: "";
          display: block;
          z-index: -2;
          filter: blur(calc(var(--glow-blur) * 10px));
          width: 130%;
          height: 130%;
          left: -15%;
          top: -15%;
          background: hsl(calc(var(--glow-hue) * 1deg), 100%, 60%);
          position: relative;
          border-radius: 1000px;
          animation: glow-hue-anim var(--animation-speed) linear infinite;
          transform: scaleY(calc(var(--glow-scale) / 1.1)) scaleX(calc(var(--glow-scale) * 1.2)) translateY(-65%);
          opacity: var(--glow-opacity);
          transition: filter 0.05s, opacity 0.05s, transform 0.05s;
        }
        @keyframes glow-hue-anim {
          0% { --glow-hue: 0; }
          100% { --glow-hue: 360; }
        }
        @keyframes glow-rotate-bg {
          0% { --glow-bg-x: 0; --glow-bg-y: 0; }
          25% { --glow-bg-x: 100; --glow-bg-y: 0; }
          50% { --glow-bg-x: 100; --glow-bg-y: 100; }
          75% { --glow-bg-x: 0; --glow-bg-y: 100; }
          100% { --glow-bg-x: 0; --glow-bg-y: 0; }
        }
        @keyframes glow-rotate {
          from { --glow-rotate: -70; }
          to { --glow-rotate: 290; }
        }
      `}</style>
      <div className={`glowing-card-wrapper ${className || ''}`} role="button">
        <span className="glow-spot"></span>
        <div className="glowing-card-inner">
          {children || (
            <>
              {label && <span className="label">{label}</span>}
              {title}
            </>
          )}
        </div>
      </div>
    </>
  );
}
