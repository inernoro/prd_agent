// 自助接入：选客户端 → 生成接入配置 → 自动验证。
//
// 按「控制台风格调性 v1.2」原则 6 / 7 迁移（详见
// doc/rule.platform.llm-gateway.console-design-tonality.md）：
//   - 走 PageShell 骨架、贴边全宽；此前整页固定 1080 居中，宽屏两侧空转。
//     去掉居中必须和「成句段落改走 <Prose>」同批做，否则段落会横跨整屏。
//   - 文字预算：此前 9 段 / 607 汉字，基准页（请求记录）是 1 段 / 220 字。
//     原来的三张步骤卡整卡都是解释句，已删——它们讲的事现在由页顶的接入清单
//     用真实状态代替口头描述；三个身份、失败定位、试跑口径这些成段解释收进
//     默认收起的 DetailsBlock 并深链教程，剩下的常驻文案逐句压到标签级长度。
//   - 四协议接入片段（cURL / 环境变量 / 技能文件 / 客户端配置）是产品内容不是
//     解释，逐字保留；本页大量标识符与请求头被 GatewayDataDomainGuardTests 按
//     字面量断言（见 scripts/check-source-contracts.mjs），改名前先跑那个守卫。
import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, CheckCircle2, Copy, FileCode2, KeyRound, Play } from 'lucide-react';
import { Link } from 'react-router-dom';
import { bulkClaimConfigAuthority, createGatewayAppCaller, createServiceKey, ensurePoolTypes, getOrganization, getPools, getPoolTypes, updateGatewayAppCaller } from '@/lib/api';
import type { OrganizationData } from '@/lib/types';
import { Button, Card, Chip, ReadOnlyNotice, SectionLoader } from '@/components/ui';
import { AccessSnippetBar } from '@/components/AccessSnippetBar';
import { DetailsBlock, PageBody, PageHeader, PageShell, TutorialLink } from '@/components/PageShell';
import { invalidateOnboardingCache, markRequestCompleted } from '@/lib/onboarding';
import { useDialogs } from '@/components/ConfirmDialog';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';
import { CARD_BODY, GAP } from '@/lib/surface';
import { BODY_TEXT, FIELD_INPUT, FIELD_LABEL, SECTION_TITLE } from '@/lib/typography';

type Protocol = 'native' | 'openai' | 'claude' | 'gemini';
type RequestType = 'chat' | 'vision';
type SnippetTab = 'client' | 'curl' | 'env' | 'skill';
type TestMode = 'safe' | 'real';
type ClientPresetId = 'api' | 'cherry-studio' | 'openclaw';

type RoutePreview = {
  success: boolean;
  checkedBaseUrl: string;
  errorMessage?: string;
  resolutionType?: string;
  actualModel?: string;
  actualPlatformId?: string;
  actualPlatformName?: string;
  platformType?: string;
  protocol?: string;
  apiUrl?: string;
  modelGroupId?: string;
  modelGroupName?: string;
  healthStatus?: string;
};

type ProtocolDefinition = {
  id: Protocol;
  label: string;
  path: string;
  ingressProtocol: 'gw-native' | 'openai-compatible' | 'claude-compatible' | 'gemini-compatible';
};

type AccessBundle = {
  key: string;
  keyId: string;
  keyPrefix: string;
  appCallerId: string;
  appCallerCode: string;
  requestType: RequestType;
  clientCode: string;
  environment: string;
  teamId: string;
  clientPreset: ClientPresetId;
};

type DisplayBundle = AccessBundle & {
  protocol: Protocol;
  baseUrl: string;
};

const PROTOCOLS: ProtocolDefinition[] = [
  { id: 'native', label: 'GW Native', path: '/gw/v1/invoke', ingressProtocol: 'gw-native' },
  { id: 'openai', label: 'OpenAI', path: '/v1/chat/completions', ingressProtocol: 'openai-compatible' },
  { id: 'claude', label: 'Claude', path: '/v1/messages', ingressProtocol: 'claude-compatible' },
  { id: 'gemini', label: 'Gemini', path: '/v1beta/models/auto:generateContent', ingressProtocol: 'gemini-compatible' },
];

const CLIENT_PRESETS: Array<{
  id: ClientPresetId;
  label: string;
  description: string;
  clientCode: string | null;
  appCallerCode: string | null;
}> = [
  { id: 'api', label: 'API 与 Agent', description: '复制 cURL、环境变量或 Agent Skill。', clientCode: null, appCallerCode: null },
  { id: 'cherry-studio', label: 'Cherry Studio', description: '生成地址、API Key 和模型三项配置。', clientCode: 'cherry-studio', appCallerCode: 'cherry-studio.desktop::chat' },
  { id: 'openclaw', label: 'OpenClaw', description: '生成可直接粘贴的 provider 配置。', clientCode: 'openclaw-agent', appCallerCode: 'openclaw.gateway::chat' },
];

/**
 * 用途预设：显示中文、取值是英文段。
 *
 * 不能让用户直接把中文用途当 appCallerCode 的一段——`toAppCallerSegment` 会把 CJK
 * 全部替换掉，得到空串，于是「填了用途却仍然不合法」。这与 ServiceKeysPage 的
 * FEATURE_PRESETS 同一套解法：预设给合法取值，自定义那档才让人填英文。
 */
const PURPOSE_PRESETS: Array<{ code: string; label: string }> = [
  { code: 'quickstart', label: '通用接入' },
  { code: 'desktop', label: '桌面客户端' },
  { code: 'agent', label: 'Agent 调用' },
  { code: 'backend', label: '后端服务' },
  { code: 'batch', label: '批处理' },
  { code: 'custom', label: '其他' },
];

const REQUEST_TYPES: Array<{ id: RequestType; label: string; description: string }> = [
  { id: 'chat', label: '文字对话', description: '发送普通文字消息，适合问答、总结和 Agent 推理。' },
  { id: 'vision', label: '图片理解', description: '发送一张内嵌测试图片，验证多模态请求与 vision 策略链。' },
];

/**
 * 失败归因：一次调用要连过三环，坏在哪一环决定了下一步点什么。
 *
 * 判据取的是 serving 返回体里的 `error.code`（`{ code, message }`，见 GatewayHttpEndpoints
 * 的鉴权分支与 GatewayRouteFailure 常量），**不是按文案匹配**——文案会改，码是稳定契约。
 * 未登记的码退化成「未归类」，只报原文并给出 requestId，绝不猜一个看起来像的环节
 * （`no-rootless-tree.md`：归因必须有根）。
 */
type ChainLinkId = 'key' | 'scope' | 'pool';

const CHAIN_LINKS: Array<{ id: ChainLinkId; label: string }> = [
  { id: 'key', label: '密钥鉴权' },
  { id: 'scope', label: '团队与作用域' },
  { id: 'pool', label: '调用用途 → 模型池' },
];

type FailureRule = {
  /** 坏在哪一环；null 表示无法归因到某一环。 */
  brokenLink: ChainLinkId | null;
  title: string;
  reason: string;
  /** 下一步：页内动作用 action，跨页用 to。 */
  action?: 'bind-pool';
  to?: string;
  actionLabel: string;
};

const FAILURE_RULES: Record<string, FailureRule> = {
  GATEWAY_KEY_REQUIRED: { brokenLink: 'key', title: '请求没有带密钥', reason: '这条请求没有 Authorization 头，Gateway 在鉴权前就拒了。', to: '/service-keys', actionLabel: '打开接入密钥' },
  GATEWAY_KEY_INVALID: { brokenLink: 'key', title: '密钥无效或已撤销', reason: '这把密钥不在租户的有效密钥里。明文只在签发那一刻存在，找不回来，只能重签或轮换。', to: '/service-keys', actionLabel: '去签一把新密钥' },
  GATEWAY_KEY_EXPIRED: { brokenLink: 'key', title: '密钥已过期', reason: '这把密钥已过有效期，Gateway 直接返回 401。', to: '/service-keys', actionLabel: '去轮换密钥' },
  GATEWAY_KEY_DISABLED: { brokenLink: 'key', title: '密钥已停用', reason: '这把密钥被撤销或停用了。', to: '/service-keys', actionLabel: '打开接入密钥' },
  GATEWAY_KEY_SCOPE_DENIED: { brokenLink: 'scope', title: '密钥的授权范围不含这次请求', reason: '密钥授权的来源、调用用途、入口协议或 scope 与这次请求不匹配。', to: '/service-keys', actionLabel: '核对密钥授权范围' },
  GATEWAY_KEY_TEAM_MISMATCH: { brokenLink: 'scope', title: '密钥与调用用途不属于同一团队', reason: '这把密钥归属的团队不拥有这条调用用途。', to: '/organization', actionLabel: '打开组织与团队' },
  APP_CALLER_TEAM_MISMATCH: { brokenLink: 'scope', title: '调用用途已归属其他团队', reason: '同名调用用途已经登记在当前租户的另一个团队名下。', to: '/app-callers', actionLabel: '打开调用方' },
  GATEWAY_KEY_PURPOSE_DENIED: { brokenLink: 'scope', title: '密钥用途不允许数据面调用', reason: '这把密钥的 purpose 不允许发业务请求。', to: '/service-keys', actionLabel: '核对密钥用途' },
  GATEWAY_KEY_SOURCE_IP_DENIED: { brokenLink: 'scope', title: '来源 IP 不在密钥允许的网段', reason: '密钥限制了来源 CIDR，当前出口 IP 不在其中。', to: '/service-keys', actionLabel: '核对来源 CIDR' },
  APP_CALLER_DISABLED: { brokenLink: 'scope', title: '调用用途已被禁用', reason: '这条调用用途当前状态不允许调用。', to: '/app-callers', actionLabel: '打开调用方' },
  APP_CALLER_NOT_FOUND: { brokenLink: 'scope', title: '调用用途尚未登记', reason: '这条调用用途在当前租户里查不到，试跑要求它已登记。', to: '/app-callers', actionLabel: '打开调用方' },
  APPCALLER_POOL_UNBOUND: { brokenLink: 'pool', title: '安全试跑通过，真实模型调不通', reason: '这条调用用途还没有绑定模型池，Gateway 无处解析实际模型，因此只有 dry-run 能通过。', action: 'bind-pool', actionLabel: '给这个调用用途绑定模型池' },
  GATEWAY_CONFIG_UNAVAILABLE: { brokenLink: 'pool', title: '网关配置面暂时读不到', reason: '这次不是配置错，是配置面短暂不可读；稍后重试通常就好。', to: '/app-callers', actionLabel: '打开调用方' },
  ROUTE_CONFIG_INCOMPATIBLE: { brokenLink: 'pool', title: '所选模型池与这次请求不兼容', reason: '模型池类型或成员能力与这次请求的调用类型对不上。', to: '/pools', actionLabel: '打开模型池' },
  GATEWAY_KEY_RATE_LIMITED: { brokenLink: null, title: '触发了这把密钥的限流', reason: '密钥默认限制 60 次/分钟，稍后再试即可。', actionLabel: '' },
};

