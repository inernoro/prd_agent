import { useEffect, useState } from 'react';

export function GatewayIdentityHud() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') setNow(new Date()); }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <aside className="gateway-workspace-hud" aria-label="当前工作空间">
    <div className="gateway-edge-index" aria-hidden="true">DESCRIBE<br />CONNECT<br />CREATE<i /></div>
    <div className="gateway-session-caption" aria-hidden="true"><span>YOUR MODEL WORKSPACE</span><time dateTime={now.toISOString()}>{now.toLocaleTimeString('zh-CN', { hour12: false })}</time><i /></div>
    <div className="gateway-workspace-coordinate" aria-hidden="true">LLM / GATEWAY<span>IDEA INTO REALITY</span></div>
  </aside>;
}
