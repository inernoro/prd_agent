// 接入密钥。
//
// 按「控制台风格调性 v1.2」原则 6 / 7 迁移（详见
// doc/rule.platform.llm-gateway.console-design-tonality.md）：
//   - 走 PageShell / PageHeader / PageBody 骨架。原来是自造的 .lg-service-key-heading
//     页头（icon + .lg-title + 一排链接），与其余页面各长各的。
//   - 文字预算：迁移前 4 段 / 446 汉字。appCaller、协议、scope 怎么填与轮换怎么走
//     收进字段旁的 HelpPopover；legacy 收口的判定规则收进它自己的 HelpPopover；
//     「MAP 为什么仍能调用」「轮换的边界」收进默认收起的 DetailsBlock 并深链教程第 15 章。
//   - **本路由 /service-keys 被 e2e/llmgw-layout-drift.mjs 监测**：新建表单必须保持
//     内联 + 扁平 DOM，不许改成抽屉或对话框（这一点与预算与用量页不同，那条路由未被监测）。
//   - var(--danger) 在 theme.css 里**从未定义过**，本页原有 6 处引用：`color` 那几处整条
//     声明作废（报错文字根本没变红），通配确认框那处更是连 color-mix 底色和边框一起丢了。
//     语义色只有 --ok / --warn / --err / --info，全部改过来——边框底色重新出现是修复，不是回归。
import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Plus, RefreshCw, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { confirmServiceKeyClientCutover, createGatewayAppCaller, createServiceKey, getGatewayAppCallers, getLegacyKeyCutover, getOrganization, getServiceKeys, revokeServiceKey, updateLegacyKeyCutover } from '@/lib/api';
import { useDialogs } from '@/components/ConfirmDialog';
import { useAuth } from '@/lib/auth';
import { invalidateOnboardingCache } from '@/lib/onboarding';
import type { CreatedServiceKey, LegacyKeyCutoverData, OrganizationData, ServiceKeyItem } from '@/lib/types';
import { Button, Chip, InlineAlert, SectionLoader } from '@/components/ui';
import { DetailsBlock, FormGrid, HelpPopover, PageBody, PageHeader, PageShell, Prose, TutorialLink } from '@/components/PageShell';
import { canCreateWildcardServiceKey, canUseCapability } from '@/lib/access';
import { CARD_BODY, GAP, INSET_PADDING } from '@/lib/surface';
import { BODY_TEXT, FIELD_INPUT, FIELD_LABEL, HINT_TEXT, MONO_META, SECTION_TITLE, TABLE_CELL, TABLE_HEAD_CELL } from '@/lib/typography';

const DEFAULT_PROTOCOLS = 'gw-native, openai-compatible, claude-compatible, gemini-compatible';
const DEFAULT_SCOPES = 'invoke, stream:invoke, route:read';

/**
 * appCallerCode 是网关内部标识（`{app-key}.{feature}::{chat|vision}`），不是用户该背下来的东西。
 * 页面只问两件用户自己知道的事——「这把钥匙给谁用」（密钥名称，已经推出 clientCode）
 * 与「用来做什么」——再由 buildAppCallerCode 拼出标识，拼完当场显示（`minimal-user-input.md`
 * 第 3 条：推断出来的值必须可见、可改）。此前这里是一个裸输入框，默认值直接填当前租户
 * 观测到的第一条 code（截图里是 `ai-toolbox.agent.::generation`，还带着一个空段），
 * 用户既看不懂也没法判断该不该改。
 */
type SelfServiceRequestType = 'chat' | 'vision';

const REQUEST_TYPES: Array<{ id: SelfServiceRequestType; label: string }> = [
  { id: 'chat', label: '文字对话' },
  { id: 'vision', label: '图片理解' },
];

/** 用途预设：datalist 建议值，用户也能自己写。value 进 appCallerCode，label 是中文说明。 */
const FEATURE_PRESETS: Array<{ value: string; label: string }> = [
  { value: 'desktop', label: '桌面客户端' },
  { value: 'agent', label: 'Agent 调用' },
  { value: 'automation', label: '自动化脚本' },
  { value: 'analytics', label: '数据分析' },
  { value: 'integration', label: '系统集成' },
  { value: 'testing', label: '联调测试' },
];

const FALLBACK_FEATURE = 'access';
const FALLBACK_APP_SEGMENT = 'external-client';
/** 与 console-api 的 IsValidSelfServiceAppCaller 同一口径：段内只允许小写字母、数字和短横线。 */
const SELF_SERVICE_APP_CALLER = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+::(chat|vision)$/;

/** 出口一：一把 key 的作用域怎么定、协议和 scope 怎么填、轮换怎么走。 */
function ScopeHelp() {
  return (
    <HelpPopover label="密钥作用域">
      <dl>
        <dt>调用用途 appCaller</dt>
        <dd>决定这把 key 能调用哪项业务。一把 key 只在这里列出的调用用途内有效，换一项业务要换一把。</dd>
        <dt>标识怎么来的</dt>
        <dd>由密钥名称推出的 clientCode、你填的用途和调用类型拼成 {'{app-key}.{feature}::{chat|vision}'}，创建时一并登记。想复用已登记的调用用途就切到「选择已有」。</dd>
        <dt>用途写的是中文时</dt>
        <dd>标识里的段只收拉丁字母，中文压不出来，所以会多问你要一个短英文名。这一段系统无从得知：若替你挑一个通用词，所有同样情况的登记会拼出同一条 code，而登记对同团队同码是幂等复用的——不同集成于是共用一条路由身份与一份预算，页面上还看不出来。</dd>
        <dt>入口协议</dt>
        <dd>客户端用哪种协议发请求就列哪种，默认给全 {DEFAULT_PROTOCOLS} 四种。</dd>
        <dt>Scope</dt>
        <dd>invoke 普通调用、stream:invoke 流式调用、route:read 路由预检，按最小必要保留。</dd>
        <dt>轮换</dt>
        <dd>轮换会再发一把并行有效的新 key；确认客户端全部切过去之后，旧 key 才允许撤销。</dd>
      </dl>
    </HelpPopover>
  );
}

