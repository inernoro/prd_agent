import { useCallback, useEffect, useState } from 'react';
import { Activity, Building2, KeyRound, Plus, RefreshCw, RotateCcw, Save, ShieldCheck, UserPlus, Users, Workflow } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  createMember,
  createTeam,
  createTenant,
  getOrganization,
  invalidateMemberSessions,
  setSession,
  switchTenant,
  updateMember,
} from '@/lib/api';
import type { CreateMemberRequest, OrganizationData, UpdateMemberRequest } from '@/lib/types';
import { useAuth } from '@/lib/auth';
import { Button, Chip, SectionLoader } from '@/components/ui';
import { canAccessPage, canUseCapability } from '@/lib/access';

type MemberRole = CreateMemberRequest['role'];
type MemberItem = OrganizationData['members'][number];
type TeamItem = OrganizationData['teams'][number];

const ROLE_OPTIONS: { value: MemberRole; label: string; detail: string }[] = [
  { value: 'owner', label: 'Owner', detail: '管理租户、成员和全部配置' },
  { value: 'admin', label: 'Admin', detail: '管理成员、路由、密钥、费用和审计' },
  { value: 'developer', label: 'Developer', detail: '管理自己团队的 appCaller 和密钥' },
  { value: 'viewer', label: 'Viewer', detail: '查看请求记录与用量' },
  { value: 'billing', label: 'Billing', detail: '只查看预算与用量' },
];

