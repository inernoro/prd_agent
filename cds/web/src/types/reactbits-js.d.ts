declare module '@/components/effects/reactbits/FloatingLines' {
  import type { ComponentType } from 'react';

  const FloatingLines: ComponentType<Record<string, unknown>>;
  export default FloatingLines;
}

declare module '@/components/effects/reactbits/Hyperspeed' {
  import type { ComponentType } from 'react';

  const Hyperspeed: ComponentType<{ effectOptions?: Record<string, unknown> }>;
  export default Hyperspeed;
}

declare module '@/components/effects/reactbits/HyperspeedPresets' {
  export const hyperspeedPresets: Record<string, Record<string, unknown>>;
}
