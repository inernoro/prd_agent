import { useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';

export interface LogoAnimationProps {
  logoText: string;
  primaryColor: string;
  secondaryColor: string;
  backgroundColor: string;
}

export const LogoAnimation: React.FC<LogoAnimationProps> = ({
  logoText,
  primaryColor,
  secondaryColor,
  backgroundColor,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // Circle animation
  const circleScale = spring({
    frame,
    fps,
    config: { damping: 15, stiffness: 100 },
  });

  const circleRotation = interpolate(frame, [0, 90], [0, 360]);

  // Text animation
  const textOpacity = interpolate(frame, [20, 40], [0, 1], {
    extrapolateRight: 'clamp',
  });

  const textY = spring({
    frame: frame - 20,
    fps,
    config: { damping: 12, stiffness: 180 },
  });

  // Glow effect
  const glowIntensity = interpolate(
    frame,
    [0, 30, 60, 90],
    [0, 20, 15, 20],
  );

  return (
    <div
      style={{
        width,
        height,
        backgroundColor,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 30,
      }}
    >
      {/* Animated circles */}
      <div style={{ position: 'relative', width: 150, height: 150 }}>
        <div
          style={{
            position: 'absolute',
            width: 150,
            height: 150,
            borderRadius: '50%',
            border: `4px solid ${primaryColor}`,
            transform: `scale(${circleScale}) rotate(${circleRotation}deg)`,
            boxShadow: `0 0 ${glowIntensity}px ${primaryColor}`,
          }}
        />
        <div
          style={{
            position: 'absolute',
            width: 100,
            height: 100,
            top: 25,
            left: 25,
            borderRadius: '50%',
            border: `4px solid ${secondaryColor}`,
            transform: `scale(${circleScale}) rotate(${-circleRotation}deg)`,
            boxShadow: `0 0 ${glowIntensity * 0.7}px ${secondaryColor}`,
          }}
        />
        <div
          style={{
            position: 'absolute',
            width: 50,
            height: 50,
            top: 50,
            left: 50,
            borderRadius: '50%',
            backgroundColor: primaryColor,
            transform: `scale(${circleScale})`,
            boxShadow: `0 0 ${glowIntensity * 1.5}px ${primaryColor}`,
          }}
        />
      </div>

      {/* Logo text */}
      <div
        style={{
          fontSize: 48,
          fontWeight: 800,
          fontFamily: 'system-ui, sans-serif',
          color: primaryColor,
          opacity: textOpacity,
          transform: `translateY(${(1 - textY) * 20}px)`,
          textShadow: `0 0 ${glowIntensity}px ${primaryColor}`,
          letterSpacing: 4,
        }}
      >
        {logoText}
      </div>
    </div>
  );
};

export const logoAnimationDefaults: LogoAnimationProps = {
  logoText: 'PRD AGENT',
  primaryColor: '#3b82f6',
  secondaryColor: '#8b5cf6',
  backgroundColor: '#0f0f1a',
};
