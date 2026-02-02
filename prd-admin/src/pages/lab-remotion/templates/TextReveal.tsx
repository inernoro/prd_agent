import { useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';

export interface TextRevealProps {
  text: string;
  color: string;
  backgroundColor: string;
  fontSize: number;
}

export const TextReveal: React.FC<TextRevealProps> = ({
  text,
  color,
  backgroundColor,
  fontSize,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const words = text.split(' ');

  return (
    <div
      style={{
        width,
        height,
        backgroundColor,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexWrap: 'wrap',
        gap: fontSize * 0.3,
        padding: fontSize,
      }}
    >
      {words.map((word, i) => {
        const delay = i * 5;
        const scale = spring({
          frame: frame - delay,
          fps,
          config: {
            damping: 12,
            stiffness: 200,
          },
        });

        const opacity = interpolate(
          frame - delay,
          [0, 10],
          [0, 1],
          { extrapolateRight: 'clamp' }
        );

        const y = interpolate(
          frame - delay,
          [0, 15],
          [30, 0],
          { extrapolateRight: 'clamp' }
        );

        return (
          <span
            key={i}
            style={{
              fontSize,
              fontWeight: 700,
              color,
              fontFamily: 'system-ui, sans-serif',
              transform: `scale(${scale}) translateY(${y}px)`,
              opacity,
              display: 'inline-block',
            }}
          >
            {word}
          </span>
        );
      })}
    </div>
  );
};

export const textRevealDefaults: TextRevealProps = {
  text: 'Hello Remotion World',
  color: '#ffffff',
  backgroundColor: '#1e1e2e',
  fontSize: 72,
};
