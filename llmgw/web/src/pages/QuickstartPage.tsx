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
import { AlertCircle, Check, CheckCircle2, Copy, FileCode2, KeyRound, Play, Server, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { bulkClaimConfigAuthority, createGatewayAppCaller, createServiceKey, ensurePoolTypes, getOrganization, getPoolTypes, updateGatewayAppCaller } from '@/lib/api';
import type { OrganizationData } from '@/lib/types';
import { Button, Card, Chip, ReadOnlyNotice, SectionLoader } from '@/components/ui';
import { AccessSnippetBar } from '@/components/AccessSnippetBar';
import { DetailsBlock, PageBody, PageHeader, PageShell, Prose, TutorialLink } from '@/components/PageShell';
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
  const { tenant } = useAuth();
  const canCreateAccess = canUseCapability(tenant?.role, 'appCallerWrite') && canUseCapability(tenant?.role, 'serviceKeyWrite');
  const { confirm } = useDialogs();
  const canManagePromptPolicy = canUseCapability(tenant?.role, 'configWrite');
  const [clientPreset, setClientPreset] = useState<ClientPresetId>('api');
  const [protocol, setProtocol] = useState<Protocol>('openai');
  const [requestType, setRequestType] = useState<RequestType>('chat');
  const [baseUrl, setBaseUrl] = useState(resolveDefaultServingBaseUrl);
  const [appCallerCode, setAppCallerCode] = useState('my-agent.quickstart::chat');
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
  const [binding, setBinding] = useState(false);
  const [bindNotice, setBindNotice] = useState<string | null>(null);

  const selectedProtocol = protocolDefinition(protocol);
  const selectedClient = CLIENT_PRESETS.find((item) => item.id === clientPreset) ?? CLIENT_PRESETS[0];
  const activeTeams = organization?.teams.filter((team) => team.status === 'active') ?? [];
  const selectedTeam = activeTeams.find((team) => team.id === teamId);
  const identityLocked = Boolean(bundle) || creatingStage !== null;

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
      const firstTeam = response.data.teams.find((team) => team.status === 'active');
      if (firstTeam) setTeamId((current) => current || firstTeam.id);
      const suggestedClient = normalizeClientCode(response.data.tenant?.slug || 'my-agent');
      setClientCode((current) => current === 'my-agent' ? suggestedClient : current);
      setAppCallerCode((current) => current === 'my-agent.quickstart::chat' ? `${suggestedClient}.quickstart::chat` : current);
    });
    return () => { active = false; };
  }, []);

  const displayBundle: DisplayBundle = {
    key: bundle?.key ?? '',
    keyId: bundle?.keyId ?? '',
    keyPrefix: bundle?.keyPrefix ?? 'gwk_',
    appCallerId: bundle?.appCallerId ?? '',
    protocol,
    baseUrl: baseUrl.replace(/\/$/, ''),
    appCallerCode: bundle?.appCallerCode ?? (appCallerCode.trim() || 'my-agent.quickstart::chat'),
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
    curl: exampleFor(displayBundle.protocol, displayBundle.requestType, displayBundle.baseUrl, displayBundle.appCallerCode, snippetMode),
    env: environmentSnippet(displayBundle),
    skill: agentSkillSnippet(displayBundle, snippetMode),
  }), [displayBundle.protocol, displayBundle.requestType, displayBundle.baseUrl, displayBundle.appCallerCode, displayBundle.key, displayBundle.clientCode, displayBundle.environment, displayBundle.clientPreset, snippetMode]);
  const visibleSnippet = snippets[snippetTab];

  const copyText = async (name: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(name);
    window.setTimeout(() => setCopied((current) => current === name ? null : current), 1600);
  };

  const createAccessBundle = async () => {
    const normalizedCode = appCallerCode.trim();
    const normalizedClient = clientCode.trim().toLowerCase();
    const normalizedBaseUrl = baseUrl.trim().replace(/\/$/, '');
    if (!teamId || !normalizedBaseUrl || !isValidAppCaller(normalizedCode, requestType) || !/^[a-z][a-z0-9._-]{1,79}$/.test(normalizedClient)) {
      setActionError(`请确认团队、Gateway 地址和 clientCode 有效，并让 appCallerCode 以 ::${requestType} 结尾。`);
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
    setSnippetTab('client');
    void checkRealRoute(nextBundle);
    void runTest(nextBundle, 'safe');
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
        body: JSON.stringify(dryRunBody(protocol, target.requestType, target.appCallerCode, requestId)),
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
  const issueDisabled = organizationLoading || creatingStage !== null || blockedByTeam;
  const stepTone = (done: boolean, active: boolean) => done ? 'is-done' : active ? 'is-active' : '';

  return (
    <PageShell>
      <PageHeader
        title="Quickstart"
        subtitle="选客户端，签一把密钥，当场跑通一条请求。"
      />

      <PageBody>
        {/*
          老手条只承载「长期事实」：Base URL 与当前已有密钥的前缀。主卡里不再重复渲染地址，
          右栏只展示「这一次签出来的」产物——两者是分工，不是同一个值渲染两遍。
          新人四步清单已经在首页常驻，这里不放第二份；真正会挡住人的前置（租户没有团队）
          直接以阻断提示长在第 2 步里，用户不必先读一份清单再自己对号入座。
        */}
        <AccessSnippetBar />

        <div className="lg-qs-columns">
          <div className="lg-qs-steps">
            <section className={`lg-qs-step ${stepTone(Boolean(bundle), !bundle)}`} aria-label="第一步：选你要接什么">
              <header>
                <span className="lg-qs-step-index">1</span>
                <strong>选你要接什么</strong>
                {bundle && canCreateAccess ? <button type="button" className="lg-text-link lg-qs-step-action" onClick={() => void editIdentity()}>更改</button> : null}
              </header>
              {identityLocked ? (
                <div className="lg-qs-locked-preset"><strong>{selectedClient.label}</strong><span>{selectedClient.description}</span></div>
              ) : (
                <div className="lg-client-presets" role="radiogroup" aria-label="接入方式">
                  {CLIENT_PRESETS.map((item) => (
                    <button key={item.id} type="button" role="radio" aria-checked={clientPreset === item.id} className={clientPreset === item.id ? 'is-active' : ''} onClick={() => selectClientPreset(item.id)}>
                      <strong>{item.label}</strong>
                      <span>{item.description}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className={`lg-qs-step ${stepTone(Boolean(bundle), !bundle)}`} aria-label="第二步：签出密钥">
              <header>
                <span className="lg-qs-step-index">2</span>
                <strong>签出密钥</strong>
                <span className="lg-qs-step-hint">{bundle ? '已签发一把' : blockedByTeam ? '前置未满足' : '一次点击'}</span>
              </header>
              {!canCreateAccess ? <ReadOnlyNotice>当前角色不能创建 appCaller、签发密钥或执行安全直测。</ReadOnlyNotice> : null}
              {organizationLoading ? <SectionLoader text="正在读取当前租户和团队" /> : null}
              {organizationError ? <div className="lg-test-result is-error">{organizationError}</div> : null}
              {blockedByTeam ? <div className="lg-quickstart-prerequisite" role="status"><span><strong>先创建一个团队</strong><small>团队决定调用用途与密钥归谁管。</small></span><Link to="/organization">打开组织与团队</Link></div> : null}

              {canCreateAccess && !bundle ? (
                <Button variant="primary" className="lg-qs-primary" title={blockedByTeam ? '请先创建团队' : undefined} disabled={issueDisabled} onClick={() => void createAccessBundle()}>
                  <KeyRound size={14} />{creatingStage ? '正在签发…' : '签出密钥并跑通一条请求'}
                </Button>
              ) : null}
              {canCreateAccess && bundle ? (
                <Button variant="ghost" size="sm" className="lg-qs-secondary" disabled={issueDisabled} onClick={() => void createAccessBundle()}>再签一把同配置 key</Button>
              ) : null}
              <p style={{ ...BODY_TEXT, margin: `${GAP.tight}px 0 0` }}>不创建通配 key；默认 60 次/分钟，只授权当前调用用途与四种协议，签发后自动跑一次安全试跑。</p>

              {!organizationLoading ? (
                <>
                  <div className="lg-quickstart-summary">
                    <span><small>团队</small><strong>{selectedTeam?.name || '尚未选择'}</strong></span>
                    <span><small>调用用途</small><strong>{appCallerCode}</strong></span>
                    <span><small>协议</small><strong>{selectedProtocol.label}</strong></span>
                  </div>
                  <details className="lg-quickstart-advanced-identity">
                    <summary>高级身份与地址（已有默认值）</summary>
                    <div className="lg-quickstart-inputs" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: GAP.section, marginTop: GAP.section }}>
                      <div style={{ gridColumn: '1 / -1' }}>
                        <div style={labelStyle}>调用类型</div>
                        <div className="lg-quickstart-request-types" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: GAP.normal, marginTop: GAP.tight }}>
                          {REQUEST_TYPES.map((item) => <button key={item.id} type="button" disabled={identityLocked} onClick={() => changeRequestType(item.id)} aria-pressed={requestType === item.id} className={requestType === item.id ? 'is-active' : ''}><strong>{item.label}</strong><span>{item.description}</span></button>)}
                        </div>
                      </div>
                      <label style={labelStyle}>团队<select value={teamId} disabled={!canCreateAccess || identityLocked} onChange={(event) => setTeamId(event.target.value)} style={inputStyle}><option value="">选择团队</option>{activeTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
                      <Field label={`appCallerCode（以 ::${requestType} 结尾）`} value={appCallerCode} onChange={setAppCallerCode} placeholder={`my-agent.quickstart::${requestType}`} disabled={!canCreateAccess || identityLocked} />
                      <Field label="Client code" value={clientCode} onChange={setClientCode} placeholder="my-agent" disabled={!canCreateAccess || identityLocked} />
                      <label style={labelStyle}>环境<select value={environment} disabled={!canCreateAccess || identityLocked} onChange={(event) => setEnvironment(event.target.value)} style={inputStyle}><option value="development">开发</option><option value="test">测试</option><option value="staging">预发布</option><option value="production">生产</option></select></label>
                      <label style={labelStyle}>Gateway 地址<code className="lg-derived-base-url">{baseUrl}</code></label>
                      <label style={labelStyle}>测试路径<code className="lg-derived-base-url">{selectedProtocol.path}</code></label>
                      <Field label="自定义 Gateway 地址" value={baseUrl} onChange={changeBaseUrl} />
                    </div>
                  </details>
                </>
              ) : null}
              {actionError ? <div className="lg-test-result is-error" role="alert">{actionError}</div> : null}
            </section>

            <section className="lg-qs-step lg-qs-step-tail" aria-label="第三步与第四步">
              <div className={`lg-qs-tail-row ${bundle ? 'is-done' : ''}`}>
                <span className="lg-qs-step-index">3</span>
                <div><strong>拿到三件东西</strong><small>地址、一次性密钥、可直接复制的请求片段。</small></div>
              </div>
              <div className={`lg-qs-tail-row ${phase === 'issued' ? 'is-done' : phase === 'verifying' ? 'is-active' : ''}`}>
                <span className="lg-qs-step-index">4</span>
                <div><strong>当场验证</strong><small>{phase === 'verifying' ? '正在跑安全试跑（dry-run，不打上游）。' : phase === 'failed' ? '这一环没过，右侧给出下一步。' : phase === 'issued' ? '安全试跑已通过，requestId 可回查。' : '签发后自动跑一次安全试跑。'}</small></div>
              </div>
            </section>

            {/* 三处解释块合并成这一处：身份、两种测试的通过判据、失败定位，默认收起。 */}
            <DetailsBlock title="工作原理：三个身份、两种测试与失败定位">
              <dl style={dlStyle}>
                <RouteRow name="service key" text="回答谁在调用；绑定 tenant、team、client、environment、appCaller 和协议。" />
                <RouteRow name="appCallerCode" text="回答为什么调用；用于提示词策略、预算、限流、统计与专属路由。" />
                <RouteRow name="model pool" text="回答去哪里调用；默认池与特殊池由平台规则管理，不由 key 承担。" />
                <RouteRow name="安全连通" text="发送 X-Gateway-Dry-Run: quickstart，在模型解析、预算预占和上游发送前结束；HTTP 成功、返回 requestId 且 upstreamCalled=false 才算通过。" />
                <RouteRow name="真实模型" text="只有路由预览成功且不是明显开发桩时才能点击；请求不带 dry-run，并把实际结果写入同一套租户日志。" />
                <RouteRow name="调用类型" text={displayBundle.requestType === 'vision' ? '图片理解：使用内嵌的 1×1 测试图片，只验证多模态协议形状，不读取用户文件。' : '文字对话：使用固定的测试文字，只验证 chat 协议形状。'} />
                <RouteRow name="401 / 403" text="401 是密钥错误、过期或已撤销；403 是团队、appCaller、协议、scope 或来源范围不匹配。失败时右侧会直接指出坏在哪一环。" />
                <RouteRow name="审计边界" text="日志记录服务端解析的 tenant、team、service key、client 和 environment；不记录密钥明文，费用保持 unknown。" />
              </dl>
              <Prose>
                首版提示词策略只用于 chat/vision。图片生成、ASR、视频和 raw 接口不通过本页批量试跑；
                需要真实协议验收时，每类最多一次，其余使用假上游。
              </Prose>
              <TutorialLink chapter="chapter-11">查看教程：第 11 章 自助接入</TutorialLink>
            </DetailsBlock>
          </div>

          <div className="lg-qs-products">
            {phase === 'idle' ? (
              <Card style={CARD_BODY}>
                <h2 style={headingStyle}><ShieldCheck size={15} />签出后，这里会出现三件东西</h2>
                <p style={{ ...BODY_TEXT, margin: `0 0 ${GAP.normal}px` }}>密钥拿到之后，片段才带真实值。</p>
                <div className="lg-qs-empty-list">
                  <span>Gateway 地址与测试路径</span>
                  <span>一次性密钥（只显示一次）</span>
                  <span>请求片段：客户端配置 / cURL / 环境变量 / Agent Skill</span>
                </div>
                <details className="lg-qs-preview-snippet">
                  <summary>先看一眼请求片段（密钥仍是占位符）</summary>
                  <pre style={preStyle}><code>{snippets.curl}</code></pre>
                </details>
              </Card>
            ) : null}

            {phase === 'issuing' ? (
              <Card style={CARD_BODY}>
                <h2 style={headingStyle}><ShieldCheck size={15} />正在生成接入配置</h2>
                <ol className="lg-qs-stages">
                  <li className={creatingStage === 'app-caller' ? 'is-active' : 'is-done'}><strong>登记调用用途</strong><small>appCaller {appCallerCode}</small></li>
                  <li className={creatingStage === 'key' ? 'is-active' : ''}><strong>签发团队密钥</strong><small>{creatingStage === 'key' ? '正在写入密钥目录' : '等待上一步产物'}</small></li>
                </ol>
              </Card>
            ) : null}

            {bundle && (phase === 'issued' || phase === 'verifying' || phase === 'failed') ? (
              <Card style={CARD_BODY}>
                <div className="lg-qs-products-heading">
                  <h2 style={headingStyle}><ShieldCheck size={15} />你的接入产物</h2>
                  <Chip label={phase === 'failed' ? '待处理' : phase === 'verifying' ? '验证中' : '已签发'} color={phase === 'failed' ? 'var(--warn)' : 'var(--ok)'} bg={phase === 'failed' ? 'var(--warn-bg)' : 'var(--ok-bg)'} />
                </div>

                {/*
                  结果块置顶：它是这一屏真正的产物。放在地址与密钥之后就会落到产物栏的
                  内部滚动区之下，1440x900 下要再滚一屏才看得见——那等于把「失败在哪」藏起来。
                */}
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

                <div className="lg-qs-product-row">
                  <span>Gateway 地址</span>
                  <code>{`${displayBundle.baseUrl}${selectedProtocol.path}`}</code>
                  <Button size="sm" variant="ghost" onClick={() => void copyText('base-url', `${displayBundle.baseUrl}${selectedProtocol.path}`)}>{copied === 'base-url' ? <Check size={13} /> : <Copy size={13} />}{copied === 'base-url' ? '已复制' : '复制'}</Button>
                </div>

                <div className="lg-quickstart-secret">
                  <div><strong>一次性密钥</strong><small>只存在本页内存，刷新即丢失，没有「再看一次」。</small></div>
                  <code>{bundle.key}</code>
                  <Button size="sm" onClick={() => void copyText('key', bundle.key)}>{copied === 'key' ? <Check size={14} /> : <Copy size={14} />}{copied === 'key' ? '已复制' : '复制密钥'}</Button>
                </div>

                <div className="lg-qs-snippet-head">
                  <strong style={SECTION_TITLE}>请求片段</strong>
                  <select
                    aria-label="入口协议"
                    value={protocol}
                    onChange={(event) => { setProtocol(event.target.value as Protocol); setTestResult(null); if (bundle) void checkRealRoute(bundle); }}
                    style={inputStyle}
                  >
                    {PROTOCOLS.map((item) => <option key={item.id} value={item.id}>{`${item.label} ${item.path}`}</option>)}
                  </select>
                </div>
                <div className="lg-snippet-tabs">
                  <Button size="sm" variant={snippetTab === 'client' ? 'primary' : 'ghost'} onClick={() => setSnippetTab('client')}>{selectedClient.label}</Button>
                  <Button size="sm" variant={snippetTab === 'curl' ? 'primary' : 'ghost'} onClick={() => setSnippetTab('curl')}>cURL</Button>
                  <Button size="sm" variant={snippetTab === 'env' ? 'primary' : 'ghost'} onClick={() => setSnippetTab('env')}>环境变量</Button>
                  <Button size="sm" variant={snippetTab === 'skill' ? 'primary' : 'ghost'} onClick={() => setSnippetTab('skill')}><FileCode2 size={14} />Agent Skill</Button>
                </div>
                {snippetTab === 'client' && bundle.clientPreset !== 'api' ? (
                  <ClientQuickSetup bundle={displayBundle} copied={copied} onCopy={copyText} />
                ) : (
                  <div style={{ position: 'relative' }}>
                    <pre style={preStyle}><code>{visibleSnippet}</code></pre>
                    <Button size="sm" style={{ position: 'absolute', top: 9, right: 9 }} onClick={() => void copyText(snippetTab, visibleSnippet)}>{copied === snippetTab ? <Check size={14} /> : <Copy size={14} />}{copied === snippetTab ? '已复制' : '复制'}</Button>
                  </div>
                )}
                <Prose style={{ marginTop: GAP.normal }}>{snippetMode === 'safe' ? <>示例默认带 <code>X-Gateway-Dry-Run: quickstart</code>，不产生上游费用。</> : <>示例不带 dry-run，会真实调用模型。</>} 密钥不要进仓库、截图或日志。</Prose>

                <div className="lg-safe-test-panel" style={{ marginTop: GAP.section }}>
                  <div><Play size={17} /><span><strong>再测一次</strong><small>安全连通不访问上游；真实模型会计费。</small></span></div>
                  <div className="lg-test-mode" role="group" aria-label="测试模式">
                    <button type="button" className={testMode === 'safe' ? 'is-active' : ''} onClick={() => { setTestMode('safe'); setTestResult(null); }}>安全连通</button>
                    <button type="button" className={testMode === 'real' ? 'is-active' : ''} disabled={!realRouteReady || routeChecking} title={!realRouteReady ? '在下方展开真实路由，确认当前地址已就绪' : undefined} onClick={() => { setTestMode('real'); setTestResult(null); }}>真实模型</button>
                  </div>
                  <div className="lg-safe-test-controls">{canCreateAccess ? <Button variant="primary" disabled={testing || (testMode === 'real' && !realRouteReady)} onClick={() => void runTest()}>{testing ? (testMode === 'real' ? '正在等待真实模型' : '正在验证并写日志') : testMode === 'real' ? '发送一次真实请求' : '验证接入边界'}</Button> : null}<span style={{ alignSelf: 'center', color: 'var(--text-muted)', fontSize: 'var(--fs-secondary)' }}>{canCreateAccess ? (testMode === 'real' ? '只调用下方已解析的真实模型' : '返回 requestId 且 upstreamCalled=false 才算通过') : '请联系 Owner、Admin 或 Developer 完成签发与测试'}</span></div>
                </div>

                <details className="lg-route-preview" style={{ marginTop: GAP.section }}>
                  <summary className="lg-route-preview-heading"><Server size={17} /><span><strong>真实路由与排障</strong><small>{currentRoutePreview?.success ? `${currentRoutePreview.actualPlatformName || currentRoutePreview.actualPlatformId || 'Provider'} · ${currentRoutePreview.actualModel || '已解析模型'}` : '首次接入不必展开；需要调用真实模型或排查时再查看。'}</small></span></summary>
                  {routeChecking ? <p>正在检查路由。</p> : currentRoutePreview?.success ? (
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
                  <Button size="sm" variant="ghost" disabled={routeChecking} onClick={() => void checkRealRoute()}>{routeChecking ? '检查中' : '重新检查'}</Button>
                </details>

                <details className="lg-quickstart-follow-up">
                  <summary>后续治理：提示词策略</summary>
                  <div>
                    <span><strong>给这个 {requestTypeLabel(bundle.requestType)} appCaller 配置提示词策略</strong><small>预览不保存、不调用模型。</small></span>
                    {canManagePromptPolicy ? <Link to={`/app-callers/${encodeURIComponent(bundle.appCallerId)}/prompt-policy`}>打开提示词策略</Link> : <span>请由 Owner 或 Admin 配置策略</span>}
                  </div>
                </details>
              </Card>
            ) : null}
          </div>
        </div>
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

function requestTypeLabel(requestType: RequestType) {
  return requestType === 'vision' ? '图片理解' : '文字对话';
}

function createRequestId() {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replaceAll('-', '')
    : `${Date.now()}${Math.random().toString(16).slice(2)}`;
  return `quickstart-${suffix.slice(0, 24)}`;
}

function dryRunBody(protocol: Protocol, requestType: RequestType, appCallerCode: string, requestId: string) {
  if (protocol === 'native') return {
    appCallerCode,
    modelType: requestType,
    requestBody: { messages: [{ role: 'user', content: requestType === 'vision' ? visionOpenAiContent() : 'Reply with OK' }] },
    context: { requestId, sourceSystem: 'external', modelPolicy: 'auto' },
  };
  if (protocol === 'claude') return { model: 'auto', model_policy: 'auto', max_tokens: 64, messages: [{ role: 'user', content: requestType === 'vision' ? visionClaudeContent() : 'Reply with OK' }] };
  if (protocol === 'gemini') return { model_policy: 'auto', contents: [{ role: 'user', parts: requestType === 'vision' ? visionGeminiParts() : [{ text: 'Reply with OK' }] }] };
  return { model: 'auto', model_policy: 'auto', messages: [{ role: 'user', content: requestType === 'vision' ? visionOpenAiContent() : 'Reply with OK' }], stream: false };
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

function exampleFor(protocol: Protocol, requestType: RequestType, baseUrl: string, appCaller: string, mode: TestMode) {
  const definition = protocolDefinition(protocol);
  const requestIdToken = '__LLMGW_REQUEST_ID__';
  const common = `-H "Authorization: Bearer \$LLMGW_API_KEY" \\
  -H "X-Gateway-Source: external" \\
  -H "X-Gateway-App-Caller: ${appCaller}" \\${mode === 'safe' ? '\n  -H "X-Gateway-Dry-Run: quickstart" \\' : ''}
  -H "X-Request-Id: \$REQUEST_ID"`;
  const body = JSON.stringify(dryRunBody(protocol, requestType, appCaller, requestIdToken), null, 2)
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
