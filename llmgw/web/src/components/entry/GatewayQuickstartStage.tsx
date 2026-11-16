import { useEffect, useState, type ReactNode } from 'react';
import { ConsciousnessScene } from './ConsciousnessScene';
import { consumeQuickstartArrival, hasQuickstartArrival } from './quickstartArrival';
import '../../pages/GatewayEntry.css';

/** One backdrop covers the entire Quickstart viewport, behind its transparent page shell. */
export function GatewayQuickstartStage({ children }: { children: ReactNode }) {
  const [arriving] = useState(hasQuickstartArrival);
  useEffect(() => { if (arriving) consumeQuickstartArrival(); }, [arriving]);
  return <section className={`gateway-entry gateway-quickstart-stage consciousness-home${arriving ? ' is-arriving' : ''}`} aria-label="Quickstart 工作空间">
    <ConsciousnessScene arriving={arriving} />
    <div className="gateway-quickstart-shade" aria-hidden="true" />
    {children}
  </section>;
}
