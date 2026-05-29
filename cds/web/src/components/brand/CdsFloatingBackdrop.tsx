import { memo } from 'react';
import FloatingLines from '@/components/effects/reactbits/FloatingLines';

const floatingLineGradient = ['#E947F5', '#2F4BA2', '#FFFFFF'];
const enabledWaves = ['top', 'middle', 'bottom'];
const lineCount = [10, 15, 20];
const lineDistance = [8, 6, 4];

export const CdsFloatingBackdrop = memo(function CdsFloatingBackdrop(): JSX.Element {
  return (
    <div className="cds-floating-lines-demo pointer-events-none absolute inset-0">
      <FloatingLines
        linesGradient={floatingLineGradient}
        enabledWaves={enabledWaves}
        lineCount={lineCount}
        lineDistance={lineDistance}
        interactive
        parallax
        parallaxStrength={0.2}
        animationSpeed={1}
        bendRadius={5.0}
        bendStrength={-0.5}
        mouseDamping={0.05}
        mixBlendMode="screen"
      />
    </div>
  );
});