export function ServiceKeysPage() {
  const { tenant } = useAuth();
  const { confirm } = useDialogs();
  const isInternalTenant = tenant?.isInternal === true;
  // Developer 的密钥必须绑团队（服务端硬性要求），Owner/Admin 留空则是租户级密钥。
  const isDeveloper = tenant?.role === 'developer';
  const canManageLegacyCutover = canUseCapability(tenant?.role, 'configWrite');
  const [items, setItems] = useState<ServiceKeyItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [created, setCreated] = useState<CreatedServiceKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [sourceSystem, setSourceSystem] = useState('external');
  const [clientCode, setClientCode] = useState('');
  const [environment, setEnvironment] = useState('production');
  const [purpose, setPurpose] = useState<'runtime' | 'release-gate' | 'canary' | 'external-platform'>('external-platform');
  const [appCallerMode, setAppCallerMode] = useState<'generate' | 'existing'>('generate');
  const [appCallerFeature, setAppCallerFeature] = useState('');
  // 用途写的是中文时，标识里那一段拼不出来——由用户在这里给一个短英文名。
  const [identitySlug, setIdentitySlug] = useState('');
  const [appCallerRequestType, setAppCallerRequestType] = useState<SelfServiceRequestType>('chat');
  const [appCallerCodes, setAppCallerCodes] = useState('');
  const [teams, setTeams] = useState<OrganizationData['teams']>([]);
  const [ingressProtocols, setIngressProtocols] = useState(DEFAULT_PROTOCOLS);
  const [scopes, setScopes] = useState(DEFAULT_SCOPES);
  const [expiresAt, setExpiresAt] = useState('');
  const [teamId, setTeamId] = useState('');
  const [allowedCidrs, setAllowedCidrs] = useState('');
  const [rateLimitPerMinute, setRateLimitPerMinute] = useState('');
  const [rotatesKeyId, setRotatesKeyId] = useState<string | undefined>();
  const [confirmWildcardRisk, setConfirmWildcardRisk] = useState(false);
  /** 只喂下拉与补全。签发前的「存不存在、什么状态」现问服务端，不看这一页（见 submit）。 */
  const [knownAppCallers, setKnownAppCallers] = useState<string[]>([]);
  const [legacy, setLegacy] = useState<LegacyKeyCutoverData | null>(null);
  const [legacyDeadline, setLegacyDeadline] = useState('');
  const [legacyAllowedCallers, setLegacyAllowedCallers] = useState('');
  const [legacySuccessorIds, setLegacySuccessorIds] = useState('');
  const [legacyRequired, setLegacyRequired] = useState('1');
  const [legacyStatus, setLegacyStatus] = useState<'observing' | 'ready' | 'revoked'>('observing');
  const [legacyBusy, setLegacyBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const res = await getServiceKeys();
    if (res.success) setItems(res.data);
    else setError(res.error?.message || '加载接入密钥失败');
    if (canManageLegacyCutover) {
      const legacyRes = await getLegacyKeyCutover();
      if (legacyRes.success && legacyRes.data.applicable) {
        setLegacy(legacyRes.data);
        setLegacyStatus(legacyRes.data.status === 'not-applicable' ? 'observing' : legacyRes.data.status);
        setLegacyDeadline(legacyRes.data.deadlineAt ? toLocalInput(legacyRes.data.deadlineAt) : '');
        setLegacyAllowedCallers(legacyRes.data.allowedAppCallerCodes.join(', '));
        setLegacySuccessorIds(legacyRes.data.successorServiceKeyIds.join(', '));
        setLegacyRequired(String(legacyRes.data.requiredSuccessorObservations));
      }
    }
  }, [canManageLegacyCutover]);

  useEffect(() => {
    void load();
    void getGatewayAppCallers({ page: 1, pageSize: 200 }).then((res) => {
      if (res.success) {
        // 这一页只喂给「手选已有用途」的下拉与补全，不参与签发前的判定：
        // 那是一页有上限的列表，用它判「这个码存不存在 / 是什么状态」在用途多过一页的
        // 租户上必然判错，所以签发那一步改成现问服务端（见 submit）。
        const codes = Array.from(new Set(res.data.items.map((item) => item.appCallerCode))).sort();
        setKnownAppCallers(codes);
        setAppCallerCodes((current) => current || codes[0] || '');
      }
    });
    // 团队只用来回答「这条调用用途登记在谁名下」。以前这里是一个让人手抄 team id 的
    // 输入框，没人知道该填什么；现在读回真实团队列表做下拉，空值仍然表示租户级密钥。
    void getOrganization().then((res) => {
      if (res.success) setTeams(res.data.teams.filter((team) => team.status === 'active'));
    });
  }, [load]);

  const submit = async () => {
    setCreating(true);
    setError(null);
    // 自动生成的调用用途在签发密钥之前先登记：密钥的 appCaller 允许清单是精确匹配，
    // 登记之后这条用途才会出现在「调用方」页上，能绑模型池、能被 Quickstart 直测
    // （直测对未登记的 code 返回 APP_CALLER_NOT_FOUND）。登记失败就不签发，
    // 免得留下一把指向无主 code 的密钥。
    /*
      「这个码此刻是什么状态」必须现问服务端，不能翻手上那一页。
      页面开屏拉的是第一页（上限 200 条），租户的调用用途多过这个数时，一条**已停用**的同码
      落在页外就查不到：状态判空 → 这道闸整条跳过 → 幂等创建把那条停用的原样返回 → 密钥照签，
      而 serving 当场回 APP_CALLER_DISABLED。判据只覆盖了「最直观的那一页」，
      正是 predicate-and-wiring-discipline 形状 1；而它上一轮刚被我按同一个理由修过一次。
      顺带把「要不要登记」也改由这一次探测回答：两个判断问同一个来源，不会一个说有、一个说没有。
    */
    let existingCaller: { appCallerCode: string; status: string } | undefined;
    if (appCallerMode === 'generate') {
      const probe = await getGatewayAppCallers({ page: 1, pageSize: 200, search: generatedAppCallerCode });
      if (!probe.success) {
        setCreating(false);
        setError(`没能确认调用用途「${generatedAppCallerCode}」当前是什么状态（${probe.error?.message || '读取失败'}），密钥未创建。`
          + '这一步不敢猜：万一它已被停用，签出来的密钥一调用就会被拒。请重试，或先去「调用用途」页确认。');
        return;
      }
      existingCaller = probe.data.items.find(
        (item) => item.appCallerCode.trim().toLowerCase() === generatedAppCallerCode.trim().toLowerCase());
      // 与 serving 的 GatewayAppCallerPolicy 同一套枚举：只有这三种状态放行真实流量。
      const existingStatus = existingCaller?.status;
      if (existingStatus !== undefined
        && !['discovered', 'configured', 'active'].includes(existingStatus.trim().toLowerCase())) {
        setCreating(false);
        setError(`调用用途「${generatedAppCallerCode}」已存在但处于「${existingStatus}」状态，不接受流量。`
          + '先去「调用用途」把它恢复，或换一个用途名——现在签出来的密钥一调用就会被拒。');
        return;
      }
    }
    if (appCallerMode === 'generate' && !existingCaller) {
      if (!appCallerTeamId) {
        setCreating(false);
        setError('当前租户还没有可用团队，无法登记调用用途。请先在组织与团队里建一个团队。');
        return;
      }
      const callerRes = await createGatewayAppCaller({
        teamId: appCallerTeamId,
        appCallerCode: generatedAppCallerCode,
        requestType: appCallerRequestType,
        title: name.trim() || generatedAppCallerCode,
        ingressProtocol: 'openai-compatible',
      });
      if (!callerRes.success) {
        setCreating(false);
        setError(callerRes.error?.message || '登记调用用途失败，密钥未创建');
        return;
      }
      setKnownAppCallers((current) => current.includes(generatedAppCallerCode) ? current : [...current, generatedAppCallerCode].sort());
    }
    const res = await createServiceKey({
      name: name.trim(),
      sourceSystem: sourceSystem.trim(),
      clientCode: clientCode.trim().toLowerCase(),
      environment,
      purpose,
      appCallerCodes: effectiveAppCallerCodes,
      ingressProtocols: splitValues(ingressProtocols),
      scopes: splitValues(scopes),
      // 留空 = 租户级密钥，这是有意的语义，对 Owner/Admin 保持不变。
      // 唯独 Developer 不允许租户级：服务端只在「刚好一个团队」时替他推断，
      // 多团队的 Developer 留空会被 TEAM_SCOPE_REQUIRED 挡在这一步，而上面那条
      // 调用用途已经登记出去了——留下一条没有密钥的孤儿登记。所以这里替他补上
      // 与登记用途同一个团队，两个请求落在同一个归属上。
      teamId: teamId.trim() || (isDeveloper ? appCallerTeamId : '') || undefined,
      allowedCidrs: splitValues(allowedCidrs),
      rateLimitPerMinute: rateLimitPerMinute ? Number(rateLimitPerMinute) : undefined,
      rotatesKeyId,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      confirmWildcardRisk,
    });
    setCreating(false);
    if (!res.success) {
      setError(res.error?.message || '创建接入密钥失败');
      return;
    }
    setCreated(res.data);
    // 新人清单的「签一把密钥」与老手轨的密钥前缀都读缓存，签发成功必须主动失效，
    // 否则已挂载的组件会一直显示旧事实（60 秒 TTL 只在下次加载才被查）。
    invalidateOnboardingCache(tenant?.id);
    setShowCreate(false);
    setName('');
    setClientCode('');
    // 复位回默认路径，但 MAP 身份没有自助登记这一档，留在「选择已有」。
    setAppCallerMode(sourceIsMap ? 'existing' : 'generate');
    setAppCallerFeature('');
    // 标识跟着用途一起清。留着它，下一次新建时它会顶上那个还没填的用途段——
    // code 拼得出来、按钮可点，用户以为自己填过了；名称也是中文的话还会拼出与上一把
    // 完全相同的 code，于是两把钥匙静默共用一条路由身份与一份预算。
    setIdentitySlug('');
    setAppCallerCodes('');
    setTeamId('');
    setAllowedCidrs('');
    setRateLimitPerMinute('');
    setRotatesKeyId(undefined);
    setConfirmWildcardRisk(false);
    setExpiresAt('');
    await load();
  };

  const revoke = async (item: ServiceKeyItem) => {
    if (!await confirm({ title: `撤销接入密钥「${item.name}」？`, description: '撤销后使用它的客户端会立即收到 401。', tone: 'danger', confirmLabel: '撤销' })) return;
    setBusyId(item.id);
    const res = await revokeServiceKey(item.id);
    setBusyId(null);
    if (!res.success) {
      setError(res.error?.message || '撤销接入密钥失败');
      return;
    }
    // 撤销和签发是同一份事实的两个方向：撤掉最后一把可用密钥后，新人清单的
    // 「签一把密钥」必须重新亮起、老手轨的前缀必须消失。此前只在创建路径失效，
    // 于是撤销后 60 秒内回到 Quickstart 仍显示已撤销的前缀（Codex P2）。
    invalidateOnboardingCache(tenant?.id);
    await load();
  };

  const copyCreatedKey = async () => {
    if (!created) return;
    await navigator.clipboard.writeText(created.key);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const confirmClientCutover = async (item: ServiceKeyItem) => {
    if (!await confirm({ title: `确认「${item.name}」的客户端已经全部切换到新密钥？`, description: '确认后旧密钥进入可撤销状态。', confirmLabel: '已全部切换' })) return;
    setBusyId(item.id);
    const res = await confirmServiceKeyClientCutover(item.id);
    setBusyId(null);
    if (!res.success) {
      setError(res.error?.message || '确认客户端切换失败');
      return;
    }
    await load();
  };

  const startRotation = (item: ServiceKeyItem) => {
    setName(`${item.name} rotation`);
    setSourceSystem(item.sourceSystem);
    setClientCode(item.clientCode);
    setEnvironment(item.environment === 'unknown' ? 'production' : item.environment);
    setPurpose(item.purpose);
    // 轮换是把同一份身份再发一次，调用用途必须逐字沿用旧钥，不能重新生成一条。
    setAppCallerMode('existing');
    setAppCallerCodes(item.appCallerCodes.join(', '));
    setIngressProtocols(item.ingressProtocols.join(', '));
    setScopes(item.scopes.join(', '));
    setTeamId(item.teamId || '');
    setAllowedCidrs(item.allowedCidrs.join(', '));
    setRateLimitPerMinute(item.rateLimitPerMinute ? String(item.rateLimitPerMinute) : '');
    setRotatesKeyId(item.id);
    setConfirmWildcardRisk(false);
    setShowAdvanced(true);
    setShowCreate(true);
  };

  const updateName = (value: string) => {
    const previousAutomaticClientCode = normalizeClientCode(name);
    setName(value);
    if (!rotatesKeyId) {
      setClientCode((current) => !current || current === previousAutomaticClientCode ? normalizeClientCode(value) : current);
    }
  };

  const toggleCreate = () => {
    setShowCreate((current) => {
      if (!current) setShowAdvanced(false);
      return !current;
    });
  };

  // 生成态下这把钥匙只授权一条调用用途；选择已有时仍支持逗号分隔的多条。
  const generatedAppCallerCode = buildAppCallerCode(clientCode || normalizeClientCode(name), appCallerFeature, appCallerRequestType, identitySlug);
  const generatedAppCallerValid = SELF_SERVICE_APP_CALLER.test(generatedAppCallerCode) && generatedAppCallerCode.length <= 200;
  // 用途栏里那句话拼不出拉丁字母（中文用途最常见）时，标识就缺一段。这一段系统无从得知，
  // 只能由用户给——摆出来让他填，而不是替他挑一个常量（那会让不同集成共用一条身份）。
  const needsIdentitySlug = appCallerMode === 'generate' && !toAppCallerSegment(appCallerFeature);
  const effectiveAppCallerCodes = appCallerMode === 'generate' ? [generatedAppCallerCode] : splitValues(appCallerCodes);
  // 登记归属：优先密钥自己选的团队，其次当前身份唯一的团队，最后租户里第一个可用团队。
  // 三者都取不到就是「租户还没有团队」，提交时明确报出来，不静默失败。
  // 先用当前身份自己的团队，再兜租户的第一个团队：Developer 只能给自己所在团队登记，
  // 拿租户列表的第一个会被服务端以 TEAM_SCOPE_DENIED 挡回来。
  const appCallerTeamId = teamId.trim() || tenant?.teamIds[0] || teams[0]?.id || '';
  const appCallerTeamName = teams.find((team) => team.id === appCallerTeamId)?.name || appCallerTeamId;
  const usesWildcard = sourceSystem.trim() === '*'
    || effectiveAppCallerCodes.includes('*')
    || splitValues(ingressProtocols).includes('*')
    || splitValues(scopes).includes('*');
  const sourceIsMap = sourceSystem.trim().toLowerCase() === 'map';
  const purposeMatchesSource = sourceIsMap ? purpose !== 'external-platform' : purpose === 'external-platform';
  const purposeMatchesTenant = isInternalTenant || (!sourceIsMap && purpose === 'external-platform');
  const canCreateWildcard = canCreateWildcardServiceKey(tenant?.role);
  const canSubmit = name.trim() && sourceSystem.trim() && /^[a-z][a-z0-9._-]{1,79}$/.test(clientCode.trim().toLowerCase()) && environment && effectiveAppCallerCodes.length
    && (appCallerMode !== 'generate' || generatedAppCallerValid)
    && splitValues(ingressProtocols).length && splitValues(scopes).length
    && purposeMatchesSource && purposeMatchesTenant && (!usesWildcard || canCreateWildcard && confirmWildcardRisk);
  const updateSourceSystem = (value: string) => {
    setSourceSystem(value);
    const nextIsMap = value.trim().toLowerCase() === 'map';
    if (nextIsMap && purpose === 'external-platform') setPurpose('runtime');
    if (!nextIsMap && purpose !== 'external-platform') setPurpose('external-platform');
    // 自助登记只收 ::chat / ::vision 两种后缀，而 MAP 内部身份用的是 ::generation、
    // ::intent 这些内部类型，只能引用已登记的 code —— 切到 map 就锁回「选择已有」。
    if (nextIsMap) setAppCallerMode('existing');
  };
  const activeKeys = (items ?? []).filter((item) => item.enabled);
  const mapCoverage = (['runtime', 'release-gate', 'canary'] as const).map((requiredPurpose) => ({
    purpose: requiredPurpose,
    ready: activeKeys.some((item) => item.sourceSystem.toLowerCase() === 'map' && item.environment === 'production' && item.purpose === requiredPurpose),
  }));
  const externalIdentities = Array.from(new Set(activeKeys
    .filter((item) => item.purpose === 'external-platform')
    .map((item) => `${item.clientCode} · ${item.environment}`)));

  const saveLegacyCutover = async () => {
    if (!canManageLegacyCutover || !legacyDeadline) return;
    if (legacyStatus === 'revoked' && !await confirm({ title: '确认撤销 legacy shared key？', description: '撤销后旧 key 将立即返回 401，且必须已有 scoped key 双 key 观测。', tone: 'danger', confirmLabel: '撤销' })) return;
    setLegacyBusy(true);
    const res = await updateLegacyKeyCutover({
      status: legacyStatus,
      deadlineAt: new Date(legacyDeadline).toISOString(),
      allowedAppCallerCodes: splitValues(legacyAllowedCallers),
      successorServiceKeyIds: splitValues(legacySuccessorIds),
      requiredSuccessorObservations: Math.max(1, Number(legacyRequired) || 1),
    });
    setLegacyBusy(false);
    if (!res.success) {
      setError(res.error?.message || '更新 legacy 收口策略失败');
      return;
    }
    await load();
  };

  const renderActions = (item: ServiceKeyItem) => item.enabled ? <div className="lg-service-key-actions">
    {item.rotationState === 'active' || item.rotationState === 'completed' ? <Button size="sm" variant="ghost" onClick={() => startRotation(item)}>轮换</Button> : null}
    {item.rotationState === 'awaiting-client-cutover' ? <Button size="sm" variant="ghost" disabled={busyId === item.id} onClick={() => void confirmClientCutover(item)}>确认已切换</Button> : null}
    <Button size="sm" variant="ghost" disabled={busyId === item.id || item.rotationState === 'awaiting-client-cutover' || item.rotationState === 'client-switched' && Boolean(item.rotatesKeyId) && !item.rotatedByKeyId} onClick={() => void revoke(item)}>{item.rotationState === 'client-switched' && item.rotatedByKeyId ? '撤销旧钥并完成' : item.rotationState === 'client-switched' ? '等待旧钥撤销' : '撤销'}</Button>
  </div> : null;

  return (
    <PageShell>
      <PageHeader
        title="接入密钥"
        subtitle="给外部系统发一把限定调用范围的密钥。"
        summary={items ? (
          <>
            <span>密钥 <strong>{items.length}</strong></span>
            <span>有效 <strong>{activeKeys.length}</strong></span>
            {externalIdentities.length ? <span>外部身份 <strong>{externalIdentities.length}</strong></span> : null}
          </>
        ) : undefined}
        actions={(
          <>
            <Link className="lg-text-link" to="/organization">组织与团队</Link>
            <Link className="lg-text-link" to="/quickstart">Quickstart</Link>
            <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw size={14} />刷新</Button>
            <Button size="sm" variant="primary" onClick={toggleCreate}>
              {showCreate ? <X size={14} /> : <Plus size={14} />}{showCreate ? '取消' : '新建密钥'}
            </Button>
          </>
        )}
      />

      <PageBody>
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}

        {created ? (
          <div style={createdPanelStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, marginBottom: GAP.normal }}>
              <strong style={SECTION_TITLE}>密钥已创建，仅本次显示</strong>
              <Button size="sm" variant="ghost" style={{ marginLeft: 'auto' }} onClick={() => setCreated(null)}><X size={14} /></Button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, flexWrap: 'wrap' }}>
              <code style={createdKeyStyle}>{created.key}</code>
              <Button size="sm" onClick={() => void copyCreatedKey()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制' : '复制'}</Button>
              <Link className="lg-text-link" to="/quickstart">打开 Quickstart</Link>
            </div>
          </div>
        ) : null}

        {showCreate ? (
          <div className="lg-service-key-form">
            <div className="lg-service-key-fast-fields">
              <Field label="密钥名称" value={name} onChange={updateName} placeholder="例如 cherry-studio" />
              {appCallerMode === 'generate' ? (
                <label style={labelStyle}>
                  <span>用来做什么<ScopeHelp /></span>
                  <div className="lg-service-key-caller-inputs">
                    <input
                      list="llmgw-app-caller-features"
                      value={appCallerFeature}
                      onChange={(event) => setAppCallerFeature(event.target.value)}
                      placeholder="例如 桌面客户端 / agent"
                      aria-label="调用用途"
                      style={inputStyle}
                    />
                    <select value={appCallerRequestType} onChange={(event) => setAppCallerRequestType(event.target.value as SelfServiceRequestType)} aria-label="调用类型" style={inputStyle}>
                      {REQUEST_TYPES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                    </select>
                  </div>
                  {needsIdentitySlug ? (
                    <div className="lg-service-key-identity-slug">
                      <input
                        value={identitySlug}
                        onChange={(event) => setIdentitySlug(event.target.value)}
                        placeholder="例如 desktop-client"
                        aria-label="调用身份的英文标识"
                        style={inputStyle}
                      />
                      <small style={BODY_TEXT}>这一段拼不出来，你来定。</small>
                    </div>
                  ) : null}
                </label>
              ) : (
                <label style={labelStyle}>
                  <span>调用用途<ScopeHelp /></span>
                  <input list="llmgw-app-callers" value={appCallerCodes} onChange={(event) => setAppCallerCodes(event.target.value)} placeholder={knownAppCallers.length ? '选择已有业务调用身份' : '尚无调用用途，可切回自动生成'} style={inputStyle} />
                </label>
              )}
              <datalist id="llmgw-app-callers">{knownAppCallers.map((code) => <option key={code} value={code} />)}</datalist>
              <datalist id="llmgw-app-caller-features">{FEATURE_PRESETS.map((item) => <option key={item.value} value={item.value} label={item.label} />)}</datalist>
              <div className="lg-service-key-fast-action"><Button variant="primary" disabled={!canSubmit || creating} onClick={() => void submit()}>{creating ? '创建中' : '生成 API Key'}</Button></div>
            </div>
            {/*
              自动设置这一行是「系统替你填了什么」的唯一交代口：clientCode、生成出来的
              appCallerCode、登记到哪个团队都摆在这里，用户不必点开高级设置就能核对，
              不同意就用行尾那个开关切到「选择已有」。
            */}
            <div className="lg-service-key-defaults">
              <span>自动设置</span>
              <strong>{clientCode || '根据名称生成 clientCode'}</strong>
              {appCallerMode === 'generate'
                ? <strong className="lg-service-key-generated-caller">{generatedAppCallerCode || '还差一个英文标识'}</strong>
                : null}
              {appCallerMode === 'generate' && appCallerTeamName ? <span>登记到 {appCallerTeamName}</span> : null}
              <span>生产环境</span>
              <span>四种兼容协议</span>
              <span>普通、流式调用与路由预检</span>
              {appCallerMode === 'generate'
                ? <button type="button" className="lg-text-link lg-service-key-caller-switch" onClick={() => setAppCallerMode('existing')}>选择已有调用用途</button>
                : null}
              {appCallerMode === 'existing' && rotatesKeyId ? <span>轮换沿用旧钥的调用用途</span> : null}
              {appCallerMode === 'existing' && !rotatesKeyId && sourceIsMap ? <span>MAP 身份只引用已登记的调用用途</span> : null}
              {appCallerMode === 'existing' && !rotatesKeyId && !sourceIsMap
                ? <button type="button" className="lg-text-link lg-service-key-caller-switch" onClick={() => setAppCallerMode('generate')}>改回按用途自动生成</button>
                : null}
            </div>
            <details open={showAdvanced} onToggle={(event) => setShowAdvanced(event.currentTarget.open)} className="lg-service-key-advanced">
              <summary>高级权限与安全设置</summary>
              <div className="lg-service-key-advanced-grid">
                {isInternalTenant
                  ? <Field label="Source system" value={sourceSystem} onChange={updateSourceSystem} placeholder="external；内部 MAP 填 map" />
                  : <label style={labelStyle}><span>Source system</span><input aria-label="Source system" value="external" readOnly style={inputStyle} /><span style={BODY_TEXT}>外部租户身份由服务端固定，不能伪装为 MAP。</span></label>}
                <Field label="Client code" value={clientCode} onChange={setClientCode} placeholder="例如 content-agent" />
                <label style={labelStyle}><span>环境</span><select value={environment} onChange={(event) => setEnvironment(event.target.value)} style={inputStyle}><option value="development">开发</option><option value="test">测试</option><option value="staging">预发布</option><option value="production">生产</option></select></label>
                {isInternalTenant
                  ? <label style={labelStyle}><span>用途</span><select value={purpose} onChange={(event) => setPurpose(event.target.value as typeof purpose)} style={inputStyle}><option value="runtime">MAP runtime</option><option value="release-gate">发布 Gate</option><option value="canary">Canary</option><option value="external-platform">外部平台</option></select></label>
                  : <label style={labelStyle}><span>用途</span><input aria-label="用途" value="external-platform" readOnly style={inputStyle} /></label>}
                <Field label="入口协议" value={ingressProtocols} onChange={setIngressProtocols} placeholder="openai-compatible" />
                <Field label="Scopes" value={scopes} onChange={setScopes} placeholder="invoke, route:read" />
                <label style={labelStyle}>
                  <span>团队</span>
                  <select value={teamId} onChange={(event) => setTeamId(event.target.value)} style={inputStyle}>
                    <option value="">租户级（不绑定团队）</option>
                    {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
                    {teamId && !teams.some((team) => team.id === teamId) ? <option value={teamId}>{teamId}</option> : null}
                  </select>
                </label>
                <Field label="来源 CIDR（可选）" value={allowedCidrs} onChange={setAllowedCidrs} placeholder="10.20.0.0/16, 2001:db8::/32" />
                <Field label="每分钟上限（可选）" value={rateLimitPerMinute} onChange={setRateLimitPerMinute} placeholder="例如 60" type="number" />
                <label style={labelStyle}><span>过期时间</span><input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} style={inputStyle} /></label>
              </div>
            </details>
            {!purposeMatchesSource ? <InlineAlert tone="error">MAP 只能使用 runtime、release-gate 或 canary；其他来源只能使用 external-platform。</InlineAlert> : null}
            {usesWildcard && canCreateWildcard ? (
              <label style={wildcardStyle}>
                <input type="checkbox" checked={confirmWildcardRisk} onChange={(event) => setConfirmWildcardRisk(event.target.checked)} />
                <span><strong>确认创建通配密钥</strong><br />该密钥的来源、appCaller、协议或 scope 含通配符，权限范围明显扩大。</span>
              </label>
            ) : null}
            {usesWildcard && !canCreateWildcard ? <InlineAlert tone="error">Developer 只能创建明确限定 appCaller、协议和 scope 的团队密钥。</InlineAlert> : null}
            {rotatesKeyId ? <Prose>正在轮换 {rotatesKeyId}，新旧密钥并行有效。</Prose> : null}
          </div>
        ) : null}

        {items ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: GAP.normal }}>
          {isInternalTenant ? <div style={coverageCardStyle}>
            <strong style={SECTION_TITLE}>MAP 生产 key 覆盖</strong>
            <div style={chipRowStyle}>{mapCoverage.map((item) => <Chip key={item.purpose} label={`${item.purpose} ${item.ready ? '已独立' : '缺失'}`} color={item.ready ? 'var(--ok)' : 'var(--warn)'} bg={item.ready ? 'var(--ok-bg)' : 'var(--warn-bg)'} />)}</div>
            <p style={{ ...BODY_TEXT, margin: `${GAP.normal}px 0 0` }}>runtime、release-gate、canary 各用一把 production scoped key。</p>
          </div> : null}
          <div style={coverageCardStyle}>
            <strong style={SECTION_TITLE}>外部平台独立身份</strong>
            <div style={chipRowStyle}>{externalIdentities.length ? externalIdentities.map((item) => <Chip key={item} label={item} color="var(--text-secondary)" bg="var(--bg-elevated)" />) : <span style={HINT_TEXT}>暂无外部平台 key</span>}</div>
            <p style={{ ...BODY_TEXT, margin: `${GAP.normal}px 0 0` }}>每个 clientCode 与环境各一把 key，不跨 purpose 或 environment。</p>
          </div>
        </div> : null}

        {legacy ? <details style={legacyBlockStyle}>
          <summary style={legacySummaryStyle}>Legacy shared key 收口 · {legacy.status} · 后继观测 {legacy.successorObservedCount}/{legacy.requiredSuccessorObservations}</summary>
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.section, flexWrap: 'wrap', marginTop: GAP.section }}>
            <span style={HINT_TEXT}>
              收口判定
              <HelpPopover label="legacy 收口">
                外部来源使用 legacy key 永远拒绝；到达截止时间或状态为 revoked 后旧 key 返回 401。
                每把后继 key 必须是 production MAP runtime 身份，并完整覆盖调用方、四协议和运行时 scope；
                只有真实业务调用观测达标才能显式撤销。
              </HelpPopover>
            </span>
            <span style={HINT_TEXT}>必需协议 {legacy.requiredIngressProtocols.join(', ')} · 必需 scope {legacy.requiredScopes.join(', ')}</span>
          </div>
          <FormGrid style={{ marginTop: GAP.normal }}>
            <label style={labelStyle}><span>截止时间</span><input type="datetime-local" value={legacyDeadline} onChange={(e) => setLegacyDeadline(e.target.value)} style={inputStyle} /></label>
            <label style={labelStyle}><span>状态</span><select value={legacyStatus} onChange={(e) => setLegacyStatus(e.target.value as typeof legacyStatus)} style={inputStyle}><option value="observing">观测中</option><option value="ready">待撤销</option><option value="revoked">已撤销</option></select></label>
            <Field label="允许的 appCaller 清单" value={legacyAllowedCallers} onChange={setLegacyAllowedCallers} placeholder="逗号分隔；空表示先盘点" />
            <Field label="后继 scoped key IDs" value={legacySuccessorIds} onChange={setLegacySuccessorIds} placeholder="逗号分隔" />
            <Field label="最低观测次数" value={legacyRequired} onChange={setLegacyRequired} placeholder="1" type="number" />
            <Button variant="primary" size="sm" disabled={legacyBusy || !legacyDeadline} onClick={() => void saveLegacyCutover()}>{legacyBusy ? '保存中' : '保存收口策略'}</Button>
          </FormGrid>
          {legacy.usage.length ? <div style={{ overflowX: 'auto', marginTop: GAP.section }}><table className="lg-data-table" style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr>{['来源', 'appCaller', '协议', '允许', '拒绝', '最后出现', '决定'].map((label) => <th key={label} style={th}>{label}</th>)}</tr></thead><tbody>{legacy.usage.map((item) => <tr key={`${item.sourceSystem}-${item.appCallerCode}-${item.ingressProtocol}`}><td style={td}>{item.sourceSystem}</td><td style={td}>{item.appCallerCode || '缺失'}</td><td style={td}>{item.ingressProtocol}</td><td style={td}>{item.allowedCount}</td><td style={td}>{item.rejectedCount}</td><td style={td}>{formatTime(item.lastSeenAt)}</td><td style={td}>{item.lastDecision}</td></tr>)}</tbody></table></div> : null}
        </details> : null}

        {!items ? <SectionLoader text="正在加载接入密钥" /> : items.length === 0 ? (
          <div className="lg-service-key-empty">
            <KeyRound size={24} />
            <strong>当前租户还没有外部接入密钥</strong>
            <p style={BODY_TEXT}>外部系统要有一把租户密钥才能调用 Gateway，明文只显示一次。</p>
            <Button variant="primary" onClick={() => setShowCreate(true)}><Plus size={14} />创建第一把密钥</Button>
          </div>
        ) : (
          <>
          <div className="lg-service-key-desktop" style={tableFrameStyle}>
            <table className="lg-service-key-table lg-data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-surface)' }}><tr>
                {['API Key', '客户端', 'AppCaller 与权限', '团队', '最后使用', '过期', '状态', ''].map((label) => <th key={label} style={th}>{label}</th>)}
              </tr></thead>
              <tbody>{items.map((item) => <tr key={item.id}>
                <td style={td}><strong>{item.name}</strong><div style={mutedMono}>{item.keyPrefix} · {rotationLabel(item.rotationState)}</div></td>
                <td style={td}><strong>{item.clientCode}</strong><div style={mutedMono}>{item.environment} · {item.sourceSystem}</div></td>
                <td style={td}>{item.appCallerCodes.join(', ')}<details className="lg-service-key-permissions"><summary>查看权限</summary><div>协议：{item.ingressProtocols.join(', ')}</div><div>Scope：{item.scopes.join(', ')}</div><div>网络：{item.allowedCidrs.length ? item.allowedCidrs.join(', ') : '不限 CIDR'} · {item.rateLimitPerMinute ? `${item.rateLimitPerMinute}/分钟` : '不限速'}</div></details></td>
                <td style={td}>{item.teamId || '租户级'}<div style={mutedMono}>{item.createdByUsername || '历史密钥'}</div></td>
                <td style={td}>{formatTime(item.lastUsedAt)}</td>
                <td style={td}>{formatTime(item.expiresAt)}</td>
                <td style={td}><Chip label={item.enabled ? '有效' : '已撤销'} color={item.enabled ? 'var(--ok)' : 'var(--text-muted)'} bg={item.enabled ? 'var(--ok-bg)' : 'var(--bg-elevated)'} /></td>
                <td style={{ ...td, textAlign: 'right' }}>{renderActions(item)}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <div className="lg-service-key-mobile">
            {items.map((item) => <article key={item.id} className="lg-service-key-card">
              <div className="lg-service-key-card-heading">
                <div><strong>{item.name}</strong><code>{item.keyPrefix}</code></div>
                <Chip label={item.enabled ? '有效' : '已撤销'} color={item.enabled ? 'var(--ok)' : 'var(--text-muted)'} bg={item.enabled ? 'var(--ok-bg)' : 'var(--bg-elevated)'} />
              </div>
              <div className="lg-service-key-card-identity">
                <span>工作负载身份</span>
                <strong>{item.clientCode}</strong>
                <small>{item.environment} · {item.purpose} · {item.sourceSystem}</small>
              </div>
              <dl>
                <div><dt>轮换阶段</dt><dd>{rotationLabel(item.rotationState)}{item.rotatedByKeyId ? <small>新钥 {item.rotatedByKeyId}</small> : null}</dd></div>
                <div><dt>AppCaller</dt><dd>{item.appCallerCodes.join(', ')}</dd></div>
                <div><dt>团队 / 创建者</dt><dd>{item.teamId || '租户级'}<small>{item.createdByUsername || '历史密钥'}</small></dd></div>
                <div><dt>最后使用</dt><dd>{formatTime(item.lastUsedAt)}<small>过期：{formatTime(item.expiresAt)}</small></dd></div>
              </dl>
              <details className="lg-service-key-permissions"><summary>查看协议、Scope 和网络限制</summary><div>协议：{item.ingressProtocols.join(', ')}</div><div>Scope：{item.scopes.join(', ')}</div><div>网络：{item.allowedCidrs.length ? item.allowedCidrs.join(', ') : '不限 CIDR'} · {item.rateLimitPerMinute ? `${item.rateLimitPerMinute}/分钟` : '不限速'}</div></details>
              {renderActions(item)}
            </article>)}
          </div>
          </>
        )}

        <DetailsBlock title="工作原理：谁在用这把 key，轮换到哪一步才算完">
          <Prose>
            MAP 等平台内部服务使用部署级内部身份，不属于当前租户的外部密钥，既不出现在本列表，也不能交给外部系统。
            轮换期间新旧密钥并行有效，只有确认客户端全部切换后才允许撤销旧密钥，避免调用中断。
          </Prose>
          <TutorialLink chapter="chapter-15">查看教程：第 15 章 接入密钥</TutorialLink>
        </DetailsBlock>
      </PageBody>
    </PageShell>
  );
}