export function OrganizationPage() {
  const { tenant: sessionTenant, user } = useAuth();
  const [data, setData] = useState<OrganizationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tenantName, setTenantName] = useState('');
  const [tenantSlug, setTenantSlug] = useState('');
  const [teamName, setTeamName] = useState('');
  const [memberUsername, setMemberUsername] = useState('');
  const [memberDisplayName, setMemberDisplayName] = useState('');
  const [memberInitialPassword, setMemberInitialPassword] = useState('');
  const [memberRole, setMemberRole] = useState<MemberRole>('viewer');
  const [memberTeamIds, setMemberTeamIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const currentRole = sessionTenant?.role ?? 'viewer';
  const canManage = canUseCapability(sessionTenant?.role, 'organizationWrite');
  const canCreateTenant = canUseCapability(sessionTenant?.role, 'tenantOwner');
  const canManageKeys = canAccessPage(sessionTenant, 'serviceKeys');
  const canUseQuickstart = canAccessPage(sessionTenant, 'quickstart');
  const canManageAppCallers = canAccessPage(sessionTenant, 'appCallers');
  const canReadUsage = canAccessPage(sessionTenant, 'usage');

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
    setNotice(null);
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
    setNotice(null);
    const response = await createTeam({ name: teamName.trim() });
    setBusy(false);
    if (!response.success) {
      setError(response.error.message);
      return;
    }
    setTeamName('');
    setNotice(`团队“${response.data.name}”已创建`);
    await load();
  };

  const addMember = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const response = await createMember({
      username: memberUsername.trim(),
      displayName: memberDisplayName.trim() || undefined,
      initialPassword: memberInitialPassword || undefined,
      role: memberRole,
      teamIds: memberTeamIds,
    });
    setBusy(false);
    if (!response.success) {
      setError(response.error.message);
      return;
    }
    setMemberUsername('');
    setMemberDisplayName('');
    setMemberInitialPassword('');
    setMemberRole('viewer');
    setMemberTeamIds([]);
    setNotice(response.data.idempotentReplay ? '该成员已存在，现有成员关系保持不变' : `新成员账号 ${response.data.username} 已创建；首次登录时必须设置自己的密码`);
    await load();
  };

  const toggleCreateTeam = (teamId: string) => {
    setMemberTeamIds((current) => current.includes(teamId) ? current.filter((id) => id !== teamId) : [...current, teamId]);
  };

  return <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
    <div style={{ maxWidth: 1060, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Building2 size={18} />
        <div><h1 style={{ margin: 0, fontSize: 17 }}>组织与自助接入</h1><p style={{ ...hintStyle, marginTop: 3 }}>先建立租户边界，再用团队、角色和独立账号控制谁能做什么。</p></div>
        <Button size="sm" variant="ghost" style={{ marginLeft: 'auto' }} onClick={() => void load()}><RefreshCw size={14} />刷新</Button>
      </header>
      {error ? <div role="alert" style={errorStyle}>{error}</div> : null}
      {notice ? <div role="status" style={noticeStyle}>{notice}</div> : null}
      {!data ? (error ? <section style={cardStyle}><strong>当前账号不能读取组织信息</strong><p style={hintStyle}>请返回有权限的页面，或联系 Owner 调整角色。页面不会继续空白等待。</p></section> : <SectionLoader text="正在加载组织" />) : <>
        <section style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong>{data.tenant?.name || '当前租户'}</strong>
            <Chip label={data.tenant?.status || 'unknown'} color="#3fb950" bg="rgba(63,185,80,0.14)" />
            <Chip label={roleLabel(currentRole)} color="#58a6ff" bg="rgba(88,166,255,0.14)" />
            <code style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 11 }}>{data.tenant?.id}</code>
          </div>
          <p style={hintStyle}>当前租户由服务端登录会话确定。请求体和自定义 tenantId header 都不能切换数据范围。</p>
        </section>

        <section style={cardStyle} data-testid="tenant-governance-map">
          <div style={sectionHeadingRowStyle}>
            <div>
              <h2 style={headingStyle}><Activity size={14} />租户行为与额度在哪里管理</h2>
              <p style={hintStyle}>租户总预算与总速率负责兜底，appCaller 和接入密钥负责把额度继续细分到业务与接入方。</p>
            </div>
          </div>
          <div role="note" style={boundaryNoteStyle}>
            <strong>租户与业务限制会同时执行。</strong>
            <span>“预算与用量”可设置跨全部团队、key 和 appCaller 的总月预算与总 RPM；appCaller 月预算/RPM、接入密钥 RPM 继续作为更细的硬边界，任一层触顶都会拒绝请求。</span>
          </div>
          <div className="lg-quickstart-detail-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 8, marginTop: 10 }}>
            <GovernanceLink
              icon={<Workflow size={15} />}
              title="业务预算与业务速率"
              detail="在 appCaller 中按业务用途设置月预算、单次预算预占和每分钟上限。"
              to={canManageAppCallers ? '/app-callers' : undefined}
              action={canManageAppCallers ? '管理 appCaller' : '当前角色只读或不可见'}
            />
            <GovernanceLink
              icon={<KeyRound size={15} />}
              title="接入方速率与撤销"
              detail="每个系统、环境和用途使用独立 key，并为单把 key 设置每分钟上限。"
              to={canManageKeys ? '/service-keys' : undefined}
              action={canManageKeys ? '管理接入密钥' : '请联系密钥管理员'}
            />
            <GovernanceLink
              icon={<Activity size={15} />}
              title="租户总限制与费用可信度"
              detail="设置租户总月预算、单次原子预占和总 RPM，并查看费用证据与供应商对账。"
              to={canReadUsage ? '/usage' : undefined}
              action={canReadUsage ? '查看预算与用量' : '当前角色不可查看'}
            />
          </div>
          <p style={{ ...hintStyle, marginTop: 9 }}>推荐顺序：先在用量页设置租户兜底总限制，再为 appCaller 和 key 设置更细边界。要停止某个接入方时撤销它的 key，不要停用整个租户。</p>
        </section>

        <section style={cardStyle}>
          <div style={sectionHeadingRowStyle}>
            <div><h2 style={headingStyle}><ShieldCheck size={14} />五种角色怎么选</h2><p style={hintStyle}>给完成工作所需的最小权限。Owner 只留给真正负责租户的人。</p></div>
          </div>
          <div className="lg-quickstart-detail-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(185px, 1fr))', gap: 8 }}>
            {ROLE_OPTIONS.map((role) => <div key={role.value} style={roleCardStyle}><strong>{role.label}</strong><span>{role.detail}</span></div>)}
          </div>
        </section>

        {canCreateTenant ? <section style={cardStyle}>
          <h2 style={headingStyle}><Plus size={14} />创建新租户</h2>
          <p style={hintStyle}>新租户有独立的数据、预算、密钥和审计。创建后你会成为 Owner，并自动切换到新租户。</p>
          <div className="lg-quickstart-detail-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 10, alignItems: 'end', marginTop: 10 }}>
            <Field label="租户名称" value={tenantName} onChange={setTenantName} placeholder="教程咖啡店" />
            <Field label="Slug" value={tenantSlug} onChange={setTenantSlug} placeholder="tutorial-coffee" />
            <Button variant="primary" disabled={busy || tenantName.trim().length < 2 || tenantSlug.trim().length < 2} onClick={() => void addTenant()}>创建并切换</Button>
          </div>
        </section> : null}

        <section style={cardStyle}>
          <h2 style={headingStyle}><Users size={14} />当前租户团队</h2>
          <p style={hintStyle}>团队把成员、appCaller 和接入密钥放在同一工作范围。Developer 只能管理自己所属团队的接入。</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '10px 0 12px' }}>
            {data.teams.map((team) => <Chip key={team.id} label={`${team.name} · ${team.status}`} color="#58a6ff" bg="rgba(88,166,255,0.14)" />)}
          </div>
          {canManage ? <div style={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap' }}>
            <Field label="团队名称" value={teamName} onChange={setTeamName} placeholder="客服组" />
            <Button disabled={busy || teamName.trim().length < 2} onClick={() => void addTeam()}>创建团队</Button>
          </div> : <p style={hintStyle}>你的角色只能查看所属团队；创建或修改团队请联系 Owner 或 Admin。</p>}
        </section>

        {canManage ? <section style={cardStyle} data-testid="member-create">
          <h2 style={headingStyle}><UserPlus size={14} />添加成员</h2>
          <p style={hintStyle}>填写 3-48 位账号短名，系统会自动保存为“{data.tenant?.slug}.短名”，因此其他租户不能抢占或冒用。再设置至少 12 位的初始密码。已有其他租户账号只能通过本人确认的邀请流程加入。初始密码不会在列表中回显。</p>
          <div className="lg-quickstart-detail-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10, marginTop: 10 }}>
            <Field label="账号短名" value={memberUsername} onChange={(value) => setMemberUsername(value.toLowerCase())} placeholder="viewer" autoComplete="off" />
            <Field label="显示名称（可选）" value={memberDisplayName} onChange={setMemberDisplayName} placeholder="教程观察员" />
            <Field label="初始密码" value={memberInitialPassword} onChange={setMemberInitialPassword} placeholder="至少 12 位" type="password" autoComplete="new-password" />
            <label style={fieldStyle}><span>角色</span><select value={memberRole} onChange={(event) => setMemberRole(event.target.value as MemberRole)} style={inputStyle}>{ROLE_OPTIONS.filter((role) => currentRole === 'owner' || role.value !== 'owner').map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select></label>
          </div>
          <TeamChoices teams={data.teams} selected={memberTeamIds} onToggle={toggleCreateTeam} />
          {memberRole === 'developer' && memberTeamIds.length === 0 ? <p style={errorHintStyle}>Developer 至少要选择一个团队，否则登录后无法管理 appCaller 和接入密钥。</p> : null}
          <Button variant="primary" disabled={busy || !/^[a-z0-9][a-z0-9._-]{2,47}$/.test(memberUsername.trim()) || memberInitialPassword.length < 12 || memberRole === 'developer' && memberTeamIds.length === 0} onClick={() => void addMember()}><UserPlus size={14} />创建成员账号</Button>
        </section> : null}

        <section style={cardStyle}>
          <h2 style={headingStyle}>成员与角色</h2>
          <div style={{ display: 'grid', gap: 9 }}>
            {data.members.map((member) => <MemberRow key={`${member.id}:${member.version}`} member={member} teams={data.teams} currentRole={currentRole} currentUsername={user?.username} canManage={canManage} onChanged={async (message) => { setNotice(message); await load(); }} onError={setError} />)}
          </div>
          <p style={hintStyle}>成员准备完成后，{canManageKeys ? <Link to="/service-keys" style={{ color: 'var(--accent)' }}>进入接入密钥</Link> : '由密钥管理员签发接入密钥'}，再{canUseQuickstart ? <Link to="/quickstart" style={{ color: 'var(--accent)' }}>打开 Quickstart</Link> : '由有接入权限的成员完成安全直测'}。</p>
        </section>
      </>}
    </div>
  </div>;
}

