import { useCallback, useEffect, useState } from 'react';
import { Building2, Plus, RefreshCw, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createTeam, createTenant, getOrganization, setSession, switchTenant } from '@/lib/api';
import type { OrganizationData } from '@/lib/types';
import { Button, Chip, SectionLoader } from '@/components/ui';

export function OrganizationPage() {
  const [data, setData] = useState<OrganizationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tenantName, setTenantName] = useState('');
  const [tenantSlug, setTenantSlug] = useState('');
  const [teamName, setTeamName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const response = await getOrganization();
    if (response.success) setData(response.data);
    else setError(response.error.message);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const addTenant = async () => {
    setBusy(true);
    setError(null);
    const created = await createTenant({ name: tenantName.trim(), slug: tenantSlug.trim().toLowerCase() });
    if (!created.success) {
      setError(created.error.message);
      setBusy(false);
      return;
    }
    const switched = await switchTenant(created.data.id);
    setBusy(false);
    if (!switched.success) {
      setError(switched.error.message);
      return;
    }
    setSession(switched.data);
    window.location.reload();
  };

  const addTeam = async () => {
    setBusy(true);
    setError(null);
    const response = await createTeam({ name: teamName.trim() });
    setBusy(false);
    if (!response.success) {
      setError(response.error.message);
      return;
    }
    setTeamName('');
    await load();
  };

  return <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
    <div style={{ maxWidth: 1060, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Building2 size={18} /><h1 style={{ margin: 0, fontSize: 17 }}>组织与自助接入</h1><Button size="sm" variant="ghost" style={{ marginLeft: 'auto' }} onClick={() => void load()}><RefreshCw size={14} />刷新</Button></header>
      {error ? <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div> : null}
      {!data ? <SectionLoader text="正在加载组织" /> : <>
        <section style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><strong>{data.tenant?.name || '当前租户'}</strong><Chip label={data.tenant?.status || 'unknown'} color="#3fb950" bg="rgba(63,185,80,0.14)" /><code style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 11 }}>{data.tenant?.id}</code></div>
          <p style={hintStyle}>租户由服务端会话确定。请求体和自定义 tenantId header 都不能切换数据范围。</p>
        </section>
        <section className="lg-quickstart-detail-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div style={cardStyle}>
            <h2 style={headingStyle}><Plus size={14} />创建新租户</h2>
            <Field label="租户名称" value={tenantName} onChange={setTenantName} placeholder="Acme AI" />
            <Field label="Slug" value={tenantSlug} onChange={setTenantSlug} placeholder="acme-ai" />
            <Button variant="primary" disabled={busy || tenantName.trim().length < 2 || tenantSlug.trim().length < 2} onClick={() => void addTenant()}>创建并切换</Button>
          </div>
          <div style={cardStyle}>
            <h2 style={headingStyle}><Users size={14} />当前租户团队</h2>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>{data.teams.map((team) => <Chip key={team.id} label={`${team.name} · ${team.id}`} color="#58a6ff" bg="rgba(88,166,255,0.14)" />)}</div>
            <Field label="团队名称" value={teamName} onChange={setTeamName} placeholder="Platform Team" />
            <Button disabled={busy || teamName.trim().length < 2} onClick={() => void addTeam()}>创建团队</Button>
          </div>
        </section>
        <section style={cardStyle}>
          <h2 style={headingStyle}>成员与角色</h2>
          <div style={{ display: 'grid', gap: 7 }}>{data.members.map((member) => <div key={member.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}><strong>{member.displayName || member.username || member.userId}</strong><Chip label={member.role} color="#8b949e" bg="rgba(139,148,158,0.12)" /><span style={{ color: 'var(--text-muted)' }}>{member.teamIds.length} 个团队</span></div>)}</div>
          <p style={hintStyle}>成员邀请和角色维护由 owner/admin 管理。准备完成后进入 <Link to="/service-keys" style={{ color: 'var(--accent)' }}>接入密钥</Link>，再打开 <Link to="/quickstart" style={{ color: 'var(--accent)' }}>Quickstart</Link>。</p>
        </section>
      </>}
    </div>
  </div>;
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 10, color: 'var(--text-muted)', fontSize: 11 }}>{label}<input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} style={{ height: 34, padding: '0 9px', color: 'var(--text-primary)', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }} /></label>;
}

const cardStyle: React.CSSProperties = { padding: 14, background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)' };
const headingStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, margin: '0 0 12px', fontSize: 13 };
const hintStyle: React.CSSProperties = { margin: '10px 0 0', color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.55 };