function Field({ label, value, onChange, placeholder, type = 'text', list }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; type?: string; list?: string }) {
  return <label style={labelStyle}><span>{label}</span><input type={type} list={list} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={inputStyle} /></label>;
}

function splitValues(value: string) {
  return value.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
}

function normalizeClientCode(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 80);
  return normalized.length >= 2 ? normalized : FALLBACK_APP_SEGMENT;
}

/**
 * 把一段人写的文字压成 appCallerCode 的一节。段内只允许 `[a-z][a-z0-9-]*`——
 * clientCode 允许的点和下划线在这里都是非法字符，必须换成短横线，否则拼出来的 code
 * 会被 console-api 的 IsValidSelfServiceAppCaller 挡回来。
 *
 * 压不出合法段时返回空串，**不**替用户挑一个常量：那样两套毫不相干的中文集成
 * （「桌面客户端」与「数据同步」都拼不出拉丁字母）会一起塌成同一个
 * `external-client.access::chat`，而登记端点对同团队同码是幂等复用的——
 * 于是它们共用一条路由身份与一份预算，谁超了都算在对方头上，页面上还看不出来。
 * 拼不出来的那一段由用户自己给（见 identitySlug），这是系统无从得知的信息。
 */
function toAppCallerSegment(value: string) {
  const normalized = value.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return /^[a-z][a-z0-9-]*$/.test(normalized) ? normalized : '';
}