const TEST_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export function QuickstartPage() {
  const { tenant, user } = useAuth();
  const canCreateAccess = canUseCapability(tenant?.role, 'appCallerWrite') && canUseCapability(tenant?.role, 'serviceKeyWrite');
  const { confirm } = useDialogs();
  const canManagePromptPolicy = canUseCapability(tenant?.role, 'configWrite');
  const [clientPreset, setClientPreset] = useState<ClientPresetId>('api');
  const [protocol, setProtocol] = useState<Protocol>('openai');
  const [requestType, setRequestType] = useState<RequestType>('chat');
  const [baseUrl, setBaseUrl] = useState(resolveDefaultServingBaseUrl);
  const [appCallerCode, setAppCallerCode] = useState('my-agent.quickstart::chat');
  // 用途是这一页唯一「系统无从得知」的业务命名：调用用途码由它派生，不选不许创建。
  const [purpose, setPurpose] = useState('quickstart');
  const [customPurpose, setCustomPurpose] = useState('');
  const [appCallerCodeTouched, setAppCallerCodeTouched] = useState(false);
  const [clientCode, setClientCode] = useState('my-agent');
  const [environment, setEnvironment] = useState('test');
  const [teamId, setTeamId] = useState('');
  const [organization, setOrganization] = useState<OrganizationData | null>(null);
  const [organizationLoading, setOrganizationLoading] = useState(true);
  const [organizationError, setOrganizationError] = useState<string | null>(null);
  const [creatingStage, setCreatingStage] = useState<'app-caller' | 'key' | null>(null);
  const [bundle, setBundle] = useState<AccessBundle | null>(null);
  const [snippetTab, setSnippetTab] = useState<SnippetTab>('curl');
  const [testMode, setTestMode] = useState<TestMode>('safe');
  const [copied, setCopied] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [routeChecking, setRouteChecking] = useState(false);
  const [preparingRoute, setPreparingRoute] = useState(false);
  const [routePreview, setRoutePreview] = useState<RoutePreview | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // code 是归因的唯一入口（serving 的 error.code），message 只做兜底展示。
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; requestId?: string; code?: string }
    | null>(null);
  // 一键测试用的模型候选：只列该调用类型模型池里的成员，不让人随便填一个池外的模型。
  const [poolModels, setPoolModels] = useState<string[]>([]);
  const [poolName, setPoolName] = useState('');
  const [poolMemberCount, setPoolMemberCount] = useState(0);
  const [modelQuery, setModelQuery] = useState('');
  const [binding, setBinding] = useState(false);
  const [bindNotice, setBindNotice] = useState<string | null>(null);
  // 月预算是本页唯一要用户想的数字；单次预占上限由它派生（成对约束见 budgetPair）。
  const [budgetUsd, setBudgetUsd] = useState('');
  const [holdCapUsd, setHoldCapUsd] = useState('');

  const selectedProtocol = protocolDefinition(protocol);
  const selectedClient = CLIENT_PRESETS.find((item) => item.id === clientPreset) ?? CLIENT_PRESETS[0];
  /** 只有真有客户端配置页要填的预设才给「客户端配置」标签，避免与环境变量重复。 */
  const hasClientTab = (bundle?.clientPreset ?? clientPreset) !== 'api';
  const activeTeams = organization?.teams.filter((team) => team.status === 'active') ?? [];
  const selectedTeam = activeTeams.find((team) => team.id === teamId);
  const budgetPair = deriveBudgetPair(budgetUsd, holdCapUsd);
  // 输入框空着就是 auto；填了就必须是这个池里的健康成员，否则不让执行（选了也是白跑）。
  const testModel = modelQuery.trim() || 'auto';
  const modelValid = testModel === 'auto' || poolModels.includes(testModel);
  const modelHint = !modelValid
    ? '这个模型不在池内健康成员里，换一个或清空走 auto。'
    : poolModels.length === 0
      ? '池内暂无健康成员，走 auto。'
      : `「${poolName || '默认池'}」${poolMemberCount} 个成员中 ${poolModels.length} 个健康，可搜索。`;
  const purposeSegment = purpose === 'custom' ? toAppCallerSegment(customPurpose) : purpose;
  // 高级设置里手改过 appCallerCode 就以手改的为准，不再被用途覆盖（推断值可覆盖、覆盖后不回弹）。
  const derivedAppCallerCode = appCallerCodeTouched
    ? appCallerCode
    : `${toAppCallerSegment(clientCode) || 'my-agent'}.${purposeSegment || 'quickstart'}::${requestType}`;
  const purposeReady = appCallerCodeTouched
    ? isValidAppCaller(appCallerCode.trim(), requestType)
    : purposeSegment.length > 0;
  const identityLocked = Boolean(bundle) || creatingStage !== null;

  const currentUsername = user?.username ?? '';

  /**
   * 一键测试的模型候选：**只列这条 appCaller 真正会走的那个池的成员**。
   *
   * 不能把该类型下所有池的成员平铺出来——真实租户上那是 263 个，既没法选，
   * 也不符合「用户可选模型必须来自 AppCallerCode 获准的模型池」（`llm-gateway.md` 规则 1）。
   * 优先用路由预览回来的池（那才是运行时真会用的），拿不到就退回该类型的默认池。
   */
  useEffect(() => {
    if (!bundle) return;
    let active = true;
    void getPools(bundle.requestType).then((response) => {
      if (!active || !response.success) return;
      const pools = response.data.items;
      const routedPoolId = routePreview?.success ? routePreview.modelGroupId : undefined;
      const target = pools.find((pool) => pool.id === routedPoolId)
        ?? pools.find((pool) => pool.isDefaultForType)
        ?? null;
      const members = target?.models ?? [];
      // 只列健康成员（healthStatus 0 = healthy）：降级或不可用的成员选了也是白跑一次，
      // 真实租户上这个池有两百多个成员，把坏的也堆进候选只会让人更难挑。
      const healthy = members
        .filter((model) => model.healthStatus === 0 && model.modelId)
        .sort((a, b) => a.priority - b.priority)
        .map((model) => model.modelId);
      setPoolModels([...new Set(healthy)]);
      setPoolMemberCount(members.length);
      setPoolName(target?.name ?? '');
    });
    return () => { active = false; };
  }, [bundle?.appCallerId, bundle?.requestType, routePreview?.modelGroupId, routePreview?.success]);
  useEffect(() => {
    let active = true;
    void getOrganization().then((response) => {
      if (!active) return;
      setOrganizationLoading(false);
      if (!response.success) {
        setOrganizationError(response.error?.message || '加载当前租户与团队失败');
        return;
      }
      setOrganization(response.data);
      const activeTeamList = response.data.teams.filter((team) => team.status === 'active');
      const firstTeam = activeTeamList[0];
      // 密钥归团队，不归个人。默认团队取「当前登录的人所在的那个」——他多半就是要给
      // 自己团队开 key；取不到（联邦账号还没进成员表）才退回租户的第一个活跃团队。
      const me = response.data.members.find((member) => member.status === 'active'
        && member.username && member.username === currentUsername);
      const myTeam = me?.teamIds.find((id) => activeTeamList.some((team) => team.id === id));
      if (myTeam || firstTeam) setTeamId((current) => current || myTeam || firstTeam.id);
      const suggestedClient = normalizeClientCode(response.data.tenant?.slug || 'my-agent');
      setClientCode((current) => current === 'my-agent' ? suggestedClient : current);
      setAppCallerCode((current) => current === 'my-agent.quickstart::chat' ? `${suggestedClient}.quickstart::chat` : current);
    });
    return () => { active = false; };
  }, [currentUsername]);

  const displayBundle: DisplayBundle = {
    key: bundle?.key ?? '',
    keyId: bundle?.keyId ?? '',
    keyPrefix: bundle?.keyPrefix ?? 'gwk_',
    appCallerId: bundle?.appCallerId ?? '',
    protocol,
    baseUrl: baseUrl.replace(/\/$/, ''),
    appCallerCode: bundle?.appCallerCode ?? (derivedAppCallerCode.trim() || 'my-agent.quickstart::chat'),
    requestType: bundle?.requestType ?? requestType,
    clientCode: bundle?.clientCode ?? (clientCode.trim() || 'my-agent'),
    environment: bundle?.environment ?? environment,
    teamId: bundle?.teamId ?? teamId,
    clientPreset: bundle?.clientPreset ?? clientPreset,
  };
  const currentRoutePreview = routePreview?.checkedBaseUrl === normalizeBaseUrl(baseUrl) ? routePreview : null;
  const realRouteReady = !routeChecking && canRunRealTest(currentRoutePreview, baseUrl);
  const snippetMode: TestMode = testMode === 'real' && realRouteReady ? 'real' : 'safe';
  const snippets = useMemo(() => ({
    client: clientSetupSnippet(displayBundle),
    curl: exampleFor(displayBundle.protocol, displayBundle.requestType, displayBundle.baseUrl, displayBundle.appCallerCode, snippetMode, testModel),
    env: environmentSnippet(displayBundle),
    skill: agentSkillSnippet(displayBundle, snippetMode),
  }), [displayBundle.protocol, displayBundle.requestType, displayBundle.baseUrl, displayBundle.appCallerCode, displayBundle.key, displayBundle.clientCode, displayBundle.environment, displayBundle.clientPreset, snippetMode, testModel]);
  const visibleSnippet = snippets[snippetTab === 'client' && !hasClientTab ? 'curl' : snippetTab];

  const copyText = async (name: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(name);
    window.setTimeout(() => setCopied((current) => current === name ? null : current), 1600);
  };

  const createAccessBundle = async () => {
    const normalizedCode = derivedAppCallerCode.trim();
    const normalizedClient = clientCode.trim().toLowerCase();
    const normalizedBaseUrl = baseUrl.trim().replace(/\/$/, '');
    if (!teamId || !normalizedBaseUrl || !isValidAppCaller(normalizedCode, requestType) || !/^[a-z][a-z0-9._-]{1,79}$/.test(normalizedClient)) {
      setActionError(`请确认团队、Gateway 地址和 clientCode 有效，并让 appCallerCode 以 ::${requestType} 结尾。`);
      return;
    }
    if (budgetPair.error) {
      setActionError(budgetPair.error);
      return;
    }
    if (bundle && !await confirm({ title: '将签发一把新密钥', description: '现有密钥不会自动撤销。', confirmLabel: '继续签发' })) return;

    setActionError(null);
    setTestResult(null);
    setCreatingStage('app-caller');
    const callerResponse = await createGatewayAppCaller({
      teamId,
      appCallerCode: normalizedCode,
      requestType,
      title: `${normalizedClient} ${requestType === 'vision' ? '图片理解' : '文字对话'} Quickstart`,
      ingressProtocol: selectedProtocol.ingressProtocol,
    });
    if (!callerResponse.success) {
      setCreatingStage(null);
      setActionError(callerResponse.error?.message || '创建 appCaller 失败');
      return;
    }

    // 预算与负责人挂在 appCaller 上（密钥本身没有这两个字段）。放在签密钥之前：
    // 预算被后端拒收时还没有密钥生出来，不会留下一把「没有预算约束」的孤儿 key。
    const governance = await applyGovernance(callerResponse.data.id);
    if (governance) {
      setCreatingStage(null);
      setActionError(governance);
      return;
    }

    setCreatingStage('key');
    const keyResponse = await createServiceKey({
      name: `${normalizedClient}-quickstart`,
      sourceSystem: 'external',
      clientCode: normalizedClient,
      environment,
      purpose: 'external-platform',
      appCallerCodes: [normalizedCode],
      ingressProtocols: PROTOCOLS.map((item) => item.ingressProtocol),
      scopes: ['invoke', 'stream:invoke', 'route:read'],
      teamId,
      allowedCidrs: [],
      rateLimitPerMinute: 60,
    });
    setCreatingStage(null);
    if (!keyResponse.success) {
      setActionError(`appCaller 已就绪，但密钥签发失败：${keyResponse.error?.message || '未知错误'}。请先到接入密钥页确认是否已生成，再决定是否重试。`);
      return;
    }

    // 本页自己也签密钥：不失效的话，同页挂着的新人清单还在说「签一把密钥」，
    // 接入片段也还没有前缀 —— TTL 不会刷新已挂载的 hook（Codex P2）。
    invalidateOnboardingCache(tenant?.id);

    const nextBundle: AccessBundle = {
      key: keyResponse.data.key,
      keyId: keyResponse.data.id,
      keyPrefix: keyResponse.data.keyPrefix,
      appCallerId: callerResponse.data.id,
      appCallerCode: normalizedCode,
      requestType,
      clientCode: normalizedClient,
      environment,
      teamId,
      clientPreset,
    };
    setBundle(nextBundle);
    // 「API 与 Agent」这一档没有客户端配置页可填，clientSetupSnippet 会退化成环境变量，
    // 和「环境变量」标签一字不差。所以那一档直接落到 cURL，不摆一个重复的标签。
    setSnippetTab(clientPreset === 'api' ? 'curl' : 'client');
    void checkRealRoute(nextBundle);
    void runTest(nextBundle, 'safe');
  };

  /**
   * 把预算写到刚登记的 appCaller 上；返回 null 表示成功，否则返回要展示的错误。
   *
   * 这里**不写任何个人归属**：密钥的归属是团队（`teamId`），谁点的创建由服务端
   * 自己记进审计（`createdByUsername`），不需要也不应该让用户挑一个「负责人」。
   *
   * 预算必须成对提交：只给月预算而不给单次预占上限，console-api 会 400
   * （`ValidateBudgetConfiguration`），而库里真出现单边配置会让 serving 启动自检直接抛错。
   * 所以派生值由 `deriveBudgetPair` 统一算，且只在两个都成立时才进请求体。
   */
  const applyGovernance = async (appCallerId: string) => {
    if (budgetPair.monthly === null || budgetPair.hold === null) return null;
    const response = await updateGatewayAppCaller(appCallerId, {
      monthlyBudgetUsd: budgetPair.monthly,
      budgetReservationUsd: budgetPair.hold,
    });
    if (response.success) return null;
    return `调用用途已登记，但预算没写上：${response.error?.message || '未知错误'}。密钥尚未签发，改完再点一次即可。`;
  };

  const checkRealRoute = async (target = bundle) => {
    if (!target) return;
    setRouteChecking(true);
    setRoutePreview(null);
    setTestResult(null);
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    try {
      const response = await fetch(new URL('/gw/v1/resolve', `${normalizedBaseUrl}/`).toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${target.key}`,
          'Content-Type': 'application/json',
          'X-Gateway-Source': 'external',
          'X-Gateway-App-Caller': target.appCallerCode,
        },
        body: JSON.stringify({
          appCallerCode: target.appCallerCode,
          modelType: target.requestType,
          modelPolicy: 'auto',
          context: { sourceSystem: 'external' },
        }),
        credentials: 'omit',
      });
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok) {
        setRoutePreview({ success: false, checkedBaseUrl: normalizedBaseUrl, errorMessage: readErrorMessage(payload) || `路由预检失败，HTTP ${response.status}` });
        return;
      }
      setRoutePreview(normalizeRoutePreview(payload, normalizedBaseUrl) ?? { success: false, checkedBaseUrl: normalizedBaseUrl, errorMessage: 'Gateway 未返回可识别的路由结果' });
    } catch (error) {
      setRoutePreview({ success: false, checkedBaseUrl: normalizedBaseUrl, errorMessage: error instanceof Error ? error.message : '无法连接 Gateway' });
    } finally {
      setRouteChecking(false);
    }
  };

  const prepareRealRoute = async () => {
    if (!bundle || !tenant?.isInternal || preparingRoute) return;
    setPreparingRoute(true);
    setActionError(null);
    const claim = await bulkClaimConfigAuthority({ overwrite: false });
    if (!claim.success) {
      setPreparingRoute(false);
      setActionError(claim.error?.message || '复制现有可用上游配置失败');
      return;
    }
    const ensured = await ensurePoolTypes();
    if (!ensured.success) {
      setPreparingRoute(false);
      setActionError(ensured.error?.message || '准备默认模型池失败');
      return;
    }
    const targetType = ensured.data.types.items.find((item) => item.code === bundle.requestType);
    if (!targetType?.ready || !targetType.defaultPoolId) {
      setPreparingRoute(false);
      setActionError(`${requestTypeLabel(bundle.requestType)} 默认池仍没有可用真实模型。请在本页路由预览中确认缺口，再配置 Provider、模型和密钥。`);
      return;
    }
    const updated = await updateGatewayAppCaller(bundle.appCallerId, {
      status: 'configured',
      modelPoolId: targetType.defaultPoolId,
      modelPolicy: 'pool',
    });
    if (!updated.success) {
      setPreparingRoute(false);
      setActionError(updated.error?.message || '绑定默认模型池失败');
      return;
    }
    await checkRealRoute(bundle);
    setPreparingRoute(false);
  };

  /**
   * 失败态主行动：把当前调用用途绑到该调用类型的默认池，然后就地重验。
   *
   * 两条分支在点击时按真实数据决定，不预先猜：读 `/gw/pool-types`（只读），
   * 该类型有 ready 的默认池就一键绑（`AppCallerWrite` 外部租户自己就有），
   * 没有池才降级成「去模型池建一个」——新租户的常态恰恰是后者，只做前者等于对新人失效。
   */
  const bindDefaultPool = async () => {
    if (!bundle || binding) return;
    setBinding(true);
    setBindNotice(null);
    const types = await getPoolTypes();
    if (!types.success) {
      setBinding(false);
      setBindNotice(types.error?.message || '读取模型池类型失败');
      return;
    }
    const target = types.data.items.find((item) => item.code === bundle.requestType);
    if (!target?.ready || !target.defaultPoolId) {
      setBinding(false);
      setBindNotice(`当前租户还没有可用的${requestTypeLabel(bundle.requestType)}默认池，先去模型池建一个再回来重试。`);
      return;
    }
    const updated = await updateGatewayAppCaller(bundle.appCallerId, {
      status: 'configured',
      modelPoolId: target.defaultPoolId,
      modelPolicy: 'pool',
    });
    if (!updated.success) {
      setBinding(false);
      setBindNotice(updated.error?.message || '绑定模型池失败');
      return;
    }
    setBinding(false);
    setBindNotice(`已绑定「${target.name}」，正在重新验证。`);
    void checkRealRoute(bundle);
    await runTest(bundle, 'safe');
  };

  const runTest = async (target = bundle, mode = testMode) => {
    if (!target || (mode === 'real' && !realRouteReady)) return;
    setTesting(true);
    setTestResult(null);
    setActionError(null);
    const definition = protocolDefinition(protocol);
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    const requestId = createRequestId();
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${target.key}`,
        'Content-Type': 'application/json',
        'X-Gateway-Source': 'external',
        'X-Gateway-App-Caller': target.appCallerCode,
        'X-Request-Id': requestId,
      };
      if (mode === 'safe') headers['X-Gateway-Dry-Run'] = 'quickstart';
      const response = await fetch(new URL(definition.path, `${normalizedBaseUrl}/`).toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify(dryRunBody(protocol, target.requestType, target.appCallerCode, requestId, testModel)),
        credentials: 'omit',
      });
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      const actualRequestId = readRequestId(response, payload) || requestId;
      const upstreamCalled = readUpstreamCalled(response, payload);
      if (!response.ok) {
        setTestResult({ ok: false, message: readErrorMessage(payload) || `${mode === 'safe' ? '安全测试' : '真实请求'}失败，HTTP ${response.status}`, requestId: actualRequestId, code: readErrorCode(payload) || `HTTP_${response.status}` });
      } else if (mode === 'safe' && upstreamCalled === false) {
        // 这次请求已写进记录。用 markRequestCompleted 而不是裸失效：serving 端
        // 的 LastUsedAt 是不 await 的后台写，只失效+重拉会抢在它落库之前读到旧值。
        markRequestCompleted(tenant?.id);
        setTestResult({ ok: true, message: `${definition.label} 的 ${requestTypeLabel(target.requestType)}、团队边界和密钥鉴权均通过；已写入请求记录，未访问上游。`, requestId: actualRequestId });
      } else if (mode === 'safe') {
        setTestResult({ ok: false, message: 'Gateway 未明确证明 upstreamCalled=false，本次结果不计为安全验收。', requestId: actualRequestId });
      } else {
        const actualModel = readActualModel(payload) || currentRoutePreview?.actualModel || '已解析模型';
        const provider = currentRoutePreview?.actualPlatformName || currentRoutePreview?.actualPlatformId || '已解析 Provider';
        markRequestCompleted(tenant?.id);
        setTestResult({ ok: true, message: `真实上游已返回，Provider：${provider}，模型：${actualModel}。请用 requestId 核对实际模型、耗时和费用。`, requestId: actualRequestId });
      }
    } catch (error) {
      setTestResult({ ok: false, message: error instanceof Error ? `无法访问 Gateway：${error.message}` : '无法访问 Gateway。' });
    } finally {
      setTesting(false);
    }
  };

  const editIdentity = async () => {
    if (!bundle) return;
    if (!await confirm({ title: '确认修改身份？', description: '当前一次性密钥明文将从页面清除；已签发密钥仍然有效，可到“接入密钥”页撤销。', tone: 'danger', confirmLabel: '修改身份' })) return;
    setBundle(null);
    setTestResult(null);
    setRoutePreview(null);
    setTestMode('safe');
    setSnippetTab('curl');
  };

  const selectClientPreset = (next: ClientPresetId) => {
    if (identityLocked) return;
    const preset = CLIENT_PRESETS.find((item) => item.id === next) ?? CLIENT_PRESETS[0];
    const suggestedClient = normalizeClientCode(organization?.tenant?.slug || 'my-agent');
    const nextClientCode = preset.clientCode || suggestedClient;
    setClientPreset(next);
    setProtocol('openai');
    setRequestType('chat');
    setClientCode(nextClientCode);
    setAppCallerCode(preset.appCallerCode || `${nextClientCode}.quickstart::chat`);
    setTestMode('safe');
    setTestResult(null);
    setRoutePreview(null);
  };

  const changeRequestType = (next: RequestType) => {
    setRequestType(next);
    setAppCallerCode((current) => {
      const trimmed = current.trim();
      if (/::(?:chat|vision)$/.test(trimmed)) return trimmed.replace(/::(?:chat|vision)$/, `::${next}`);
      if (!trimmed.includes('::')) return `${trimmed}::${next}`;
      return trimmed;
    });
    setTestResult(null);
    setRoutePreview(null);
  };

  const changeBaseUrl = (next: string) => {
    setBaseUrl(next);
    setRoutePreview(null);
    setTestMode('safe');
    setTestResult(null);
  };


  // 页面只有一条主线，五个状态由真实数据推出来，不额外存一个会和事实打架的 phase 变量。
  const phase: 'idle' | 'issuing' | 'issued' | 'verifying' | 'failed' = creatingStage !== null
    ? 'issuing'
    : testing
      ? 'verifying'
      : !bundle
        ? 'idle'
        : testResult && !testResult.ok
          ? 'failed'
          : 'issued';
  const diagnosis = phase === 'failed' && testResult ? diagnoseFailure(testResult.code, testResult.message) : null;
  const chain = diagnosis ? chainState(diagnosis.brokenLink) : [];
  const blockedByTeam = !organizationLoading && !organizationError && activeTeams.length === 0;
  const issueDisabled = organizationLoading || creatingStage !== null || blockedByTeam
    || Boolean(budgetPair.error) || !purposeReady || !teamId;
  // 注：purposeReady 现在只校验「派生出来的码合不合法」，不再要求用户必须挑一个——
  // 用途只是生成 appCallerCode 的来源，一把 key 本来就可以授权多条调用用途。
  // 创建屏与产物屏互斥：没有密钥时整屏只有一张创建卡，签出来之后整屏让给产物。
  // 两者不同时占版面，就不会出现「左右一起变」——这是本页改版要治的核心问题。
  const onCreateScreen = phase === 'idle' || phase === 'issuing';
  const ribbonText = bundle
    ? `已按「${selectedClient.label}」签发 · 团队 ${selectedTeam?.name ?? '未指定'} · ${budgetPair.monthly !== null ? `${budgetPair.monthly} USD/月` : '预算不限'}`
    : '';

  return (
    <PageShell>
      <PageHeader
        title="Quickstart"
        subtitle={onCreateScreen ? '三个决定，一次点击；密钥在下一屏只显示一次。' : '密钥只显示这一次，复制走再刷新。'}
      />

      <PageBody>
        {onCreateScreen ? (
          /*
            创建屏：一张铺满内容区的卡，只放三个决定——接什么、花多少、算谁的。
            其余全部是派生值或有正确默认值，收进「高级设置」，默认不展开
            （`minimal-user-input.md`：系统知道的值不该摆成输入框）。
            主行动钉在卡片右下角：向导式的「下一步」位置，视线从左上读到右下就落在它上面，
            不是窄窄一条居中卡下面再挂一个通栏按钮。
          */
          <div className="lg-qs-create">
            <Card style={CARD_BODY} className="lg-qs-create-card">
              <div className="lg-qs-create-head">
                <h2 style={headingStyle}><KeyRound size={15} />创建接入密钥</h2>
                <p style={{ ...BODY_TEXT, margin: 0 }}>不创建通配 key；默认 60 次/分钟，只授权当前调用用途与四种协议，签发后自动跑一次安全试跑。</p>
              </div>

              {!canCreateAccess ? <ReadOnlyNotice>当前角色不能创建 appCaller、签发密钥或执行安全直测。</ReadOnlyNotice> : null}
              {organizationLoading ? <SectionLoader text="正在读取当前租户、团队和成员" /> : null}
              {organizationError ? <div className="lg-test-result is-error">{organizationError}</div> : null}
              {blockedByTeam ? (
                <div className="lg-quickstart-prerequisite" role="status">
                  <span><strong>先创建一个团队</strong><small>团队决定调用用途与密钥归谁管。</small></span>
                  <Link to="/organization">打开组织与团队</Link>
                </div>
              ) : null}

              {phase === 'issuing' ? (
                <div className="lg-qs-issuing">
                  <div className="lg-qs-issuing-head">
                    <strong>正在签发</strong>
                    <span>{creatingStage === 'app-caller' ? '1 / 2' : '2 / 2'}</span>
                  </div>
                  <div className="lg-qs-issuing-bar"><i /></div>
                  <ol className="lg-qs-stages">
                    <li className={creatingStage === 'app-caller' ? 'is-active' : 'is-done'}><strong>登记调用用途</strong><small>appCaller {derivedAppCallerCode}</small></li>
                    <li className={creatingStage === 'key' ? 'is-active' : ''}><strong>签发密钥</strong><small>{creatingStage === 'key' ? '正在写入密钥目录' : '等待上一步产物'}</small></li>
                  </ol>
                </div>
              ) : (
                <>
                  <div className="lg-qs-decision">
                    <div className="lg-qs-decision-head"><strong>接入方式</strong></div>
                    <div className="lg-qs-preset-list" role="radiogroup" aria-label="接入方式">
                      {CLIENT_PRESETS.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          role="radio"
                          aria-checked={clientPreset === item.id}
                          className={clientPreset === item.id ? 'is-active' : ''}
                          disabled={!canCreateAccess}
                          onClick={() => selectClientPreset(item.id)}
                        >
                          <span className="lg-qs-radio" aria-hidden="true" />
                          <strong>{item.label}</strong>
                          <span>{item.description}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="lg-qs-decision-row">
                  <div className="lg-qs-decision">
                    <div className="lg-qs-decision-head"><strong>用途</strong><small>决定调用用途码</small></div>
                    <div className="lg-qs-type-row" role="radiogroup" aria-label="用途">
                      {PURPOSE_PRESETS.map((item) => (
                        <button
                          key={item.code}
                          type="button"
                          role="radio"
                          aria-checked={purpose === item.code}
                          className={purpose === item.code ? 'is-active' : ''}
                          disabled={!canCreateAccess || identityLocked}
                          onClick={() => { setPurpose(item.code); setAppCallerCodeTouched(false); }}
                        >{item.label}</button>
                      ))}
                    </div>
                    {purpose === 'custom' ? (
                      <input
                        className="lg-qs-purpose-input"
                        aria-label="自定义用途"
                        placeholder="英文短横线，例如 weekly-report"
                        value={customPurpose}
                        disabled={!canCreateAccess || identityLocked}
                        onChange={(event) => { setAppCallerCodeTouched(false); setCustomPurpose(event.target.value); }}
                      />
                    ) : null}
                    <div className="lg-qs-type-row" role="radiogroup" aria-label="调用类型">
                      {REQUEST_TYPES.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          role="radio"
                          aria-checked={requestType === item.id}
                          className={requestType === item.id ? 'is-active' : ''}
                          disabled={!canCreateAccess || identityLocked}
                          onClick={() => changeRequestType(item.id)}
                        >{item.label}</button>
                      ))}
                    </div>
                    <small className={`lg-qs-note${purposeReady ? '' : ' is-bad'}`}>
                      {purposeReady ? `调用用途码：${derivedAppCallerCode}` : `格式须为 {应用}.{用途}::${requestType}，小写字母数字与短横线。`}
                    </small>
                  </div>

                  <div className="lg-qs-decision">
                    <div className="lg-qs-decision-head"><strong>月预算</strong><small>留空即不限</small></div>
                    <div className="lg-qs-budget">
                      <span>USD</span>
                      <input
                        aria-label="月预算（美元）"
                        inputMode="decimal"
                        placeholder="不限"
                        value={budgetUsd}
                        disabled={!canCreateAccess}
                        onChange={(event) => setBudgetUsd(event.target.value.replace(/[^\d.]/g, ''))}
                      />
                      <span>/ 月</span>
                    </div>
                    <small className={`lg-qs-note${budgetPair.error ? ' is-bad' : ''}`}>{budgetPair.error || budgetPair.holdNote}</small>
                  </div>

                  <div className="lg-qs-decision">
                    <div className="lg-qs-decision-head">
                      <strong>归属团队</strong>
                      <small>密钥与预算都记在团队名下</small>
                    </div>
                    {/*
                      密钥归团队，不归个人：这里只让人选团队，不再挑「负责人」。
                      谁点的创建由服务端记进审计（createdByUsername），不是用户要填的东西。
                      只有一个团队时也照样显示——用户要看得见这把 key 会落到哪儿。
                    */}
                    <div className="lg-qs-team-list" role="radiogroup" aria-label="归属团队">
                      {activeTeams.map((team) => (
                        <button
                          key={team.id}
                          type="button"
                          role="radio"
                          aria-checked={team.id === teamId}
                          className={team.id === teamId ? 'is-active' : ''}
                          disabled={!canCreateAccess || identityLocked}
                          onClick={() => setTeamId(team.id)}
                        >
                          <span className="lg-qs-radio" aria-hidden="true" />
                          <strong>{team.name}</strong>
                        </button>
                      ))}
                    </div>
                  </div>
                  </div>

                  <DetailsBlock title="高级设置（已有默认值）">
                    <div className="lg-quickstart-inputs" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: GAP.section }}>
                      <Field label="单次预占上限（USD，留空按月预算派生）" value={holdCapUsd} onChange={setHoldCapUsd} placeholder="自动" disabled={!canCreateAccess} />
                      <Field label={`appCallerCode（以 ::${requestType} 结尾）`} value={derivedAppCallerCode} onChange={(next) => { setAppCallerCodeTouched(true); setAppCallerCode(next); }} placeholder={`my-agent.quickstart::${requestType}`} disabled={!canCreateAccess || identityLocked} />
                      <Field label="Client code" value={clientCode} onChange={setClientCode} placeholder="my-agent" disabled={!canCreateAccess || identityLocked} />
                      <label style={labelStyle}>环境
                        <select value={environment} disabled={!canCreateAccess || identityLocked} onChange={(event) => setEnvironment(event.target.value)} style={inputStyle}>
                          <option value="development">开发</option>
                          <option value="test">测试</option>
                          <option value="staging">预发布</option>
                          <option value="production">生产</option>
                        </select>
                      </label>
                      <label style={labelStyle}>测试路径<code className="lg-derived-base-url">{selectedProtocol.path}</code></label>
                      <Field label="Gateway 地址" value={baseUrl} onChange={changeBaseUrl} />
                    </div>
                  </DetailsBlock>

                  {actionError ? <div className="lg-test-result is-error" role="alert">{actionError}</div> : null}

                  {canCreateAccess ? (
                    <div className="lg-qs-create-footer">
                      <Button variant="primary" className="lg-qs-primary" title={blockedByTeam ? '请先创建团队' : undefined} disabled={issueDisabled} onClick={() => void createAccessBundle()}>
                        <KeyRound size={15} />创建密钥
                      </Button>
                    </div>
                  ) : null}
                </>
              )}
            </Card>

            <div className="lg-qs-footline">
              <DetailsBlock title="已经有密钥？看接入地址与现有密钥前缀">
                <AccessSnippetBar />
              </DetailsBlock>
              <DetailsBlock title="工作原理：三个身份、预算与失败定位">
                <dl style={dlStyle}>
                  <RouteRow name="service key" text="回答谁在调用；绑定 tenant、team、client、environment、appCaller 和协议。" />
                  <RouteRow name="appCallerCode" text="回答为什么调用；提示词策略、预算、限流与专属路由都挂在它上面。格式 {应用}.{用途}::chat 或 ::vision，至少两段，只允许小写字母、数字与短横线，最长 200 字符。" />
                  <RouteRow name="用途码与团队" text="同一租户里一条码只能归一个团队；换团队再登记同一条码会被拒（APP_CALLER_IDENTITY_CONFLICT）。一把 key 可以授权多条码，本页只登记它用到的这一条。" />
                  <RouteRow name="两个可选请求头" text="X-Gateway-App-Caller 传码：兼容协议下如果这把 key 只授权了一条码，可以不传、由网关推断；gw-native 必须传。X-Gateway-App-Title 传一句人话标题，只进日志，不参与鉴权与路由。" />
                  <RouteRow name="model pool" text="回答去哪里调用；默认池与特殊池由平台规则管理，不由 key 承担。" />
                  <RouteRow name="预算与预占" text="月预算与单次预占上限必须成对写入；只写一个会被网关配置校验拒绝。留空表示不限额。" />
                  <RouteRow name="安全连通" text="发送 X-Gateway-Dry-Run: quickstart，在模型解析、预算预占和上游发送前结束；HTTP 成功、返回 requestId 且 upstreamCalled=false 才算通过。" />
                  <RouteRow name="401 / 403" text="401 是密钥错误、过期或已撤销；403 是团队、appCaller、协议、scope 或来源范围不匹配。失败时下一屏会直接指出坏在哪一环。" />
                </dl>
                <TutorialLink chapter="chapter-11">查看教程：第 11 章 自助接入</TutorialLink>
              </DetailsBlock>
            </div>
          </div>
        ) : (
          /*
            产物屏：创建卡收成一条细条，整屏让给「复制走就能用」的三样东西——
            接入地址、一次性密钥、请求片段。这三样占据视觉重心，细条、试跑结果、
            协议下拉、排障入口一律压成弱化的一行；整屏一次装下，页面不滚动
            （片段本身太长时在它自己的框里滚，不推着整页走）。
            结果条与失败条共用顶部同一个槽位——成功也要留下 requestId，
            否则这次试跑没有任何可回查的凭据（`closed-loop-acceptance.md`）。
          */
          <div className="lg-qs-artifacts">
            <div className="lg-qs-ribbon">
              <CheckCircle2 size={15} />
              <span>{ribbonText}</span>
              {canCreateAccess ? <button type="button" className="lg-text-link" onClick={() => void editIdentity()}>更改</button> : null}
            </div>

            {phase === 'verifying' ? (
              <div className="lg-test-result" role="status"><Play size={14} />正在发送安全试跑（dry-run，不访问上游），等待 requestId 回执。</div>
            ) : null}
            {phase === 'issued' && testResult?.ok ? (
              <div className="lg-test-result is-ok" role="status">
                <CheckCircle2 size={14} />{testResult.message}
                {testResult.requestId ? <Link to={`/logs?requestId=${encodeURIComponent(testResult.requestId)}`}>打开 requestId 请求记录</Link> : null}
              </div>
            ) : null}
            {diagnosis ? (
              <div className="lg-qs-failure" role="alert">
                <div className="lg-qs-failure-head">
                  <AlertCircle size={16} />
                  <strong>{diagnosis.title}</strong>
                  {diagnosis.code ? <code>{diagnosis.code}</code> : null}
                </div>
                <div className="lg-qs-chain">
                  {chain.map((link) => <span key={link.id} className={`lg-qs-chain-link is-${link.tone}`}>{link.label}</span>)}
                </div>
                <span className="lg-qs-failure-reason">{diagnosis.reason}</span>
                <div className="lg-qs-failure-actions">
                  {diagnosis.action === 'bind-pool' && canCreateAccess ? <Button size="sm" variant="secondary" disabled={binding} onClick={() => void bindDefaultPool()}>{binding ? '正在绑定' : diagnosis.actionLabel}</Button> : null}
                  {diagnosis.to && diagnosis.actionLabel ? <Link className="lg-secondary-link" to={diagnosis.to}>{diagnosis.actionLabel}</Link> : null}
                  {canCreateAccess ? <Button size="sm" variant="ghost" disabled={testing} onClick={() => void runTest()}>重试验证</Button> : null}
                  {testResult?.requestId ? <Link className="lg-text-link" to={`/logs?requestId=${encodeURIComponent(testResult.requestId)}`}>{testResult.requestId}</Link> : null}
                </div>
                {bindNotice ? <span className="lg-qs-failure-reason">{bindNotice}</span> : null}
              </div>
            ) : null}

            {bundle ? (
              <div className="lg-qs-focus">
                <div className="lg-qs-focus-side">
                <Card style={CARD_BODY} className="lg-qs-hero">
                  <div className="lg-qs-hero-head">
                    <strong>接入地址</strong>
                    <Button size="sm" variant="ghost" onClick={() => void copyText('base-url', `${displayBundle.baseUrl}${selectedProtocol.path}`)}>{copied === 'base-url' ? <Check size={13} /> : <Copy size={13} />}{copied === 'base-url' ? '已复制' : '复制'}</Button>
                  </div>
                  <code className="lg-qs-hero-value">{`${displayBundle.baseUrl}${selectedProtocol.path}`}</code>
                </Card>

                <Card style={CARD_BODY} className="lg-qs-hero is-caller">
                  <div className="lg-qs-hero-head">
                    <strong>调用用途</strong>
                    <Button size="sm" variant="ghost" onClick={() => void copyText('app-caller', displayBundle.appCallerCode)}>{copied === 'app-caller' ? <Check size={13} /> : <Copy size={13} />}{copied === 'app-caller' ? '已复制' : '复制'}</Button>
                  </div>
                  <code className="lg-qs-hero-value">{displayBundle.appCallerCode}</code>
                  <small className="lg-qs-hero-note">归属团队 {selectedTeam?.name ?? '未指定'}；这把 key 只授权了它一条，兼容协议下请求头可省略。</small>
                </Card>

                <Card style={CARD_BODY} className="lg-qs-hero is-secret">
                  <div className="lg-qs-hero-head">
                    <strong>一次性密钥</strong>
                    <Chip label="只显示一次" color="var(--warn)" bg="var(--warn-bg)" />
                    <Button size="sm" onClick={() => void copyText('key', bundle.key)}>{copied === 'key' ? <Check size={14} /> : <Copy size={14} />}{copied === 'key' ? '已复制' : '复制密钥'}</Button>
                  </div>
                  <code className="lg-qs-hero-value lg-qs-secret-code">{bundle.key}</code>
                  <small className="lg-qs-hero-note">离开或刷新即不可再取；不要进仓库、截图或日志。</small>
                </Card>
                </div>

                <Card style={CARD_BODY} className="lg-qs-snippet-card">
                  {/*
                    一键测试：类型是这把 key 的调用用途本身携带的（appCallerCode 以 ::chat / ::vision
                    结尾，签发后不可改），所以这里只读展示；能选的是模型——且只列该类型模型池里的
                    成员，不让人填一个池外模型（`llm-gateway.md`：可选模型必须来自获准的池）。
                  */}
                  <div className="lg-qs-testbar">
                    <span className="lg-qs-testbar-type">{requestTypeLabel(displayBundle.requestType)}</span>
                    <label>
                      模型
                      {/* 搜索式选择：datalist 让浏览器自己做过滤，两百多个成员也能敲几个字定位。 */}
                      <input
                        aria-label="测试模型"
                        list="lg-qs-model-options"
                        placeholder="auto（由模型池调度）"
                        value={modelQuery}
                        onChange={(event) => { setModelQuery(event.target.value); setTestResult(null); }}
                      />
                      <datalist id="lg-qs-model-options">
                        {poolModels.map((modelId) => <option key={modelId} value={modelId} />)}
                      </datalist>
                    </label>
                    {canCreateAccess ? (
                      <Button size="sm" variant="primary" disabled={testing || !modelValid} onClick={() => void runTest()}>
                        <Play size={14} />{testing ? '正在执行' : '执行测试'}
                      </Button>
                    ) : null}
                    <small className={modelValid ? undefined : 'is-bad'}>{modelHint}</small>
                  </div>
                  <div className="lg-qs-snippet-head">
                    <div className="lg-snippet-tabs">
                      {hasClientTab ? <Button size="sm" variant={snippetTab === 'client' ? 'primary' : 'ghost'} onClick={() => setSnippetTab('client')}>{selectedClient.label}</Button> : null}
                      <Button size="sm" variant={snippetTab === 'curl' || (snippetTab === 'client' && !hasClientTab) ? 'primary' : 'ghost'} onClick={() => setSnippetTab('curl')}>cURL</Button>
                      <Button size="sm" variant={snippetTab === 'env' ? 'primary' : 'ghost'} onClick={() => setSnippetTab('env')}>环境变量</Button>
                      <Button size="sm" variant={snippetTab === 'skill' ? 'primary' : 'ghost'} onClick={() => setSnippetTab('skill')}><FileCode2 size={14} />Agent Skill</Button>
                    </div>
                    <select
                      aria-label="入口协议"
                      value={protocol}
                      onChange={(event) => { setProtocol(event.target.value as Protocol); setTestResult(null); if (bundle) void checkRealRoute(bundle); }}
                      style={inputStyle}
                    >
                      {PROTOCOLS.map((item) => <option key={item.id} value={item.id}>{`${item.label} ${item.path}`}</option>)}
                    </select>
                  </div>
                  {snippetTab === 'client' && hasClientTab ? (
                    <ClientQuickSetup bundle={displayBundle} copied={copied} onCopy={copyText} />
                  ) : (
                    <div className="lg-qs-code-wrap">
                      <pre style={preStyle} className="lg-qs-code"><code>{visibleSnippet}</code></pre>
                      <Button size="sm" style={{ position: 'absolute', top: 9, right: 9 }} onClick={() => void copyText(snippetTab, visibleSnippet)}>{copied === snippetTab ? <Check size={14} /> : <Copy size={14} />}{copied === snippetTab ? '已复制' : '复制'}</Button>
                    </div>
                  )}
                  <small className="lg-qs-note">{snippetMode === 'safe' ? '示例默认带 X-Gateway-Dry-Run: quickstart，不产生上游费用。' : '示例不带 dry-run，会真实调用模型。'}</small>
                </Card>
                </div>
            ) : null}

            {bundle ? (
                /* 再测一次与真实路由排障不占重心：首次接入不需要，排障时再展开。 */
                <DetailsBlock title="再测一次 / 真实路由与排障">
                  <div className="lg-safe-test-panel">
                    <div><Play size={17} /><span><strong>再测一次</strong><small>安全连通不访问上游；真实模型会计费。</small></span></div>
                    <div className="lg-test-mode" role="group" aria-label="测试模式">
                      <button type="button" className={testMode === 'safe' ? 'is-active' : ''} onClick={() => { setTestMode('safe'); setTestResult(null); }}>安全连通</button>
                      <button type="button" className={testMode === 'real' ? 'is-active' : ''} disabled={!realRouteReady || routeChecking} title={!realRouteReady ? '先在下方确认真实路由已就绪' : undefined} onClick={() => { setTestMode('real'); setTestResult(null); }}>真实模型</button>
                    </div>
                    <div className="lg-safe-test-controls">
                      {canCreateAccess ? <Button variant="primary" disabled={testing || (testMode === 'real' && !realRouteReady)} onClick={() => void runTest()}>{testing ? (testMode === 'real' ? '正在等待真实模型' : '正在验证并写日志') : testMode === 'real' ? '发送一次真实请求' : '验证接入边界'}</Button> : null}
                      <span style={{ alignSelf: 'center', color: 'var(--text-muted)', fontSize: 'var(--fs-secondary)' }}>{canCreateAccess ? (testMode === 'real' ? '只调用下方已解析的真实模型' : '返回 requestId 且 upstreamCalled=false 才算通过') : '请联系 Owner、Admin 或 Developer 完成签发与测试'}</span>
                    </div>
                  </div>

                  {routeChecking ? <p style={BODY_TEXT}>正在检查路由。</p> : currentRoutePreview?.success ? (
                    <div className="lg-route-facts">
                      <RouteFact label="模型池" value={currentRoutePreview.modelGroupName || currentRoutePreview.modelGroupId || '默认池'} />
                      <RouteFact label="Provider" value={currentRoutePreview.actualPlatformName || currentRoutePreview.actualPlatformId || '未命名 Provider'} />
                      <RouteFact label="实际模型" value={currentRoutePreview.actualModel || '未返回'} />
                      <RouteFact label="上游协议" value={currentRoutePreview.protocol || currentRoutePreview.platformType || '自动适配'} />
                    </div>
                  ) : (
                    <div className="lg-route-blocked">
                      <strong>真实请求尚未就绪</strong>
                      <span>{currentRoutePreview?.errorMessage || '当前地址尚未通过真实路由预检。请先点击重新检查。'}</span>
                      {tenant?.isInternal && canManagePromptPolicy ? <Button size="sm" variant="secondary" disabled={preparingRoute} onClick={() => void prepareRealRoute()}>{preparingRoute ? '正在只补缺失配置' : '一键准备现有真实上游'}</Button> : null}
                      {!tenant?.isInternal ? <span>请先添加 Provider 密钥、启用模型并加入默认池。</span> : null}
                    </div>
                  )}
                  <div className="lg-qs-more-actions">
                    <Button size="sm" variant="ghost" disabled={routeChecking} onClick={() => void checkRealRoute()}>{routeChecking ? '检查中' : '重新检查路由'}</Button>
                    {canManagePromptPolicy
                      ? <Link className="lg-text-link" to={`/app-callers/${encodeURIComponent(bundle.appCallerId)}/prompt-policy`}>给这个调用用途配提示词策略</Link>
                      : <span style={BODY_TEXT}>提示词策略需由 Owner 或 Admin 配置。</span>}
                  </div>
                </DetailsBlock>
            ) : null}
          </div>
        )}
      </PageBody>
    </PageShell>
  );
}

