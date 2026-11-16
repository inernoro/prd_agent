import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useEntryArrival } from './entryArrival';

const ROLES: Record<string, string> = { owner: '所有者', admin: '管理员', developer: '开发者', member: '成员', viewer: '只读成员' };
export function GatewayIdentityHud() {
  const { user, tenant } = useAuth();
  const arriving = useEntryArrival();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') setNow(new Date()); }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  const hour = now.getHours();
  const [greeting, verse] = hour >= 5 && hour < 11
    ? ['早上好', '晨光已至，新的灵感正待落笔。']
    : hour >= 11 && hour < 14
      ? ['午安', '日光正好，让灵感从这里生长。']
      : hour >= 14 && hour < 18
        ? ['下午好', '把片刻从容，留给正在发生的灵感。']
        : hour >= 18 && hour < 23
          ? ['晚上好', '灯火渐暖，愿今夜的灵感自有回响。']
          : ['夜深了', '夜色温柔，给未竟的想法一点光。'];
  const name = user?.displayName || user?.username;
  return <aside className="gateway-workspace-hud" aria-label="当前工作空间">
    <div className={`gateway-identity-card${arriving ? ' is-awaiting-welcome' : ' is-welcoming'}`}>
      <span className="gateway-identity-caption"><i />A MOMENT FOR INSPIRATION</span>
      <strong><span>{greeting}{name ? '，' : '。'}</span>{name && <span>{name}。</span>}</strong>
      <p>{verse}</p>
      <span className="gateway-identity-meta">{tenant?.name || '模型网关'}<b />{ROLES[tenant?.role || ''] || tenant?.role || '已登录'}</span>
    </div>
    <div className="gateway-edge-index" aria-hidden="true">DESCRIBE<br />CONNECT<br />CREATE<i /></div>
    <div className="gateway-session-caption" aria-hidden="true"><span>YOUR MODEL WORKSPACE</span><time dateTime={now.toISOString()}>{now.toLocaleTimeString('zh-CN', { hour12: false })}</time><i /></div>
    <div className="gateway-workspace-coordinate" aria-hidden="true">LLM / GATEWAY<span>IDEA INTO REALITY</span></div>
  </aside>;
}
