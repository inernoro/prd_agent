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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyRound, Pencil, Plus, RefreshCw, RotateCcw, Save, Trash2, UserPlus, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  createMember,
  createTeam,
  deleteMember,
  deleteTeam,
  deleteTenant,
  updateTeam,
  createTenant,
  getOrganization,
  invalidateMemberSessions,
  setSession,
  switchTenant,
  updateMember,
} from '@/lib/api';
import type { ApiResponse, CreateMemberRequest, OrganizationData, UpdateMemberRequest } from '@/lib/types';
import { useDialogs } from '@/components/ConfirmDialog';
import { useAuth } from '@/lib/auth';
import { invalidateOnboardingCache } from '@/lib/onboarding';
import { Button, Card, Chip, InlineAlert, SectionLoader } from '@/components/ui';
import { DetailsBlock, FormGrid, HelpPopover, PageBody, PageHeader, PageShell, Prose, TutorialLink } from '@/components/PageShell';
import './OrganizationPage.css';
import { useDialogFocus } from '@/lib/useDialogFocus';
import { canUseCapability } from '@/lib/access';
import { CARD_BODY, GAP } from '@/lib/surface';
import { FIELD_INPUT, FIELD_LABEL, HINT_TEXT, MONO_META, SECTION_TITLE, TABLE_CELL, TABLE_CELL_MUTED, TABLE_HEAD_CELL } from '@/lib/typography';