function resolveDefaultServingBaseUrl() {
  const configured = (import.meta.env.VITE_LLMGW_SERVING_BASE_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  return new URL(window.location.href).origin;
}

function protocolDefinition(protocol: Protocol) {
  return PROTOCOLS.find((item) => item.id === protocol) ?? PROTOCOLS[1];
}

function normalizeClientCode(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 72);
  return normalized.length >= 2 ? `${normalized}-agent`.slice(0, 80) : 'my-agent';
}

function isValidAppCaller(value: string, requestType: RequestType) {
  return new RegExp(`^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+::${requestType}$`).test(value) && value.length <= 200;
}

/** 把一句人话用途压成 appCallerCode 里的一段（与 ServiceKeysPage 同一套写法）。 */
function toAppCallerSegment(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function requestTypeLabel(requestType: RequestType) {
  return requestType === 'vision' ? '图片理解' : '文字对话';
}


type BudgetPair = { monthly: number | null; hold: number | null; error: string | null; holdNote: string };

/**
 * 月预算与单次预占上限是**一对**，不是两个独立字段。
 *
 * console-api 的 `ValidateBudgetConfiguration` 会拒绝「只有月预算」「只有预占上限」
 * 「预占大于月预算」三种组合（400）；库里真落进单边配置，serving 启动自检会直接抛
 * `APP_CALLER_BUDGET_MIGRATION_REQUIRED` 拒绝启动。所以：
 *   - 月预算留空 = 不限额，两个值都不提交（此时高级设置里填的预占上限一并丢弃）；
 *   - 填了月预算但没填预占 = 按月预算的 1% 派生，下限 0.5 USD，且**再夹回月预算**
 *     （月预算小于 0.5 时，1% 的下限会反超月预算，那正是后端拒收的第三种组合）。
 */
function deriveBudgetPair(budgetInput: string, holdInput: string): BudgetPair {
  const budgetText = budgetInput.trim();
  const holdText = holdInput.trim();
  if (!budgetText) {
    return {
      monthly: null,
      hold: null,
      error: null,
      holdNote: holdText
        ? '月预算留空表示不限额；单次预占上限只有在填了月预算之后才会一起提交。'
        : '留空表示不限额，本次不写预算约束。',
    };
  }
  const monthly = Number(budgetText);
  if (!Number.isFinite(monthly) || monthly <= 0) {
    return { monthly: null, hold: null, error: '月预算要填一个大于 0 的金额，或者留空表示不限额。', holdNote: '' };
  }
  const derived = Math.min(Math.max(round2(monthly / 100), 0.5), round2(monthly));
  const hold = holdText ? Number(holdText) : derived;
  if (!Number.isFinite(hold) || hold <= 0) {
    return { monthly: null, hold: null, error: '单次预占上限要填一个大于 0 的金额，或者留空由月预算派生。', holdNote: '' };
  }
  if (round2(hold) > round2(monthly)) {
    return { monthly: null, hold: null, error: '单次预占上限不能大于月预算，网关会拒绝这种配置。', holdNote: '' };
  }
  return {
    monthly: round2(monthly),
    hold: round2(hold),
    error: null,
    holdNote: holdText
      ? `单次预占上限 ${round2(hold)} USD 与月预算一起提交。`
      : `单次预占上限自动派生为 ${derived} USD，与月预算一起提交；可在高级设置里改。`,
  };
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function createRequestId() {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replaceAll('-', '')
    : `${Date.now()}${Math.random().toString(16).slice(2)}`;
  return `quickstart-${suffix.slice(0, 24)}`;
}

function dryRunBody(protocol: Protocol, requestType: RequestType, appCallerCode: string, requestId: string, model = 'auto') {
  // model=auto 表示交给模型池调度；选了具体成员就把它发出去，由网关按池规则校验。
  const policy = model === 'auto' ? 'auto' : 'pool';
  if (protocol === 'native') return {
    appCallerCode,
    modelType: requestType,
    requestBody: { model, messages: [{ role: 'user', content: requestType === 'vision' ? visionOpenAiContent() : 'Reply with OK' }] },
    context: { requestId, sourceSystem: 'external', modelPolicy: policy },
  };
  if (protocol === 'claude') return { model, model_policy: policy, max_tokens: 64, messages: [{ role: 'user', content: requestType === 'vision' ? visionClaudeContent() : 'Reply with OK' }] };
  if (protocol === 'gemini') return { model, model_policy: policy, contents: [{ role: 'user', parts: requestType === 'vision' ? visionGeminiParts() : [{ text: 'Reply with OK' }] }] };
  return { model, model_policy: policy, messages: [{ role: 'user', content: requestType === 'vision' ? visionOpenAiContent() : 'Reply with OK' }], stream: false };
}

function visionOpenAiContent() {
  return [
    { type: 'text', text: 'Describe this test image' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${TEST_IMAGE_BASE64}` } },
  ];
}

function visionClaudeContent() {
  return [
    { type: 'text', text: 'Describe this test image' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TEST_IMAGE_BASE64 } },
  ];
}

function visionGeminiParts() {
  return [
    { text: 'Describe this test image' },
    { inlineData: { mimeType: 'image/png', data: TEST_IMAGE_BASE64 } },
  ];
}

function readRequestId(response: Response, payload: Record<string, unknown> | null) {
  const gateway = payload?.gateway as Record<string, unknown> | undefined;
  return response.headers.get('X-Request-Id')
    || stringValue(gateway?.requestId)
    || stringValue(gateway?.request_id)
    || stringValue(payload?.requestId)
    || stringValue(payload?.request_id)
    || stringValue(payload?.RequestId);
}

function readUpstreamCalled(response: Response, payload: Record<string, unknown> | null) {
  const header = response.headers.get('X-Gateway-Upstream-Called');
  if (header) return header.toLowerCase() === 'true';
  const gateway = payload?.gateway as Record<string, unknown> | undefined;
  const value = gateway?.upstreamCalled ?? gateway?.upstream_called ?? payload?.upstreamCalled ?? payload?.UpstreamCalled;
  return typeof value === 'boolean' ? value : undefined;
}

function readErrorMessage(payload: Record<string, unknown> | null) {
  const error = payload?.error as Record<string, unknown> | undefined;
  return stringValue(error?.message) || stringValue((payload?.Error as Record<string, unknown> | undefined)?.Message);
}

/** serving 的错误体固定是 `error: { code, message }`；归因只认 code，不按文案匹配。 */
function readErrorCode(payload: Record<string, unknown> | null) {
  const error = payload?.error as Record<string, unknown> | undefined;
  return stringValue(error?.code)
    || stringValue((payload?.Error as Record<string, unknown> | undefined)?.Code)
    || stringValue(payload?.errorCode)
    || stringValue(payload?.failureReason);
}

/** 把一次失败翻译成「哪一环坏了 + 为什么 + 下一步」。取不到规则就如实说未归类。 */
function diagnoseFailure(code: string | undefined, message: string) {
  const rule = code ? FAILURE_RULES[code] : undefined;
  if (rule) return { ...rule, code: code ?? '', reason: rule.reason || message };
  return {
    brokenLink: null as ChainLinkId | null,
    title: '这次调用没通过',
    reason: message,
    actionLabel: '',
    to: undefined,
    action: undefined,
    code: code ?? '',
  };
}

/** 三环状态：坏的那一环之前判通过，之后判未知——没走到的环不许画成绿色。 */
function chainState(broken: ChainLinkId | null) {
  const brokenIndex = broken ? CHAIN_LINKS.findIndex((link) => link.id === broken) : -1;
  return CHAIN_LINKS.map((link, index) => ({
    ...link,
    tone: brokenIndex < 0 ? 'unknown' : index < brokenIndex ? 'ok' : index === brokenIndex ? 'bad' : 'unknown',
  }));
}

function readActualModel(payload: Record<string, unknown> | null) {
  const resolution = payload?.resolution as Record<string, unknown> | undefined;
  return stringValue(payload?.model)
    || stringValue(payload?.modelVersion)
    || stringValue(payload?.model_version)
    || stringValue(resolution?.actualModel)
    || stringValue(resolution?.actual_model);
}

function normalizeRoutePreview(payload: Record<string, unknown> | null, checkedBaseUrl: string): RoutePreview | null {
  if (!payload) return null;
  const success = payload.success ?? payload.Success;
  if (typeof success !== 'boolean') return null;
  const value = (camel: string, pascal: string) => stringValue(payload[camel]) || stringValue(payload[pascal]);
  return {
    success,
    checkedBaseUrl,
    errorMessage: value('errorMessage', 'ErrorMessage'),
    resolutionType: value('resolutionType', 'ResolutionType'),
    actualModel: value('actualModel', 'ActualModel'),
    actualPlatformId: value('actualPlatformId', 'ActualPlatformId'),
    actualPlatformName: value('actualPlatformName', 'ActualPlatformName'),
    platformType: value('platformType', 'PlatformType'),
    protocol: value('protocol', 'Protocol'),
    apiUrl: value('apiUrl', 'ApiUrl'),
    modelGroupId: value('modelGroupId', 'ModelGroupId'),
    modelGroupName: value('modelGroupName', 'ModelGroupName'),
    healthStatus: value('healthStatus', 'HealthStatus'),
  };
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/$/, '');
}

function canRunRealTest(preview: RoutePreview | null, baseUrl: string) {
  if (!preview?.success || !preview.actualModel || preview.checkedBaseUrl !== normalizeBaseUrl(baseUrl)) return false;
  const identity = [preview.actualModel, preview.actualPlatformName, preview.actualPlatformId, preview.apiUrl]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return !/(^|[^a-z])(stub|mock|fake)([^a-z]|$)|开发桩/.test(identity);
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function ClientQuickSetup({ bundle, copied, onCopy }: { bundle: DisplayBundle; copied: string | null; onCopy: (name: string, value: string) => Promise<void> }) {
  if (bundle.clientPreset === 'cherry-studio') {
    return <div className="lg-client-quick-setup">
      <div className="lg-client-quick-step"><strong>1. 添加服务商</strong><span>Cherry Studio：设置 → 模型服务 → 添加，类型选 OpenAI，名称填 LLM Gateway。</span></div>
      <div className="lg-client-quick-step"><strong>2. 填入四项</strong>
        <div className="lg-client-copy-values">
          <CopyValue label="API 地址" value={bundle.baseUrl} copyId="cherry-base-url" copied={copied} onCopy={onCopy} />
          <CopyValue label="API Key" value={bundle.key || 'YOUR_ONE_TIME_LLMGW_KEY'} copyId="cherry-key" copied={copied} onCopy={onCopy} secret />
          <CopyValue label="模型" value="auto" copyId="cherry-model" copied={copied} onCopy={onCopy} />
          <CopyValue label="服务商名称" value="LLM Gateway" copyId="cherry-name" copied={copied} onCopy={onCopy} />
        </div>
      </div>
      <div className="lg-client-quick-step"><strong>3. 检查并使用</strong><span>添加模型 auto，开启服务商，点“检查”后即可对话。</span></div>
    </div>;
  }

  const command = openClawSetupCommand(bundle);
  return <div className="lg-client-quick-setup">
    <div className="lg-client-quick-step"><strong>1. 复制配置命令</strong><span>命令使用 OpenClaw 官方增量写入，不会覆盖已有 Provider。</span></div>
    <div className="lg-client-command"><pre><code>{command}</code></pre><Button size="sm" onClick={() => void onCopy('openclaw-command', command)}>{copied === 'openclaw-command' ? <Check size={14} /> : <Copy size={14} />}{copied === 'openclaw-command' ? '已复制' : '复制命令'}</Button></div>
    <div className="lg-client-quick-step"><strong>2. 粘贴到终端</strong><span>合并 provider 并设为默认模型。</span></div>
    <div className="lg-client-quick-step"><strong>3. 发一条消息</strong><span>运行 openclaw chat，再用 requestId 回查。</span></div>
  </div>;
}

function CopyValue({ label, value, copyId, copied, onCopy, secret = false }: { label: string; value: string; copyId: string; copied: string | null; onCopy: (name: string, value: string) => Promise<void>; secret?: boolean }) {
  return <div><span>{label}</span><code>{secret ? `${value.slice(0, 12)}…${value.slice(-4)}` : value}</code><Button size="sm" variant="ghost" onClick={() => void onCopy(copyId, value)}>{copied === copyId ? <Check size={13} /> : <Copy size={13} />}{copied === copyId ? '已复制' : '复制'}</Button></div>;
}

function environmentSnippet(bundle: DisplayBundle) {
  return `export LLMGW_BASE_URL="${bundle.baseUrl}"
export LLMGW_API_KEY="${bundle.key || 'YOUR_ONE_TIME_LLMGW_KEY'}"
export LLMGW_APP_CALLER="${bundle.appCallerCode}"
export LLMGW_REQUEST_TYPE="${bundle.requestType}"
export LLMGW_PROTOCOL="${protocolDefinition(bundle.protocol).ingressProtocol}"
export LLMGW_CLIENT_CODE="${bundle.clientCode}"
export LLMGW_ENVIRONMENT="${bundle.environment}"`;
}

function clientSetupSnippet(bundle: DisplayBundle) {
  if (bundle.clientPreset === 'cherry-studio') {
    return `Cherry Studio
服务商类型: OpenAI
服务商名称: LLM Gateway
API 地址: ${bundle.baseUrl}
API Key: ${bundle.key || 'YOUR_ONE_TIME_LLMGW_KEY'}
模型: auto

粘贴位置: 设置 > 模型服务 > 添加
完成方式: 手动添加模型 auto，开启服务商，点击“检查”后发送一条消息。`;
  }
  if (bundle.clientPreset === 'openclaw') {
    return openClawSetupCommand(bundle);
  }
  return environmentSnippet(bundle);
}

function openClawSetupCommand(bundle: DisplayBundle) {
  const provider = JSON.stringify({
    baseUrl: `${bundle.baseUrl}/v1`,
    apiKey: bundle.key || 'YOUR_ONE_TIME_LLMGW_KEY',
    api: 'openai-completions',
    headers: {
      'X-Gateway-Source': 'external',
      'X-Gateway-App-Caller': bundle.appCallerCode,
    },
    models: [{ id: 'auto', name: 'LLM Gateway Auto', input: ['text'] }],
  });
  return `openclaw config set models.providers.llmgw ${shellSingleQuote(provider)} --strict-json --merge
openclaw models set llmgw/auto
openclaw config validate`;
}

function shellSingleQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function agentSkillSnippet(bundle: DisplayBundle, mode: TestMode) {
  const definition = protocolDefinition(bundle.protocol);
  return `---
name: llmgw-${bundle.clientCode}
description: 通过团队 scoped key 使用 LLM Gateway 的 ${definition.label} 协议，并用 requestId 完成审计回查。
---

# LLM Gateway 接入

## 前置环境变量

- LLMGW_BASE_URL=${bundle.baseUrl}
- LLMGW_API_KEY 由部署 Secret 注入，禁止写入仓库
- LLMGW_APP_CALLER=${bundle.appCallerCode}
- LLMGW_REQUEST_TYPE=${bundle.requestType}

## 执行规则

1. 请求 ${definition.path}。
2. 使用 Authorization: Bearer \$LLMGW_API_KEY。
3. 固定发送 X-Gateway-Source: external 与 X-Gateway-App-Caller: \$LLMGW_APP_CALLER。
4. ${mode === 'safe' ? '首次接入发送 X-Gateway-Dry-Run: quickstart；只有响应明确 upstreamCalled=false 才算安全测试通过。' : '当前示例为真实模型模式，不发送 X-Gateway-Dry-Run；执行前必须确认控制台路由预览中的 Provider 和模型。'}
5. 保存响应头 X-Request-Id，并打开控制台 /logs?requestId={requestId} 核对团队、service key、client 和 environment。
6. ${mode === 'safe' ? '正式调用时删除 X-Gateway-Dry-Run。' : '本示例已经是正式调用形状。'}同类真实协议验收最多一次，其余使用假上游。

## 安全边界

- 不发送 tenantId，租户只由服务端从 key 解析。
- 不记录、不输出、不提交 LLMGW_API_KEY。
- 401 时轮换密钥；403 时检查 team、appCaller、协议和 scope，禁止通过扩大到通配 key 绕过。`;
}

function exampleFor(protocol: Protocol, requestType: RequestType, baseUrl: string, appCaller: string, mode: TestMode, model = 'auto') {
  const definition = protocolDefinition(protocol);
  const requestIdToken = '__LLMGW_REQUEST_ID__';
  const common = `-H "Authorization: Bearer \$LLMGW_API_KEY" \\
  -H "X-Gateway-Source: external" \\
  -H "X-Gateway-App-Caller: ${appCaller}" \\${mode === 'safe' ? '\n  -H "X-Gateway-Dry-Run: quickstart" \\' : ''}
  -H "X-Request-Id: \$REQUEST_ID"`;
  const body = JSON.stringify(dryRunBody(protocol, requestType, appCaller, requestIdToken, model), null, 2)
    .replace(requestIdToken, `'"$REQUEST_ID"'`);
  const extra = protocol === 'claude' ? ' \\\n  -H "anthropic-version: 2023-06-01"' : '';
  return `REQUEST_ID="quickstart-\$(date +%s)-\$RANDOM"
curl "${baseUrl}${definition.path}" \\
  ${common}${extra} \\
  -H "Content-Type: application/json" \\
  -d '${body}'`;
}

function Field({ label, value, onChange, placeholder, disabled = false }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; disabled?: boolean }) {
  return <label style={labelStyle}>{label}<input value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} style={inputStyle} /></label>;
}

function RouteRow({ name, text }: { name: string; text: string }) {
  return <div><dt style={{ color: 'var(--text-primary)', fontSize: 'var(--fs-body)', fontWeight: 600 }}>{name}</dt><dd style={{ margin: '3px 0 0', color: 'var(--text-muted)', fontSize: 'var(--fs-body)', lineHeight: 1.5 }}>{text}</dd></div>;
}

function RouteFact({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong title={value}>{value}</strong></div>;
}

// 卡片外观走 ui.tsx 的 Card + surface.ts 的 CARD_BODY（内边距 14）；
// 代码块沿用 14，本页不再自拍第三种内边距。
const headingStyle: React.CSSProperties = { ...SECTION_TITLE, display: 'flex', alignItems: 'center', gap: GAP.tight, marginBottom: GAP.normal };
const dlStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: GAP.normal, margin: 0 };
const labelStyle: React.CSSProperties = FIELD_LABEL;
const inputStyle: React.CSSProperties = FIELD_INPUT;
const preStyle: React.CSSProperties = { margin: 0, minHeight: 180, overflow: 'auto', padding: 14, paddingTop: 48, background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 'var(--fs-secondary)', lineHeight: 1.65 };