function GovernanceLink({ icon, title, detail, to, action }: { icon: React.ReactNode; title: string; detail: string; to?: string; action: string }) {
  const content = <>
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-primary)', fontWeight: 600 }}>{icon}{title}</span>
    <span style={{ color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.55 }}>{detail}</span>
    <span style={{ color: to ? 'var(--accent)' : 'var(--text-muted)', fontSize: 11 }}>{action}</span>
  </>;
  const style: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, padding: 10, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', textDecoration: 'none' };
  return to ? <Link to={to} style={style}>{content}</Link> : <div style={style}>{content}</div>;
}

function MemberRow({ member, teams, currentRole, currentUsername, canManage, onChanged, onError }: {
  member: MemberItem;
  teams: TeamItem[];
  currentRole: string;
  currentUsername?: string;
  canManage: boolean;
  onChanged: (message: string) => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [role, setRole] = useState<MemberRole>(member.role as MemberRole);
  const [status, setStatus] = useState<'active' | 'disabled'>(member.status === 'disabled' ? 'disabled' : 'active');
  const [teamIds, setTeamIds] = useState<string[]>(member.teamIds);
  const [busy, setBusy] = useState(false);
  const ownerLocked = member.role === 'owner' && currentRole !== 'owner';
  const selfLocked = Boolean(currentUsername && member.username === currentUsername);
  const editable = canManage && !ownerLocked && !selfLocked;
  const selectedDisabledTeams = teamIds.filter((teamId) => teams.some((team) => team.id === teamId && team.status !== 'active'));
  const missingDeveloperTeam = role === 'developer' && teamIds.length === 0;

  const toggleTeam = (teamId: string) => setTeamIds((current) => current.includes(teamId) ? current.filter((id) => id !== teamId) : [...current, teamId]);

  const save = async () => {
    setBusy(true);
    onError(null);
    const request: UpdateMemberRequest = { expectedVersion: member.version, role, status, teamIds };
    const response = await updateMember(member.id, request);
    setBusy(false);
    if (!response.success) { onError(response.error.message); return; }
    await onChanged(`成员“${member.displayName || member.username || member.userId}”已更新`);
  };

  const invalidate = async () => {
    if (!window.confirm(`让“${member.displayName || member.username || member.userId}”的现有登录立即失效？`)) return;
    setBusy(true);
    onError(null);
    const response = await invalidateMemberSessions(member.id);
    setBusy(false);
    if (!response.success) { onError(response.error.message); return; }
    await onChanged(`成员“${member.displayName || member.username || member.userId}”需要重新登录`);
  };

  return <div style={memberCardStyle} data-testid={`member-row-${member.id}`}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <strong>{member.displayName || member.username || member.userId}</strong>
      {member.displayName && member.username ? <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>@{member.username}</span> : null}
      <Chip label={member.status} color={member.status === 'active' ? '#3fb950' : '#f85149'} bg={member.status === 'active' ? 'rgba(63,185,80,0.14)' : 'rgba(248,81,73,0.14)'} />
      {ownerLocked ? <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>只有 Owner 可以修改 Owner</span> : null}
      {selfLocked ? <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>为防止当前会话锁死，不能在这里修改自己</span> : null}
    </div>
    {editable ? <>
      <div className="lg-quickstart-detail-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 220px) minmax(150px, 220px)', gap: 8, marginTop: 9 }}>
        <label style={fieldStyle}><span>角色</span><select value={role} onChange={(event) => setRole(event.target.value as MemberRole)} style={inputStyle}>{ROLE_OPTIONS.filter((item) => currentRole === 'owner' || item.value !== 'owner').map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <label style={fieldStyle}><span>状态</span><select value={status} onChange={(event) => setStatus(event.target.value as 'active' | 'disabled')} style={inputStyle}><option value="active">启用</option><option value="disabled">停用</option></select></label>
      </div>
      <TeamChoices teams={teams} selected={teamIds} onToggle={toggleTeam} />
      {selectedDisabledTeams.length > 0 ? <p style={errorHintStyle}>成员仍关联已停用团队，请先取消这些团队再保存。</p> : null}
      {missingDeveloperTeam ? <p style={errorHintStyle}>Developer 至少要选择一个团队。</p> : null}
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
        <Button size="sm" variant="primary" disabled={busy || selectedDisabledTeams.length > 0 || missingDeveloperTeam} onClick={() => void save()}><Save size={13} />保存成员范围</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void invalidate()}><RotateCcw size={13} />强制重新登录</Button>
      </div>
    </> : <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
      <Chip label={roleLabel(member.role)} color="#8b949e" bg="rgba(139,148,158,0.12)" />
      {member.teamIds.map((teamId) => <Chip key={teamId} label={teams.find((team) => team.id === teamId)?.name || '未知团队'} color="#58a6ff" bg="rgba(88,166,255,0.14)" />)}
    </div>}
  </div>;
}

function TeamChoices({ teams, selected, onToggle }: { teams: TeamItem[]; selected: string[]; onToggle: (teamId: string) => void }) {
  return <fieldset style={fieldsetStyle}>
    <legend>所属团队</legend>
    {teams.length === 0 ? <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>还没有团队，可先创建团队；Owner、Admin、Viewer 和 Billing 可以不选团队。</span> : <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{teams.filter((team) => team.status === 'active' || selected.includes(team.id)).map((team) => <label key={team.id} style={checkStyle}><input type="checkbox" checked={selected.includes(team.id)} onChange={() => onToggle(team.id)} />{team.name}{team.status !== 'active' ? '（已停用，请取消）' : ''}</label>)}</div>}
  </fieldset>;
}

function Field({ label, value, onChange, placeholder, type = 'text', autoComplete }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; type?: 'text' | 'password'; autoComplete?: string }) {
  return <label style={fieldStyle}><span>{label}</span><input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} autoComplete={autoComplete} style={inputStyle} /></label>;
}

