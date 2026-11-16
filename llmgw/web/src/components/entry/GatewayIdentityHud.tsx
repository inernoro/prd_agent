import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';

const ROLES: Record<string, string> = { owner: '所有者', admin: '管理员', developer: '开发者', member: '成员', viewer: '只读成员' };
export function GatewayIdentityHud() {
  const { user, tenant } = useAuth();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') setNow(new Date()); }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <aside className="gateway-workspace-hud" aria-label="当前工作空间">
    <div className="gateway-identity-card">
      <span className="gateway-identity-caption"><i />IDENTITY CONFIRMED</span>
      <strong>{user?.displayName || user?.username || '你的模型空间'}</strong>
      <span className="gateway-identity-meta">{tenant?.name || '模型网关'}<b />{ROLES[tenant?.role || ''] || tenant?.role || '已登录'}</span>
      <p>让想法，连接每一种智能。</p>
    </div>
    <div className="gateway-edge-index" aria-hidden="true">DESCRIBE<br />CONNECT<br />CREATE<i /></div>
    <div className="gateway-session-caption" aria-hidden="true"><span>YOUR MODEL WORKSPACE</span><time dateTime={now.toISOString()}>{now.toLocaleTimeString('zh-CN', { hour12: false })}</time><i /></div>
    <div className="gateway-workspace-coordinate" aria-hidden="true">LLM / GATEWAY<span>IDEA INTO REALITY</span></div>
  </aside>;
}