async function observedWrite<T>(request: Promise<ApiResponse<T>>): Promise<ApiResponse<T>> { return request.catch(() => ({ success: false, data: null, error: { code: 'NETWORK_ERROR', message: '响应读取中断' } })); }
// Confirmed pre-write/atomic rejections from the organization endpoints; unfamiliar failures remain unknown.
const ORGANIZATION_REJECTIONS = new Set(['UNAUTHORIZED', 'FORBIDDEN', 'INVALID_TENANT', 'TENANT_ACCESS_DENIED', 'TENANT_CONFLICT', 'TENANT_SCOPE_MISMATCH', 'INTERNAL_TENANT', 'TENANT_NOT_FOUND', 'TENANT_NOT_EMPTY', 'INVALID_TEAM', 'TEAM_CONFLICT', 'TEAM_NOT_FOUND', 'TEAM_IN_USE', 'INVALID_MEMBER', 'DEVELOPER_TEAM_REQUIRED', 'OWNER_REQUIRED', 'MEMBERSHIP_CONFLICT', 'USERNAME_UNAVAILABLE', 'INVALID_PASSWORD', 'MEMBERSHIP_NOT_FOUND', 'SELF_MEMBERSHIP_CHANGE_FORBIDDEN', 'INVALID_ROLE', 'INVALID_STATUS', 'LAST_OWNER', 'SELF_SESSION_INVALIDATION_FORBIDDEN']);
const unknownWrite = (code?: string) => !code || !ORGANIZATION_REJECTIONS.has(code);

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
  const { tenant: sessionTenant, user, logout } = useAuth();
  const [data, setData] = useState<OrganizationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [memberSearch, setMemberSearch] = useState('');
  const [pageUnknown, setPageUnknown] = useState(false);
  const [reading, setReading] = useState(false);
  const readSequence = useRef(0);
  const [teamName, setTeamName] = useState('');
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [tenantDialogOpen, setTenantDialogOpen] = useState(false);

  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(null), 5000); return () => window.clearTimeout(timer); }, [notice]);

  const visibleMembers = useMemo(() => {
    const term = memberSearch.trim().toLowerCase();
    return (data?.members || []).filter(member => !term || [member.username, member.displayName, member.userId].some(value => value?.toLowerCase().includes(term)));
  }, [data?.members, memberSearch]);

  const currentRole = sessionTenant?.role ?? 'viewer';
  const canManage = canUseCapability(sessionTenant?.role, 'organizationWrite');
  const canCreateTenant = canUseCapability(sessionTenant?.role, 'tenantOwner');
  const { confirm, promptText } = useDialogs();

  const load = useCallback(async () => {
    const seq = ++readSequence.current;
    setReading(true); setError(null);
    const response = await getOrganization().catch(() => ({ success: false as const, data: null, error: { code: 'NETWORK_ERROR', message: '组织信息读取中断，请重试' } }));
    if (seq !== readSequence.current) return;
    setReading(false);
    if (response.success) { setData(response.data); setPageUnknown(false); }
    else setError(response.error.message);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const beginPageWrite = () => { ++readSequence.current; setReading(false); setBusy(true); setError(null); setNotice(null); };
  const failPageWrite = (error: { code?: string; message?: string }, operation: string) => {
    if (unknownWrite(error.code)) { setPageUnknown(true); setError(`${operation}结果未确认，可能已生效。请刷新核对，勿重复提交。${error.message || ''}`); }
    else setError(error.message || `${operation}被拒绝`);
  };

  // 后端一直有 PUT /gw/teams/{id}，但前端从没给过入口 —— 团队名一旦打错就永远改不回来。
  // 这是断头自检里唯一一条 A 类（后端有能力、前端无入口），补在团队 chip 上。
  const renameTeam = async (team: OrganizationData['teams'][number]) => {
    if (!canManage || busy || pageUnknown || reading) return;
    const next = await promptText({ title: `把团队“${team.name}”改成什么名字？`, inputLabel: '新的团队名称', defaultValue: team.name, confirmLabel: '改名' });
    if (next === null) return;
    const name = next.trim();
    if (name.length < 2) { setError('团队名称至少 2 个字符'); return; }
    if (name === team.name) return;
    beginPageWrite();
    const response = await observedWrite(updateTeam(team.id, name));
    setBusy(false);
    if (!response.success) { failPageWrite(response.error, '修改团队'); return; }
    invalidateOnboardingCache(sessionTenant?.id);
    setNotice(`团队已改名为“${name}”`);
    await load();
  };

  // 团队删掉后引用方不会报错，只会被当成「没有范围」——所以后端先查三类引用，
  // 这里把它报回来的原文原样端出去，运维才知道该先解哪一个。
  const removeTeam = async (team: OrganizationData['teams'][number]) => {
    if (!canManage || busy || pageUnknown || reading) return;
    if (!await confirm({ title: `删除团队“${team.name}”？`, description: '成员、接入密钥、appCaller 只要还引用它就会被拒绝。', tone: 'danger', confirmLabel: '删除' })) return;
    beginPageWrite();
    const response = await observedWrite(deleteTeam(team.id));
    setBusy(false);
    if (!response.success) { failPageWrite(response.error, '删除团队'); return; }
    invalidateOnboardingCache(sessionTenant?.id);
    setNotice(`团队“${team.name}”已删除`);
    await load();
  };

  // 删成员是不可逆的移出租户（账号本身还在，可能还属于别的租户）。
  // 「不能删自己 / 只有 owner 能删 owner / 不能删最后一个 owner」三条由后端判定，
  // 前端只在按钮可见性上先挡掉前两条，最后一条只有服务端知道。
  const removeMember = async (member: MemberItem) => {
    if (!canManage || busy || pageUnknown || reading) return;
    const label = member.displayName || member.username || member.userId;
    const typed = await promptText({
      title: `把“${label}”移出本租户？`,
      description: '账号本身保留，租户内的角色与团队归属会消失，无法撤销。',
      inputLabel: '确认请输入成员账号',
      requireExact: member.username || member.userId,
      tone: 'danger',
      confirmLabel: '移出',
    });
    if (typed === null) return;
    if (typed.trim() !== (member.username || member.userId)) { setError('输入的账号不一致，已取消删除'); return; }
    beginPageWrite();
    const response = await observedWrite(deleteMember(member.id));
    setBusy(false);
    if (!response.success) { failPageWrite(response.error, '移出成员'); return; }
    invalidateOnboardingCache(sessionTenant?.id);
    setNotice(`“${label}”已移出本租户`);
    await load();
  };

  // 删租户只删空租户：不做级联是有意的——级联写错不可逆，「先自己清干净」可逆。
  // 删成功后当前会话所在的租户就没了，只能回登录页重新选租户。
  const removeTenant = async () => {
    if (!data?.tenant || !canCreateTenant || busy || pageUnknown || reading) return;
    const typed = await promptText({
      title: `删除租户“${data.tenant.name}”`,
      description: '只有完全清空的租户能删：上游、模型、模型池、交换所、逻辑模型、接入密钥、appCaller、其他成员都必须为零。\n删除后当前会话失效，需要重新登录。',
      inputLabel: '确认请输入租户 slug',
      requireExact: data.tenant.slug,
      tone: 'danger',
      confirmLabel: '删除租户',
    });
    if (typed === null) return;
    if (typed.trim() !== data.tenant.slug) { setError('输入的 slug 不一致，已取消删除'); return; }
    beginPageWrite();
    const response = await observedWrite(deleteTenant(data.tenant.id));
    setBusy(false);
    if (!response.success) { failPageWrite(response.error, '删除租户'); return; }
    // 租户没了，当前会话签发时绑定的租户也就不存在了：走正规登出，别留一个指向空租户的 token。
    logout();
  };

  const addTeam = async () => {
    if (!canManage || busy || pageUnknown || reading || teamName.trim().length < 2) return;
    beginPageWrite();
    const response = await observedWrite(createTeam({ name: teamName.trim() }));
    setBusy(false);
    if (!response.success) {
      failPageWrite(response.error, '创建团队');
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
          </>
        ) : undefined}
        actions={(
          <>
            <Button size="sm" variant="ghost" disabled={busy || reading} onClick={() => void load()}><RefreshCw size={14} />{reading ? '正在读取…' : '刷新'}</Button>
            {canManage && data ? <Button data-member-primary="true" disabled={busy || pageUnknown || reading} size="sm" variant="primary" onClick={() => setDrawer({ mode: 'create' })}><UserPlus size={14} />添加成员</Button> : null}
          </>
        )}
      />

      <PageBody>
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        {pageUnknown ? <div role="status">以下为上次读取的数据，上次操作仍待核对。请刷新获取最新状态。</div> : null}
        {reading && data ? <div role="status">正在读取最新组织状态…</div> : null}
        {notice ? <InlineAlert tone="ok">{notice}</InlineAlert> : null}

        {!data ? (
          error
            ? <div role="status">组织信息暂不可用，请使用“刷新”重新读取；权限拒绝时请联系租户 Owner。</div>
            : <SectionLoader text="正在加载组织" />
        ) : (
          <>
            <Card style={CARD_BODY}>
              <div style={cardHeadStyle}>
                <h2 style={SECTION_TITLE}>成员</h2>
                <div style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, flexWrap: 'wrap' }}>
                  {/* 角色说明放在卡片头而不是 <th> 里：表格外层是 overflow-x:auto，
                      一旦某个轴不是 visible，另一个轴就按 auto 计算，浮层会被纵向裁掉
                      （实测第 5 个角色 Billing 被切掉一半）。 */}
                  <span style={countStyle}>角色<RoleHelp align="end" /></span>
                  <span style={countStyle}>{data.members.length} 人</span>

                </div>
              </div>
              {data.members.length > 10 || memberSearch ? <input className="lg-member-search" aria-label="搜索成员姓名或账号" value={memberSearch} onChange={event => setMemberSearch(event.target.value)} placeholder="搜索成员姓名或账号" style={FIELD_INPUT} /> : null}
              {!visibleMembers.length ? <div role="status">{memberSearch ? '没有匹配的成员，请更换姓名或账号。' : '当前范围还没有成员。'}</div> : null}
              <div className="lg-members-desktop" style={{ overflowX: 'auto' }}>
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
                    {visibleMembers.map((member) => {
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
                              label={member.status === 'active' ? '启用' : member.status === 'disabled' ? '已停用' : member.status || '未知'}
                              color={member.status === 'active' ? 'var(--ok)' : 'var(--warn)'}
                              bg={member.status === 'active' ? 'var(--ok-bg)' : 'var(--warn-bg)'}
                            />
                          </td>
                          <td style={{ ...TABLE_CELL, textAlign: 'right' }}>
                            {editable ? (
                              <>
                                <Button size="sm" variant="ghost" disabled={busy || pageUnknown || reading} onClick={() => setDrawer({ mode: 'edit', member })}>编辑</Button>
                                <Button size="sm" variant="ghost" disabled={busy || pageUnknown || reading} onClick={() => void removeMember(member)}>移出</Button>
                              </>
                            ) : (
                              // 「不能在这里修改自己」原本是条死路：成员区确实不该改自己的角色，
                              // 但用户真正想改的口令当时也无处可去。指到账号页，路才通。
                              selfLocked ? (
                                <Link to="/account" style={{ ...HINT_TEXT, whiteSpace: 'nowrap', color: 'var(--accent)' }}>
                                  管自己的口令去「账号与安全」
                                </Link>
                              ) : (
                                <span style={{ ...HINT_TEXT, whiteSpace: 'nowrap' }}>
                                  {ownerLocked ? '只有 Owner 可以修改 Owner' : '只读'}
                                </span>
                              )
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="lg-members-mobile">
                {visibleMembers.map(member => {
                  const ownerLocked = member.role === 'owner' && currentRole !== 'owner';
                  const selfLocked = Boolean(user?.username && member.username === user.username);
                  const editable = canManage && !ownerLocked && !selfLocked;
                  return <article key={member.id} data-testid={`member-mobile-${member.id}`}>
                    <div className="lg-member-heading"><strong>{member.displayName || member.username || member.userId}</strong><Chip label={member.status === 'active' ? '启用' : member.status === 'disabled' ? '已停用' : member.status || '未知'} color={member.status === 'active' ? 'var(--ok)' : 'var(--warn)'} bg={member.status === 'active' ? 'var(--ok-bg)' : 'var(--warn-bg)'} /></div>
                    <div>{roleLabel(member.role)} · <code>{member.username || member.userId}</code></div>
                    <div>团队：{member.teamIds.map(id => data.teams.find(team => team.id === id)?.name || '未知团队').join('、') || '未加入团队'}</div>
                    <div className="lg-member-actions">{editable ? <><Button size="sm" variant="ghost" disabled={busy || pageUnknown || reading} onClick={() => setDrawer({ mode: 'edit', member })}>编辑成员</Button><Button size="sm" variant="ghost" disabled={busy || pageUnknown || reading} onClick={() => void removeMember(member)}>移出</Button></> : selfLocked ? <Link to="/account">账号与安全</Link> : <span>{ownerLocked ? '只有 Owner 可以修改 Owner' : '只读'}</span>}</div>
                  </article>;
                })}
              </div>
            </Card>

            <Card style={CARD_BODY}>
              <div style={cardHeadStyle}>
                <h2 style={SECTION_TITLE}>团队</h2>
                <span style={countStyle}>{data.teams.length} 个</span>
              </div>
              {data.teams.length === 0 ? (
                <Prose style={{ marginBottom: GAP.section }}>还没有团队。团队把成员、appCaller 和接入密钥放进同一工作范围。</Prose>
              ) : (
                <div className="lg-team-list">
                  {data.teams.map((team) => {
                    const chip = <span>{team.name}{team.status !== 'active' ? '（已停用）' : ''}</span>;
                    if (!canManage) return <span key={team.id}>{chip}</span>;
                    return (
                      <span key={team.id} className="lg-team-item">
                        <button
                          type="button"
                          aria-label={`重命名团队 ${team.name}`}
                          title="点击重命名"
                          disabled={busy || pageUnknown || reading}
                          onClick={() => void renameTeam(team)}
                          className="lg-team-rename"
                        >
                          {chip}<Pencil size={13} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          aria-label={`删除团队 ${team.name}`}
                          title="删除团队"
                          disabled={busy || pageUnknown || reading}
                          onClick={() => void removeTeam(team)}
                          style={{ border: 'none', background: 'none', padding: 4, minWidth: 32, minHeight: 32, cursor: 'pointer', lineHeight: 0, color: 'var(--text-muted)' }}
                        >
                          <Trash2 size={12} />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
              {canManage ? (
                <FormGrid>
                  <label style={FIELD_LABEL}>
                    <span>团队名称</span>
                    <input disabled={busy || pageUnknown || reading} value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="客服组" style={FIELD_INPUT} />
                  </label>
                  <Button size="sm" disabled={busy || pageUnknown || reading || teamName.trim().length < 2} onClick={() => void addTeam()}>创建团队</Button>
                </FormGrid>
              ) : null}
            </Card>

            {canCreateTenant ? <DetailsBlock title="租户管理">
              <code style={MONO_META}>{data.tenant?.id}</code>
              <div style={{ display: 'flex', gap: GAP.normal, flexWrap: 'wrap', marginTop: GAP.normal }}>
                <Button size="sm" variant="secondary" disabled={busy || pageUnknown || reading} onClick={() => setTenantDialogOpen(true)}><Plus size={14} />新建租户</Button>
                {data.tenant ? <Button size="sm" variant="ghost" disabled={busy || pageUnknown || reading} onClick={() => void removeTenant()}><Trash2 size={14} />删除租户</Button> : null}
              </div>
            </DetailsBlock> : null}
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
        />
      ) : null}

      {tenantDialogOpen ? (
        <TenantDialog onClose={() => setTenantDialogOpen(false)} />
      ) : null}
    </PageShell>
  );
}

/**
 * 成员抽屉：新增与编辑共用一套表单。
 * 走既有的 .lg-side-drawer-* 结构（与 App 详情抽屉同款），不另造一套浮层。
 */
/**
 * 抽屉自己持有失败信息（Codex P2）。
 *
 * 此前失败一律 `onError` 抛给页面，而页面那条 alert 渲染在 PageBody 里、被固定定位的
 * 抽屉与毛玻璃背板整块盖住：用户只看到表单停止 busy，没有任何可读的失败原因。
 * 抽屉 body 里本来就有 InlineAlert 的用法（校验提示），失败信息归到同一处即可。
 */
function MemberDrawer({ mode, member, teams, tenantSlug, currentRole, onClose, onDone }: {
  mode: 'create' | 'edit';
  member?: MemberItem;
  teams: TeamItem[];
  tenantSlug?: string;
  currentRole: string;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [resultUnknown, setResultUnknown] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [memberInitialPassword, setMemberInitialPassword] = useState('');
  const [memberRole, setMemberRole] = useState<MemberRole>((member?.role as MemberRole) ?? 'viewer');
  const [status, setStatus] = useState<'active' | 'disabled'>(member?.status === 'disabled' ? 'disabled' : 'active');
  const { confirm } = useDialogs();
  const [memberTeamIds, setMemberTeamIds] = useState<string[]>(member?.teamIds ?? []);
  const [busy, setBusy] = useState(false);

  const dialogRef = useRef<HTMLElement>(null);
  const closeDrawer = () => { if (resultUnknown) void onDone('成员操作结果未确认，请核对列表中的账号、角色和团队。'); else onClose(); };
  useDialogFocus(dialogRef, closeDrawer, busy, '[data-member-primary]');
  const failWrite = (error: { code?: string; message?: string }) => {
    if (unknownWrite(error.code)) { setResultUnknown(true); setFailure('操作结果未确认，可能已生效。已保留本次输入，请返回列表核对，勿重复提交。'); }
    else setFailure(error.message || '操作被拒绝');
  };

  const isCreate = mode === 'create';
  const selected = memberTeamIds;
  const who = member ? (member.displayName || member.username || member.userId) : '';
  const selectedDisabledTeams = memberTeamIds.filter((teamId) => teams.some((team) => team.id === teamId && team.status !== 'active'));
  const missingDeveloperTeam = memberRole === 'developer' && memberTeamIds.length === 0;
  const usernameOk = USERNAME_PATTERN.test(username.trim());
  const blocked = busy || resultUnknown
    || missingDeveloperTeam
    || (isCreate ? (!usernameOk || memberInitialPassword.length < 12) : selectedDisabledTeams.length > 0);

  const toggleTeam = (teamId: string) => setMemberTeamIds((current) =>
    current.includes(teamId) ? current.filter((id) => id !== teamId) : [...current, teamId]);

  const submit = async () => {
    if (busy || resultUnknown) return;
    setBusy(true);
    setFailure(null);
    if (isCreate) {
      const response = await observedWrite(createMember({
        username: username.trim(),
        displayName: displayName.trim() || undefined,
        initialPassword: memberInitialPassword || undefined,
        role: memberRole,
        teamIds: memberTeamIds,
      }));
      setBusy(false);
      if (!response.success) { failWrite(response.error); return; }
      invalidateOnboardingCache();
      await onDone(response.data.idempotentReplay
        ? '该成员已存在，现有成员关系保持不变'
        : `新成员账号 ${response.data.username} 已创建；首次登录时必须设置自己的密码`);
      return;
    }
    if (!member) return;
    const request: UpdateMemberRequest = { expectedVersion: member.version, role: memberRole, status, teamIds: memberTeamIds };
    const response = await observedWrite(updateMember(member.id, request));
    setBusy(false);
    if (!response.success) { failWrite(response.error); return; }
    // 改成员和建成员是同一份事实的两个方向：新人清单的「拉一个成员」只数 active，
    // 把唯一一个额外成员停用后这一步应当重新亮起。此前只在创建路径失效，
    // 于是 60 秒内回到概览仍认为这一步完成、清单已经消失（Codex P2）。
    invalidateOnboardingCache();
    await onDone(`成员“${who}”已更新`);
  };

  const invalidate = async () => {
    if (!member || busy || resultUnknown) return;
    if (!await confirm({ title: `让“${who}”的现有登录立即失效？`, description: '该成员需要重新登录。', tone: 'danger', confirmLabel: '强制重新登录' })) return;
    setBusy(true);
    setFailure(null);
    const response = await observedWrite(invalidateMemberSessions(member.id));
    setBusy(false);
    if (!response.success) { failWrite(response.error); return; }
    await onDone(`成员“${who}”需要重新登录`);
  };

  return createPortal(
    <div className="lg-side-drawer-portal">
      <button className="lg-side-drawer-backdrop" type="button" aria-label="关闭" disabled={busy} onClick={closeDrawer} />
      <aside ref={dialogRef} tabIndex={-1} className="lg-side-drawer" role="dialog" aria-modal="true" aria-label={isCreate ? '添加成员' : `编辑成员 ${who}`}>
        <header className="lg-side-drawer-header">
          <div className="lg-side-drawer-title">
            <span className="lg-side-drawer-icon">{isCreate ? <UserPlus size={17} /> : <Save size={17} />}</span>
            <div><small>{isCreate ? '添加成员' : '编辑成员'}</small><h2>{isCreate ? '新成员账号' : who}</h2></div>
          </div>
          <button type="button" aria-label="关闭" disabled={busy} onClick={closeDrawer}><X size={18} /></button>
        </header>

        <div className="lg-side-drawer-body" data-testid={isCreate ? 'member-create' : undefined}>
          {failure ? <InlineAlert tone="error">{failure}</InlineAlert> : null}
          {resultUnknown ? <Button variant="ghost" onClick={closeDrawer}>返回列表核对</Button> : null}
          <fieldset disabled={busy || resultUnknown} style={{ margin: 0, padding: 0, border: 0, minWidth: 0, display: 'grid', gap: GAP.section }}>
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
          </fieldset>
        </div>

        <div className="lg-side-drawer-footer">
          <Button size="sm" variant="primary" disabled={blocked} onClick={() => void submit()}>
            {isCreate ? <UserPlus size={13} /> : <Save size={13} />}{busy ? '正在提交…' : isCreate ? '创建成员账号' : '保存成员范围'}
          </Button>
          {!isCreate ? (
            <Button size="sm" variant="ghost" disabled={busy || resultUnknown} onClick={() => void invalidate()}><RotateCcw size={13} />强制重新登录</Button>
          ) : null}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

/** 新建租户：从页头操作区打开，只有 Owner 能看到（沿用原 canCreateTenant 门控）。 */
/** 同 MemberDrawer：失败信息留在抽屉内，页面级 alert 在这里是看不见的（Codex P2）。 */
function TenantDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [resultUnknown, setResultUnknown] = useState(false);
  const [createdTenantId, setCreatedTenantId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, onClose, busy);

  const submit = async () => {
    if (busy || resultUnknown) return;
    setBusy(true); setFailure(null);
    let targetId = createdTenantId;
    if (!targetId) {
      const created = await observedWrite(createTenant({ name: name.trim(), slug: slug.trim().toLowerCase() }));
      if (!created.success) {
        setBusy(false);
        if (unknownWrite(created.error.code)) { setResultUnknown(true); setFailure('创建结果未确认，可能已生效。请重新加载控制台，在组织切换器中核对，勿重复创建。'); }
        else setFailure(created.error.message);
        return;
      }
      targetId = created.data.id; setCreatedTenantId(targetId);
    }
    const switched = await observedWrite(switchTenant(targetId));
    setBusy(false);
    if (!switched.success) { setFailure('租户已创建，但切换未完成。' + switched.error.message); return; }
    setSession(switched.data); window.location.reload();
  };

  return createPortal(
    <div className="lg-side-drawer-portal">
      <button className="lg-side-drawer-backdrop" type="button" aria-label="关闭" disabled={busy} onClick={onClose} />
      <aside ref={dialogRef} tabIndex={-1} className="lg-side-drawer" role="dialog" aria-modal="true" aria-label="新建租户">
        <header className="lg-side-drawer-header">
          <div className="lg-side-drawer-title">
            <span className="lg-side-drawer-icon"><KeyRound size={17} /></span>
            <div><small>新建租户</small><h2>独立的数据与预算边界</h2></div>
          </div>
          <button type="button" aria-label="关闭" disabled={busy} onClick={onClose}><X size={18} /></button>
        </header>
        <div className="lg-side-drawer-body">
          {failure ? <InlineAlert tone="error">{failure}</InlineAlert> : null}
          <Prose>新租户有独立的数据、预算、密钥和审计。创建后你会成为 Owner 并自动切换过去。</Prose>
          {resultUnknown ? <Button variant="ghost" onClick={() => window.location.reload()}>重新加载核对租户</Button> : null}
          <fieldset disabled={busy || resultUnknown || !!createdTenantId} style={{ margin: 0, padding: 0, border: 0, minWidth: 0, display: 'grid', gap: GAP.section }}>
          <label style={FIELD_LABEL}>
            <span>租户名称</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="教程咖啡店" style={FIELD_INPUT} />
          </label>
          <label style={FIELD_LABEL}>
            <span>Slug</span>
            <input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="tutorial-coffee" style={FIELD_INPUT} />
          </label>
          </fieldset>
        </div>
        <div className="lg-side-drawer-footer">
          <Button size="sm" variant="primary" disabled={busy || resultUnknown || name.trim().length < 2 || slug.trim().length < 2} onClick={() => void submit()}>
            <Plus size={13} />{busy ? '正在提交…' : createdTenantId ? '切换到已创建租户' : '创建并切换'}
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