/**
 * 用户填的是「谁用、干什么、什么类型」，网关要的是这串标识，由这里唯一负责拼装。
 * `slug` 是用户为「拼不出拉丁字母」那一半自己给的名字：只有 app 段缺时它顶 app 段，
 * 只有 feature 段缺时它顶 feature 段，两段都缺时它顶 app 段、feature 段用通用词——
 * 此时区分度由 app 段承担，不同集成不会再撞成同一条身份。
 */
function buildAppCallerCode(clientCode: string, feature: string, requestType: SelfServiceRequestType, slug: string) {
  const app = toAppCallerSegment(clientCode);
  const featureSegment = toAppCallerSegment(feature);
  const slugSegment = toAppCallerSegment(slug);
  if (app && featureSegment) return `${app}.${featureSegment}::${requestType}`;
  if (!slugSegment) return '';
  if (app) return `${app}.${slugSegment}::${requestType}`;
  if (featureSegment) return `${slugSegment}.${featureSegment}::${requestType}`;
  return `${slugSegment}.${FALLBACK_FEATURE}::${requestType}`;
}

function formatTime(value?: string | null) {
  if (!value) return '未设置';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function toLocalInput(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function rotationLabel(state: string) {
  return ({
    active: '未轮换',
    'new-key-created': '新钥已创建',
    'awaiting-client-cutover': '等待客户端切换',
    'client-switched': '客户端已切换',
    'old-key-revoked': '旧钥已撤销',
    completed: '轮换完成',
    revoked: '已撤销',
  } as Record<string, string>)[state] || state;
}

const labelStyle: React.CSSProperties = FIELD_LABEL;
const inputStyle: React.CSSProperties = FIELD_INPUT;
const th: React.CSSProperties = TABLE_HEAD_CELL;
const td: React.CSSProperties = { ...TABLE_CELL, maxWidth: 260, verticalAlign: 'top', wordBreak: 'break-word' };
const mutedMono: React.CSSProperties = { ...MONO_META, marginTop: 3 };

/** 卡片外观：内边距只允许 CARD_PADDING(14) 或 INSET_PADDING(10)，别再各拍一个数。 */
const surfaceCardStyle: React.CSSProperties = {
  ...CARD_BODY,
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius)',
  background: 'var(--bg-surface)',
};
const coverageCardStyle: React.CSSProperties = surfaceCardStyle;
const legacyBlockStyle: React.CSSProperties = surfaceCardStyle;
const chipRowStyle: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: GAP.tight, marginTop: GAP.normal };
const legacySummaryStyle: React.CSSProperties = {
  cursor: 'pointer',
  color: 'var(--text-primary)',
  fontSize: 'var(--fs-heading)',
  fontWeight: 650,
};
const tableFrameStyle: React.CSSProperties = {
  overflow: 'auto',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius)',
  background: 'var(--bg-surface)',
};
/** 新建成功面板：原来是写死的 rgba(63,185,80,…)，现在走 --ok 语义色。 */
const createdPanelStyle: React.CSSProperties = {
  ...CARD_BODY,
  border: '1px solid color-mix(in srgb, var(--ok) 32%, transparent)',
  borderRadius: 'var(--radius)',
  background: 'var(--ok-bg)',
};
const createdKeyStyle: React.CSSProperties = {
  ...MONO_META,
  flex: 1,
  minWidth: 0,
  overflow: 'auto',
  padding: INSET_PADDING,
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-input)',
};
/**
 * 通配确认框：原来写 `color-mix(in srgb, var(--danger) 10%, transparent)`，
 * 而 --danger 从未定义 —— 整条 background 声明作废（有定义所以 var() 的 fallback 也不触发），
 * 这个警告框长期连底色和边框都没有。改成 --err 后它们会重新出现，这是修复。
 */
const wildcardStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: GAP.normal,
  padding: INSET_PADDING,
  color: 'var(--err)',
  background: 'color-mix(in srgb, var(--err) 10%, transparent)',
  border: '1px solid var(--err)',
  borderRadius: 'var(--radius-sm)',
  fontSize: 'var(--fs-body)',
  lineHeight: 'var(--lh-body)',
};
