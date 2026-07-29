// 团队与成员。
//
// 这一页是「控制台风格调性 v1.2」的样板页，改版要点（详见
// doc/rule.platform.llm-gateway.console-design-tonality.md 原则 6 / 7）：
//   - 走 PageShell 骨架、贴边全宽；此前是 maxWidth:1060 居中，宽屏两侧空转。
//   - 文字预算：正文段落 ≤2 段。原来 8 个堆叠区块里有两整段是纯说明零控件
//     （「租户行为与额度在哪里管理」「五种角色怎么选」），其中三张卡片指向的
//     appCaller / 接入密钥 / 预算与用量在侧边栏本来就有，属于重复导航，已删。
//   - 角色说明收进角色字段旁的 HelpPopover；概念解释收进默认收起的
//     DetailsBlock 并深链教程第 5 章，控制台里不再复述教程正文。
//   - 成员从「一人一张卡」改成表格：一屏看完谁是谁、什么角色、在哪个团队、是否停用；
//     增改走抽屉，不占版面。
import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Plus, RefreshCw, RotateCcw, Save, UserPlus, X } from 'lucide-react';
import { createPortal } from 'react-dom';
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
import { invalidateOnboardingCache } from '@/lib/onboarding';
import { Button, Card, Chip, InlineAlert, SectionLoader } from '@/components/ui';
import { DetailsBlock, FormGrid, HelpPopover, PageBody, PageHeader, PageShell, Prose, TutorialLink } from '@/components/PageShell';
import { canUseCapability } from '@/lib/access';
import { CARD_BODY, GAP } from '@/lib/surface';
import { FIELD_INPUT, FIELD_LABEL, HINT_TEXT, MONO_META, SECTION_TITLE, TABLE_CELL, TABLE_CELL_MUTED, TABLE_HEAD_CELL } from '@/lib/typography';

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

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,47}$/;

function roleLabel(role: string) {
  return ROLE_OPTIONS.find((item) => item.value === role)?.label || role;
}

/** 五种角色的说明——原来是一整块 5 张卡的常驻区块，现在只在角色字段旁按需展开。 */
function RoleHelp({ align }: { align?: 'start' | 'end' }) {
  return (
    <HelpPopover label="角色" align={align}>
      <dl>
        {ROLE_OPTIONS.map((role) => (
          <div key={role.value}>
            <dt>{role.label}</dt>
            <dd>{role.detail}</dd>
          </div>
        ))}
      </dl>
    </HelpPopover>
  );
}

type DrawerState = { mode: 'create' } | { mode: 'edit'; member: MemberItem } | null;