function roleLabel(role: string) {
  return ROLE_OPTIONS.find((item) => item.value === role)?.label || role;
}

const cardStyle: React.CSSProperties = { padding: 14, background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)' };
const memberCardStyle: React.CSSProperties = { padding: 11, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' };
const roleCardStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, padding: 9, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', fontSize: 11, lineHeight: 1.45 };
const boundaryNoteStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 9, padding: '9px 10px', color: 'var(--text-secondary)', background: 'var(--accent-soft)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', fontSize: 11, lineHeight: 1.55 };
const headingStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, margin: '0 0 5px', fontSize: 13 };
const sectionHeadingRowStyle: React.CSSProperties = { display: 'flex', gap: 10, alignItems: 'flex-start', justifyContent: 'space-between' };
const hintStyle: React.CSSProperties = { margin: '0', color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.55 };
const fieldStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0, color: 'var(--text-muted)', fontSize: 11 };
const inputStyle: React.CSSProperties = { height: 34, minWidth: 0, padding: '0 9px', color: 'var(--text-primary)', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' };
const fieldsetStyle: React.CSSProperties = { margin: '10px 0', padding: 10, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-muted)', fontSize: 11 };
const checkStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)', fontSize: 12 };
const errorStyle: React.CSSProperties = { color: 'var(--danger)', fontSize: 12, padding: '9px 11px', background: 'rgba(248,81,73,0.08)', border: '1px solid rgba(248,81,73,0.26)', borderRadius: 'var(--radius-sm)' };
const noticeStyle: React.CSSProperties = { color: 'var(--success)', fontSize: 12, padding: '9px 11px', background: 'rgba(63,185,80,0.08)', border: '1px solid rgba(63,185,80,0.24)', borderRadius: 'var(--radius-sm)' };
const errorHintStyle: React.CSSProperties = { margin: '7px 0', color: 'var(--danger)', fontSize: 11, lineHeight: 1.5 };