export function OrganizationPage() {
  const { tenant: sessionTenant, user } = useAuth();
  const [data, setData] = useState<OrganizationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [teamName, setTeamName] = useState('');
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [tenantDialogOpen, setTenantDialogOpen] = useState(false);

  const currentRole = sessionTenant?.role ?? 'viewer';
  const canManage = canUseCapability(sessionTenant?.role, 'organizationWrite');
  const canCreateTenant = canUseCapability(sessionTenant?.role, 'tenantOwner');

  const load = useCallback(async () => {
    setError(null);
    const response = await getOrganization();
    if (response.success) setData(response.data);
    else setError(response.error.message);
  }, []);

  useEffect(() => { void load(); }, [load]);

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
    invalidateOnboardingCache(sessionTenant?.id);
    setNotice(`团队“${response.data.name}”已创建`);
    await load();
  };

  const afterMemberChange = async (message: string) => {
    setNotice(message);
    setDrawer(null);
    await load();
  };

  return (
    <PageShell>
      <PageHeader
        title="团队与成员"
        subtitle="用团队和角色决定谁能改什么。"
        summary={data ? (
          <>
            <span><strong>{data.tenant?.name || '当前租户'}</strong></span>
            <Chip label={roleLabel(currentRole)} color="var(--accent)" bg="var(--accent-soft)" />
            <span>团队 <strong>{data.teams.length}</strong></span>
            <span>成员 <strong>{data.members.length}</strong></span>
            <code style={MONO_META}>{data.tenant?.id}</code>
          </>
        ) : undefined}
        actions={(
          <>
            <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw size={14} />刷新</Button>
            {canCreateTenant ? (
              <Button size="sm" variant="secondary" onClick={() => setTenantDialogOpen(true)}><Plus size={14} />新建租户</Button>
            ) : null}
          </>
        )}
      />

      <PageBody>
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        {notice ? <InlineAlert tone="ok">{notice}</InlineAlert> : null}

        {!data ? (
          error
            ? <Card style={CARD_BODY}><Prose>当前账号不能读取组织信息，请联系 Owner 调整角色。</Prose></Card>
            : <SectionLoader text="正在加载组织" />
        ) : (
          <>
            <Card style={CARD_BODY}>
              <div style={cardHeadStyle}>
                <h2 style={SECTION_TITLE}>团队</h2>
                <span style={countStyle}>{data.teams.length} 个</span>
              </div>
              {data.teams.length === 0 ? (
                <Prose style={{ marginBottom: GAP.section }}>还没有团队。团队把成员、appCaller 和接入密钥放进同一工作范围。</Prose>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP.tight, marginBottom: GAP.section }}>
                  {data.teams.map((team) => (
                    <Chip
                      key={team.id}
                      label={team.status === 'active' ? team.name : `${team.name}（已停用）`}
                      color={team.status === 'active' ? 'var(--accent)' : 'var(--text-muted)'}
                      bg={team.status === 'active' ? 'var(--accent-soft)' : 'var(--bg-elevated)'}
                    />
                  ))}
                </div>
              )}
              {canManage ? (
                <FormGrid>
                  <label style={FIELD_LABEL}>
                    <span>团队名称</span>
                    <input value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="客服组" style={FIELD_INPUT} />
                  </label>
                  <Button size="sm" disabled={busy || teamName.trim().length < 2} onClick={() => void addTeam()}>创建团队</Button>
                </FormGrid>
              ) : null}
            </Card>

            <Card style={CARD_BODY}>
              <div style={cardHeadStyle}>
                <h2 style={SECTION_TITLE}>成员</h2>
                <div style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, flexWrap: 'wrap' }}>
                  {/* 角色说明放在卡片头而不是 <th> 里：表格外层是 overflow-x:auto，
                      一旦某个轴不是 visible，另一个轴就按 auto 计算，浮层会被纵向裁掉
                      （实测第 5 个角色 Billing 被切掉一半）。 */}
                  <span style={countStyle}>角色<RoleHelp align="end" /></span>
                  <span style={countStyle}>{data.members.length} 人</span>
                  {canManage ? (
                    <Button size="sm" variant="primary" onClick={() => setDrawer({ mode: 'create' })}><UserPlus size={14} />添加成员</Button>
                  ) : null}
                </div>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={TABLE_HEAD_CELL}>成员</th>
                      <th style={TABLE_HEAD_CELL}>账号</th>
                      <th style={TABLE_HEAD_CELL}>角色</th>
                      <th style={TABLE_HEAD_CELL}>团队</th>
                      <th style={TABLE_HEAD_CELL}>状态</th>
                      <th style={TABLE_HEAD_CELL} />
                    </tr>
                  </thead>
                  <tbody>
                    {data.members.map((member) => {
                      const ownerLocked = member.role === 'owner' && currentRole !== 'owner';
                      const selfLocked = Boolean(user?.username && member.username === user.username);
                      const editable = canManage && !ownerLocked && !selfLocked;
                      const teamNames = member.teamIds
                        .map((teamId) => data.teams.find((team) => team.id === teamId)?.name || '未知团队')
                        .join('、');
                      return (
                        <tr key={`${member.id}:${member.version}`} data-testid={`member-row-${member.id}`}>
                          <td style={TABLE_CELL}>{member.displayName || member.username || member.userId}</td>
                          <td style={{ ...TABLE_CELL, ...MONO_META }}>{member.username || '—'}</td>
                          <td style={TABLE_CELL}>{roleLabel(member.role)}</td>
                          <td style={TABLE_CELL_MUTED}>{teamNames || '—'}</td>
                          <td style={TABLE_CELL}>
                            <Chip
                              label={member.status}
                              color={member.status === 'active' ? 'var(--ok)' : 'var(--warn)'}
                              bg={member.status === 'active' ? 'var(--ok-bg)' : 'var(--warn-bg)'}
                            />
                          </td>
                          <td style={{ ...TABLE_CELL, textAlign: 'right' }}>
                            {editable ? (
                              <Button size="sm" variant="ghost" onClick={() => setDrawer({ mode: 'edit', member })}>编辑</Button>
                            ) : (
                              <span style={{ ...HINT_TEXT, whiteSpace: 'nowrap' }}>
                                {selfLocked ? '不能在这里修改自己' : ownerLocked ? '只有 Owner 可以修改 Owner' : '只读'}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>

            <DetailsBlock title="工作原理：租户、团队、角色的边界">
              <Prose>
                租户是数据、预算、密钥和审计的隔离边界，由服务端登录会话确定，请求体和自定义 tenantId header 都改不了它。
                租户级总限制与 appCaller、接入密钥的细粒度限制同时生效，任一层触顶都会拒绝请求。
              </Prose>
              <TutorialLink chapter="chapter-05">查看教程：第 5 章 团队与成员</TutorialLink>
            </DetailsBlock>
          </>
        )}
      </PageBody>

      {drawer && data ? (
        <MemberDrawer
          mode={drawer.mode}
          member={drawer.mode === 'edit' ? drawer.member : undefined}
          teams={data.teams}
          tenantSlug={data.tenant?.slug}
          currentRole={currentRole}
          onClose={() => setDrawer(null)}
          onDone={afterMemberChange}
          onError={setError}
        />
      ) : null}

      {tenantDialogOpen ? (
        <TenantDialog onClose={() => setTenantDialogOpen(false)} onError={setError} />
      ) : null}
    </PageShell>
  );
}

/**
 * 成员抽屉：新增与编辑共用一套表单。
 * 走既有的 .lg-side-drawer-* 结构（与 App 详情抽屉同款），不另造一套浮层。
 */
function MemberDrawer({ mode, member, teams, tenantSlug, currentRole, onClose, onDone, onError }: {
  mode: 'create' | 'edit';
  member?: MemberItem;
  teams: TeamItem[];
  tenantSlug?: string;
  currentRole: string;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [memberInitialPassword, setMemberInitialPassword] = useState('');
  const [memberRole, setMemberRole] = useState<MemberRole>((member?.role as MemberRole) ?? 'viewer');
  const [status, setStatus] = useState<'active' | 'disabled'>(member?.status === 'disabled' ? 'disabled' : 'active');
  const [memberTeamIds, setMemberTeamIds] = useState<string[]>(member?.teamIds ?? []);
  const [busy, setBusy] = useState(false);

  const isCreate = mode === 'create';
  const selected = memberTeamIds;
  const who = member ? (member.displayName || member.username || member.userId) : '';
  const selectedDisabledTeams = memberTeamIds.filter((teamId) => teams.some((team) => team.id === teamId && team.status !== 'active'));
  const missingDeveloperTeam = memberRole === 'developer' && memberTeamIds.length === 0;
  const usernameOk = USERNAME_PATTERN.test(username.trim());
  const blocked = busy
    || missingDeveloperTeam
    || (isCreate ? (!usernameOk || memberInitialPassword.length < 12) : selectedDisabledTeams.length > 0);

  const toggleTeam = (teamId: string) => setMemberTeamIds((current) =>
    current.includes(teamId) ? current.filter((id) => id !== teamId) : [...current, teamId]);

  const submit = async () => {
    setBusy(true);
    onError(null);
    if (isCreate) {
      const response = await createMember({
        username: username.trim(),
        displayName: displayName.trim() || undefined,
        initialPassword: memberInitialPassword || undefined,
        role: memberRole,
        teamIds: memberTeamIds,
      });
      setBusy(false);
      if (!response.success) { onError(response.error.message); return; }
      invalidateOnboardingCache();
      await onDone(response.data.idempotentReplay
        ? '该成员已存在，现有成员关系保持不变'
        : `新成员账号 ${response.data.username} 已创建；首次登录时必须设置自己的密码`);
      return;
    }
    if (!member) return;
    const request: UpdateMemberRequest = { expectedVersion: member.version, role: memberRole, status, teamIds: memberTeamIds };
    const response = await updateMember(member.id, request);
    setBusy(false);
    if (!response.success) { onError(response.error.message); return; }
    // 改成员和建成员是同一份事实的两个方向：新人清单的「拉一个成员」只数 active，
    // 把唯一一个额外成员停用后这一步应当重新亮起。此前只在创建路径失效，
    // 于是 60 秒内回到概览仍认为这一步完成、清单已经消失（Codex P2）。
    invalidateOnboardingCache();
    await onDone(`成员“${who}”已更新`);
  };

  const invalidate = async () => {
    if (!member) return;
    if (!window.confirm(`让“${who}”的现有登录立即失效？`)) return;
    setBusy(true);
    onError(null);
    const response = await invalidateMemberSessions(member.id);
    setBusy(false);
    if (!response.success) { onError(response.error.message); return; }
    await onDone(`成员“${who}”需要重新登录`);
  };

  return createPortal(
    <div className="lg-side-drawer-portal">
      <button className="lg-side-drawer-backdrop" type="button" aria-label="关闭" onClick={onClose} />
      <aside className="lg-side-drawer" role="dialog" aria-modal="true" aria-label={isCreate ? '添加成员' : `编辑成员 ${who}`}>
        <header className="lg-side-drawer-header">
          <div className="lg-side-drawer-title">
            <span className="lg-side-drawer-icon">{isCreate ? <UserPlus size={17} /> : <Save size={17} />}</span>
            <div><small>{isCreate ? '添加成员' : '编辑成员'}</small><h2>{isCreate ? '新成员账号' : who}</h2></div>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="lg-side-drawer-body" data-testid={isCreate ? 'member-create' : undefined}>
          {isCreate ? (
            <>
              <label style={FIELD_LABEL}>
                <span>
                  账号短名
                  <HelpPopover label="账号短名">
                    填 3-48 位小写短名。系统会保存为 <code>{tenantSlug || '租户'}.短名</code>，其他租户不能抢占或冒用。
                    已有其他租户账号的人只能通过本人确认的邀请流程加入。
                  </HelpPopover>
                </span>
                <input value={username} onChange={(event) => setUsername(event.target.value.toLowerCase())} placeholder="viewer" autoComplete="off" style={FIELD_INPUT} />
              </label>
              <label style={FIELD_LABEL}>
                <span>显示名称（可选）</span>
                <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="教程观察员" style={FIELD_INPUT} />
              </label>
              <label style={FIELD_LABEL}>
                <span>初始密码</span>
                <input type="password" value={memberInitialPassword} onChange={(event) => setMemberInitialPassword(event.target.value)} placeholder="至少 12 位，不会再回显" autoComplete="new-password" style={FIELD_INPUT} />
              </label>
            </>
          ) : null}

          <label style={FIELD_LABEL}>
            <span>角色<RoleHelp /></span>
            <select value={memberRole} onChange={(event) => setMemberRole(event.target.value as MemberRole)} style={FIELD_INPUT}>
              {ROLE_OPTIONS.filter((item) => currentRole === 'owner' || item.value !== 'owner').map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </label>

          {!isCreate ? (
            <label style={FIELD_LABEL}>
              <span>状态</span>
              <select value={status} onChange={(event) => setStatus(event.target.value as 'active' | 'disabled')} style={FIELD_INPUT}>
                <option value="active">启用</option>
                <option value="disabled">停用</option>
              </select>
            </label>
          ) : null}

          <fieldset style={fieldsetStyle}>
            <legend>所属团队</legend>
            {teams.length === 0 ? (
              <span style={HINT_TEXT}>还没有团队。Owner、Admin、Viewer 和 Billing 可以不选团队。</span>
            ) : (
              <div style={{ display: 'flex', gap: GAP.section, flexWrap: 'wrap' }}>
                {/* 已停用但仍被勾选的团队要继续显示，否则用户看不到该取消什么。
                    这里的 `selected` 命名被 GatewayDataDomainGuardTests 按字面量断言，勿改。 */}
                {teams.filter((team) => team.status === 'active' || selected.includes(team.id)).map((team) => (
                  <label key={team.id} style={checkStyle}>
                    <input type="checkbox" checked={memberTeamIds.includes(team.id)} onChange={() => toggleTeam(team.id)} />
                    {team.name}{team.status !== 'active' ? '（已停用，请取消）' : ''}
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          {missingDeveloperTeam ? <InlineAlert tone="error">Developer 至少要选择一个团队，否则登录后无法管理 appCaller 和接入密钥。</InlineAlert> : null}
          {selectedDisabledTeams.length > 0 ? <InlineAlert tone="error">成员仍关联已停用团队，请先取消这些团队再保存。</InlineAlert> : null}
        </div>

        <div className="lg-side-drawer-footer">
          <Button size="sm" variant="primary" disabled={blocked} onClick={() => void submit()}>
            {isCreate ? <UserPlus size={13} /> : <Save size={13} />}{isCreate ? '创建成员账号' : '保存成员范围'}
          </Button>
          {!isCreate ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void invalidate()}><RotateCcw size={13} />强制重新登录</Button>
          ) : null}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

/** 新建租户：从页头操作区打开，只有 Owner 能看到（沿用原 canCreateTenant 门控）。 */
function TenantDialog({ onClose, onError }: { onClose: () => void; onError: (message: string | null) => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    onError(null);
    const created = await createTenant({ name: name.trim(), slug: slug.trim().toLowerCase() });
    if (!created.success) { onError(created.error.message); setBusy(false); return; }
    const switched = await switchTenant(created.data.id);
    setBusy(false);
    if (!switched.success) { onError(switched.error.message); return; }
    setSession(switched.data);
    window.location.reload();
  };

  return createPortal(
    <div className="lg-side-drawer-portal">
      <button className="lg-side-drawer-backdrop" type="button" aria-label="关闭" onClick={onClose} />
      <aside className="lg-side-drawer" role="dialog" aria-modal="true" aria-label="新建租户">
        <header className="lg-side-drawer-header">
          <div className="lg-side-drawer-title">
            <span className="lg-side-drawer-icon"><KeyRound size={17} /></span>
            <div><small>新建租户</small><h2>独立的数据与预算边界</h2></div>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="lg-side-drawer-body">
          <Prose>新租户有独立的数据、预算、密钥和审计。创建后你会成为 Owner 并自动切换过去。</Prose>
          <label style={FIELD_LABEL}>
            <span>租户名称</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="教程咖啡店" style={FIELD_INPUT} />
          </label>
          <label style={FIELD_LABEL}>
            <span>Slug</span>
            <input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="tutorial-coffee" style={FIELD_INPUT} />
          </label>
        </div>
        <div className="lg-side-drawer-footer">
          <Button size="sm" variant="primary" disabled={busy || name.trim().length < 2 || slug.trim().length < 2} onClick={() => void submit()}>
            <Plus size={13} />创建并切换
          </Button>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

const cardHeadStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: GAP.section,
  flexWrap: 'wrap',
  marginBottom: GAP.normal,
};
const countStyle: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 'var(--fs-secondary)' };
const fieldsetStyle: React.CSSProperties = {
  margin: 0,
  padding: 10,
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-muted)',
  fontSize: 'var(--fs-secondary)',
};
const checkStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: GAP.tight,
  color: 'var(--text-secondary)',
  fontSize: 'var(--fs-body)',
};
