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
import { AlertCircle, Check, CheckCircle2, Copy, KeyRound, Play, Upload } from 'lucide-react';
import { Link } from 'react-router-dom';
import { bulkClaimConfigAuthority, createGatewayAppCaller, createServiceKey, draftAppCallerIntent, ensurePoolTypes, getOrganization, getPools, getPoolTypes, updateGatewayAppCaller } from '@/lib/api';
import type { OrganizationData } from '@/lib/types';
import { Button, Card, Chip, ReadOnlyNotice, SectionLoader } from '@/components/ui';
import { AccessSnippetBar } from '@/components/AccessSnippetBar';
import { DetailsBlock, PageBody, PageHeader, PageShell, TutorialLink } from '@/components/PageShell';
import { invalidateOnboardingCache, markRequestCompleted } from '@/lib/onboarding';
import { INTENT_ACTORS, INTENT_TASKS, MIN_INTENT_LENGTH, analyzeAppCallerIntent, buildAppCallerCode } from '@/lib/appCallerIntent';
import type { IntentFacet, IntentTask } from '@/lib/appCallerIntent';
import { useDialogs } from '@/components/ConfirmDialog';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';
import { CARD_BODY, GAP } from '@/lib/surface';
import { BODY_TEXT, FIELD_INPUT, FIELD_LABEL } from '@/lib/typography';

type Protocol = 'native' | 'openai' | 'claude' | 'gemini';
type RequestType = 'chat' | 'vision';
type ResultTab = 'access' | 'curl' | 'prompt';
type PromptWay = 'system' | 'skill' | 'client';
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

/**
 * Gemini 入口的模型优先从路由段 `models/{model}:generateContent` 读——那是这个协议的原生形状。
 * 名字带斜杠的模型（聚合型上游的 `厂商/模型`）放不进单个路由段，这里不赌 `%2F` 能不能匹配路由，
 * 而是保持路由段为 auto、把模型放在 body 里：serving 的 Gemini 入口在路由段为 auto 时会回退
 * 读 body 的 model，两条路都落到同一个模型上。
 */
function geminiRouteModel(model: string): string | null {
  if (!model || model === 'auto' || model.includes('/')) return null;
  return model;
}

/** 本次请求真正要打的路径：Gemini 把选中的模型写进路由段，其余协议是固定路径。 */
function protocolPathFor(definition: ProtocolDefinition, model: string): string {
  if (definition.ingressProtocol !== 'gemini-compatible') return definition.path;
  return `/v1beta/models/${encodeURIComponent(geminiRouteModel(model) ?? 'auto')}:generateContent`;
}

/**
 * 这次调用真正钉住的模型。Gemini 走路由段或 body 都能钉住，所以各协议一致——
 * 页面各处的「实际执行」读它，语义是「这次请求钉住了谁」，不是「输入框里写了谁」。
 */
function pinnedTestModel(_protocol: Protocol, model: string): string {
  return model;
}

/**
 * 接入方式只决定「复制走的是哪种片段」与 clientCode，**不再预填 appCallerCode**。
 * 以前 Cherry Studio 一档带着现成的码，点一下就能绕过「说清用途」这道门。
 */
const CLIENT_PRESETS: Array<{
  id: ClientPresetId;
  label: string;
  description: string;
  clientCode: string | null;
}> = [
  { id: 'api', label: 'API 与 Agent', description: '复制 cURL、环境变量或 Agent Skill。', clientCode: null },
  { id: 'cherry-studio', label: 'Cherry Studio', description: '生成地址、API Key 和模型三项配置。', clientCode: 'cherry-studio' },
  { id: 'openclaw', label: 'OpenClaw', description: '生成可直接粘贴的 provider 配置。', clientCode: 'openclaw-agent' },
];

/** 第一屏的示例句：点一下就填进去，省掉「对着空白框发呆」那几秒。 */
const INTENT_SAMPLES = [
  '接入小米音响，对接大模型网关指令集',
  '桌面客户端里做售后客服问答',
  '后端服务批量做图片理解',
];

/**
 * 产物屏三个页签：一页只讲一件事。
 *
 * 只留标签、不带副标题——它是导航，不该和内容同重（设计稿 Main 画板：分段控件）。
 * 之前三张带副标题的大卡占掉整整一行，把真正的产物挤到折线附近。
 */
const RESULT_TABS: Array<{ id: ResultTab; label: string }> = [
  { id: 'access', label: '接入信息' },
  { id: 'curl', label: 'cURL' },
  { id: 'prompt', label: '提示词' },
];

/** 提示词页签下的三种取用方式。 */
const PROMPT_WAYS: Array<{ id: PromptWay; label: string; note: string }> = [
  { id: 'system', label: '系统提示词', note: '粘进你自己应用的 system prompt。' },
  { id: 'skill', label: 'Agent Skill', note: '存成 Agent 的技能文件。' },
  { id: 'client', label: '客户端配置', note: '按客户端逐项填。' },
];

const REQUEST_TYPES: Array<{ id: RequestType; label: string }> = [
  { id: 'chat', label: '文字对话' },
  { id: 'vision', label: '图片理解' },
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
  MODEL_NOT_IN_CATALOG: { brokenLink: 'pool', title: '选中的模型不在名录里', reason: '这个模型既不在内置名录，也没有被管理员放行——正常从 Provider 页导入的模型不会这样，先确认它是怎么进库的。', to: '/pools', actionLabel: '打开模型池' },
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
  const [appCallerCode, setAppCallerCode] = useState('');
  /**
   * 「我想要做什么」是这一页唯一系统无从得知的东西，也是颁发调用用途码的唯一依据。
   * 说不清楚就不颁发——这里没有默认值，也不许兜底成 `xxx.quickstart` 那种占位码。
   */
  const [intent, setIntent] = useState('');
  /** 这句话里没认出来时，用户从有限清单里自己指定的那一段。 */
  const [actorPick, setActorPick] = useState<string | null>(null);
  const [taskPick, setTaskPick] = useState<string | null>(null);
  /** 展开哪一段的备选清单（认出来了就收起来，别拿二十个 chip 占版面）。 */
  const [openFacet, setOpenFacet] = useState<'actor' | 'task' | null>(null);
  /**
   * 三屏一条线：先说要做什么 → 看颁发的码 → 落归属与预算。签发完自动进产物屏。
   * 「怎么接进去」不再问用户——它是结果的呈现形态，收进产物屏的页签。
   */
  const [stage, setStage] = useState<'intent' | 'draft' | 'owner'>('intent');
  const [drafting, setDrafting] = useState(false);
  /** 模型边推边吐的原文：等待期屏幕上动的就是它（规则 #6，不给静止的加载中）。 */
  const [draftTrace, setDraftTrace] = useState('');
  const [draftStageText, setDraftStageText] = useState('');
  const [draftReason, setDraftReason] = useState('');
  const [draftModel, setDraftModel] = useState('');
  /** 这条码是谁给的：模型草案 / 本地关键词降级 / 用户手改。必须让用户看得见。 */
  const [codeSource, setCodeSource] = useState<'model' | 'fallback' | 'manual' | null>(null);
  /** 降级说明：模型没接通时如实写清楚，不假装模型给过意见。 */
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  /** 调用类型默认跟着「要做什么」走；用户自己点过就不再自动跟。 */
  const [requestTypeTouched, setRequestTypeTouched] = useState(false);
  const [clientCode, setClientCode] = useState('my-agent');
  const [environment, setEnvironment] = useState('test');
  const [teamId, setTeamId] = useState('');
  const [organization, setOrganization] = useState<OrganizationData | null>(null);
  const [organizationLoading, setOrganizationLoading] = useState(true);
  const [organizationError, setOrganizationError] = useState<string | null>(null);
  const [creatingStage, setCreatingStage] = useState<'app-caller' | 'key' | null>(null);
  const [bundle, setBundle] = useState<AccessBundle | null>(null);
  /** 产物屏当前页签，与提示词页签下的取用方式。 */
  const [resultTab, setResultTab] = useState<ResultTab>('access');
  const [promptWay, setPromptWay] = useState<PromptWay>('system');
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
  // 成员要连**上游 id** 一起留着：钉一个成员的契约是「平台 + 模型」两个都给，
  // 只给模型名的话解析器根本构造不出 pinned target，回的是 ROUTE_CONFIG_INCOMPATIBLE。
  const [poolModels, setPoolModels] = useState<Array<{ modelId: string; platformId: string }>>([]);
  const [poolName, setPoolName] = useState('');
  const [poolMemberCount, setPoolMemberCount] = useState(0);
  const [modelQuery, setModelQuery] = useState('');
  /** 用户上传的测试图片（图片理解用）；文字一律走下面那个可直接编辑的输入框。 */
  const [attachment, setAttachment] = useState<{ name: string; kind: 'image'; dataUrl: string } | null>(null);
  /** 试跑要发的正文：用户自己写，上传文本也填进这里，cURL 片段与真实请求都读它。 */
  const [testPrompt, setTestPrompt] = useState('');
  /** 上一次试跑真实耗时（毫秒）：输出块要给出「多久回来的」，不是只给一段文字。 */
  const [testElapsedMs, setTestElapsedMs] = useState<number | null>(null);
  /** 本次试跑的起点 + 一个 100ms 的心跳：等待期间「已用 X.Xs」要真的在跳，不是一个静止的字。 */
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [, setHeartbeat] = useState(0);
  /** 真实调用的返回：文字边收边渲染，图片/音频收完再渲染。 */
  const [liveOutput, setLiveOutput] = useState<{ kind: 'text' | 'image' | 'audio'; text: string; url?: string; done: boolean } | null>(null);
  const [binding, setBinding] = useState(false);
  const [bindNotice, setBindNotice] = useState<string | null>(null);
  // 月预算是本页唯一要用户想的数字；单次预占上限由它派生（成对约束见 budgetPair）。
  const [budgetUsd, setBudgetUsd] = useState('');
  const [holdCapUsd, setHoldCapUsd] = useState('');

  useEffect(() => {
    if (!testing) return undefined;
    const timer = window.setInterval(() => setHeartbeat((value) => value + 1), 100);
    return () => window.clearInterval(timer);
  }, [testing]);

  const selectedProtocol = protocolDefinition(protocol);
  const activeTeams = organization?.teams.filter((team) => team.status === 'active') ?? [];
  const selectedTeam = activeTeams.find((team) => team.id === teamId);
  const budgetPair = deriveBudgetPair(budgetUsd, holdCapUsd);
  // 输入框空着就是 auto；填了就必须是这个池里的健康成员，否则不让执行（选了也是白跑）。
  const testModel = modelQuery.trim() || 'auto';
  const modelValid = testModel === 'auto' || poolModels.some((model) => model.modelId === testModel);
  // 钉成员时要一起发的上游 id。取不到就说明这个名字不在池里，上面那条判据已经拦下了。
  const testPlatformId = poolModels.find((model) => model.modelId === testModel)?.platformId ?? '';
  // 页面各处说「实际执行 X」时必须用这个，不能用输入框里那个：Gemini 钉不住的模型
  // 会退回池调度，照着输入框声称就是在编造一个没发生的执行结果。
  const effectiveTestModel = pinnedTestModel(protocol, testModel);
  const modelHint = !modelValid
    ? '这个模型不在池内健康成员里，换一个或清空走 auto。'
    : poolModels.length === 0
      ? '池内暂无健康成员，走 auto。'
      : `「${poolName || '默认池'}」${poolMemberCount} 个成员中 ${poolModels.length} 个健康，可搜索。`;
  /*
    调用用途码只从用户那句「我想做什么」来。首选让网关自己的模型推（它读得懂
    「接入小米音响，对接大模型网关指令集」这种关键词表覆盖不到的说法）；
    模型没接通时退回本地关键词表，并**明说这是降级判定**；两条都不成立就让用户
    从有限清单里自己指定。任何情况下都不兜底成一个谁也看不懂的占位码。
  */
  const intentAnalysis = useMemo(() => analyzeAppCallerIntent(intent), [intent]);
  const actorFacet: (IntentFacet & { matched?: string }) | null = actorPick
    ? INTENT_ACTORS.find((item) => item.code === actorPick) ?? null
    : intentAnalysis.actor;
  const taskFacet: (IntentTask & { matched?: string }) | null = taskPick
    ? INTENT_TASKS.find((item) => item.code === taskPick) ?? null
    : intentAnalysis.task;
  const facetCode = actorFacet && taskFacet ? buildAppCallerCode(actorFacet.code, taskFacet.code, requestType) : '';
  // 模型草案或手改过的码优先；都没有时才用本地两段拼出来的那条。
  const derivedAppCallerCode = appCallerCode.trim() || facetCode;
  const purposeReady = isValidAppCaller(derivedAppCallerCode.trim(), requestType);
  const intentMissing = !actorFacet && !taskFacet
    ? '这句话里既没看出谁在调用，也没看出要做什么，请从下面两栏各挑一个。'
    : !actorFacet
      ? '还差「谁在调用」这一段，请在下面挑一个。'
      : !taskFacet
        ? '还差「要做什么」这一段，请在下面挑一个。'
        : '';
  const codeSourceLabel = codeSource === 'model'
    ? `模型推导${draftModel ? `（${draftModel}）` : ''}`
    : codeSource === 'fallback'
      ? '本地关键词判定（降级）'
      : codeSource === 'manual'
        ? '你手动指定'
        : '';
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
        .map((model) => ({ modelId: model.modelId, platformId: model.platformId }));
      // 同名成员可能挂在多个上游下：按模型名去重，保留优先级最高的那一条的上游。
      const seen = new Set<string>();
      setPoolModels(healthy.filter((model) => seen.has(model.modelId) ? false : (seen.add(model.modelId), true)));
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
    appCallerCode: bundle?.appCallerCode ?? derivedAppCallerCode.trim(),
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
    curl: exampleFor(displayBundle.protocol, displayBundle.requestType, displayBundle.baseUrl, displayBundle.appCallerCode, snippetMode, testModel, attachment, testPrompt, testPlatformId),
    env: environmentSnippet(displayBundle),
    skill: agentSkillSnippet(displayBundle, snippetMode),
  }), [displayBundle.protocol, displayBundle.requestType, displayBundle.baseUrl, displayBundle.appCallerCode, displayBundle.key, displayBundle.clientCode, displayBundle.environment, displayBundle.clientPreset, snippetMode, testModel, attachment, testPrompt]);

  const copyText = async (name: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(name);
    window.setTimeout(() => setCopied((current) => current === name ? null : current), 1600);
  };

  /**
   * 提交那句话 → 让网关自己的模型推出两段码。
   *
   * 三条出路，逐级降级，每一级都要让用户看得出这条码是谁给的：
   *   1. 模型给出合法两段码 → codeSource='model'，附上它凭哪些词判的；
   *   2. 模型没接通或没给出可用结果 → 本地关键词表兜底，**明说是降级判定**；
   *   3. 关键词表也认不出来 → 不出码，让用户从有限清单里各挑一个。
   */
  const submitIntent = async () => {
    const text = intent.trim();
    if (text.length < MIN_INTENT_LENGTH) return;
    setStage('draft');
    setDrafting(true);
    setDraftTrace('');
    setDraftReason('');
    setDraftModel('');
    setDraftNotice(null);
    setCodeSource(null);
    setAppCallerCode('');
    
    setActorPick(null);
    setTaskPick(null);
    setDraftStageText('正在把这句话交给网关自己的模型');
    let settled = false;
    /** 模型这条路走不通时的统一兜底：本地关键词表，且必须写清「这是降级」。 */
    const fallbackTo = (message: string) => {
      settled = true;
      const local = analyzeAppCallerIntent(text);
      setDraftNotice(message);
      if (local.actor && local.task) {
        setRequestType(local.task.requestType);
        setAppCallerCode(buildAppCallerCode(local.actor.code, local.task.code, local.task.requestType));
        setCodeSource('fallback');
        setDraftReason(`本地关键词判定：从「${local.actor.matched}」判出调用方，从「${local.task.matched}」判出场景。`);
      } else {
        setCodeSource(null);
        setDraftReason('');
      }
    };
    try {
      await draftAppCallerIntent(text, (frame) => {
        if (frame.type === 'stage') {
          setDraftStageText(frame.text);
          return;
        }
        if (frame.type === 'delta') {
          setDraftTrace((current) => current + frame.text);
          return;
        }
        if (frame.type === 'error') {
          fallbackTo(frame.message);
          return;
        }
        if (frame.type === 'result') {
          if (!frame.ok || !frame.appCallerCode) {
            fallbackTo(frame.reason || '模型没给出可用的两段码，已退回本地关键词判定。');
            return;
          }
          settled = true;
          setRequestType(frame.requestType);
          setRequestTypeTouched(true);
          setAppCallerCode(frame.appCallerCode);
          setCodeSource('model');
          setDraftReason(frame.reason);
          setDraftModel(frame.model);
        }
      });
      if (!settled) fallbackTo('推导没有返回结果，已退回本地关键词判定。');
    } catch (error) {
      fallbackTo(`推导请求失败（${(error as Error).name}），已退回本地关键词判定。`);
    } finally {
      setDrafting(false);
      setDraftStageText('');
    }
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
    // 产物屏默认停在「接入信息」：刚签发出来，用户第一件事是把地址、密钥、用途码复制走。
    setResultTab('access');
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
    const startedAt = Date.now();
    setRunStartedAt(startedAt);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${target.key}`,
        'Content-Type': 'application/json',
        'X-Gateway-Source': 'external',
        'X-Gateway-App-Caller': target.appCallerCode,
        'X-Request-Id': requestId,
      };
      if (mode === 'safe') headers['X-Gateway-Dry-Run'] = 'quickstart';
      const response = await fetch(new URL(protocolPathFor(definition, testModel), `${normalizedBaseUrl}/`).toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify(dryRunBody(protocol, target.requestType, target.appCallerCode, requestId, testModel, attachment, false, testPrompt, testPlatformId)),
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
      setTestElapsedMs(Date.now() - startedAt);
      setTesting(false);
    }
  };

  /**
   * 真实调用：不带 dry-run，会真的打上游并计费，所以只在用户显式点击时发生。
   *
   * OpenAI 兼容协议走流式（stream: true + SSE），文字边收边渲染；其余三个协议
   * 的流式帧格式各不相同，这里不假装支持——它们一次性收完再渲染，并在界面上说明。
   * 返回内容按形状判断：先看有没有图片（b64/url），再看有没有音频，最后当文字。
   */
  const runRealTest = async () => {
    // 闸放在函数里而不是只放在按钮上：按钮是一处调用点，函数是唯一出口。
    // 只守按钮，下一个调用点（快捷键、重试链接、别处的入口）会绕过去。
    if (!bundle || testing || !realRouteReady) return;
    const target = bundle;
    const definition = protocolDefinition(protocol);
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    const requestId = createRequestId();
    const canStream = protocol === 'openai';
    const startedAt = Date.now();
    setRunStartedAt(startedAt);
    setTesting(true);
    setTestResult(null);
    setActionError(null);
    setLiveOutput({ kind: 'text', text: '', done: false });
    try {
      const response = await fetch(new URL(protocolPathFor(definition, testModel), `${normalizedBaseUrl}/`).toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${target.key}`,
          'Content-Type': 'application/json',
          'X-Gateway-Source': 'external',
          'X-Gateway-App-Caller': target.appCallerCode,
          'X-Request-Id': requestId,
        },
        body: JSON.stringify(dryRunBody(protocol, target.requestType, target.appCallerCode, requestId, testModel, attachment, canStream, testPrompt, testPlatformId)),
        credentials: 'omit',
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
        setLiveOutput(null);
        setTestResult({
          ok: false,
          message: readErrorMessage(payload) || `真实调用失败，HTTP ${response.status}`,
          requestId: readRequestId(response, payload) || requestId,
          code: readErrorCode(payload) || `HTTP_${response.status}`,
        });
        return;
      }
      const actualRequestId = readRequestId(response, null) || requestId;
      if (canStream && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let text = '';
        // 上游在响应头发出之后才失败时，HTTP 状态已经是 200 了，失败只能夹在流里回来
        // （finishReason: "error" + 一个 error 对象）。只挑 delta 不看这一帧，就会把一次
        // 真花了钱的失败调用报成成功——用户拿着「成功」去排查，而账单上是失败。
        let streamError: { message: string; code?: string } | null = null;
        // 收没收到完成帧，是与「有没有失败帧」互相独立的一件事：serving 在响应头已发出后
        // 遇到取消会直接收尾——既不发失败帧也不发 [DONE]。只认失败帧的话，这种截断
        // 同样会被当成「收完了」报成功。
        let sawDone = false;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            streamError = streamError ?? readStreamError(line);
            if (line.trim() === 'data: [DONE]') sawDone = true;
            const delta = readStreamDelta(line);
            if (delta === null) continue;
            text += delta;
            setLiveOutput({ kind: 'text', text, done: false });
          }
          if (streamError) break;
        }
        if (streamError) {
          // 已经吐出来的片段留着：它是「跑到一半断了」的证据，比清空更有用。
          setLiveOutput(text ? { kind: 'text', text, done: true } : null);
          setTestResult({
            ok: false,
            message: `真实调用失败：${streamError.message}（上游在流中途报错，这次调用仍会计入用量）`,
            requestId: actualRequestId,
            code: streamError.code || 'UPSTREAM_STREAM_ERROR',
          });
          return;
        }
        if (!sawDone) {
          setLiveOutput(text ? { kind: 'text', text, done: true } : null);
          setTestResult({
            ok: false,
            message: '真实调用未完成：连接在收到结束标记之前就断了，已返回的内容可能是半截（这次调用仍会计入用量）。',
            requestId: actualRequestId,
            code: 'UPSTREAM_STREAM_TRUNCATED',
          });
          return;
        }
        setLiveOutput({ kind: 'text', text, done: true });
      } else {
        const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
        setLiveOutput(readNonStreamOutput(payload));
      }
      markRequestCompleted(tenant?.id);
      setTestResult({ ok: true, message: `真实调用已返回，模型 ${effectiveTestModel === 'auto' ? currentRoutePreview?.actualModel || '由池调度' : effectiveTestModel}；本次会计入用量与费用。`, requestId: actualRequestId });
    } catch (error) {
      setLiveOutput(null);
      setTestResult({ ok: false, message: error instanceof Error ? `真实调用失败：${error.message}` : '真实调用失败。' });
    } finally {
      setTestElapsedMs(Date.now() - startedAt);
      setTesting(false);
    }
  };

  /** 读上传的文件：图片转 data URL 进请求体，文本填进输入框当正文。不上传后端。 */
  const pickAttachment = async (file: File | null) => {
    if (!file) return;
    setTestResult(null);
    if (file.size > 4 * 1024 * 1024) {
      setActionError('测试输入请控制在 4 MB 以内。');
      return;
    }
    setActionError(null);
    if (displayBundle.requestType === 'vision') {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      setAttachment({ name: file.name, kind: 'image', dataUrl });
      return;
    }
    // 文本不做成附件——直接填进输入框，用户能看见、能改，发出去的就是他看到的那段。
    setTestPrompt((await file.text()).slice(0, 4000));
  };

  const editIdentity = async () => {
    if (!bundle) return;
    if (!await confirm({ title: '确认修改身份？', description: '当前一次性密钥明文将从页面清除；已签发密钥仍然有效，可到“接入密钥”页撤销。', tone: 'danger', confirmLabel: '修改身份' })) return;
    setBundle(null);
    setTestResult(null);
    setRoutePreview(null);
    setTestMode('safe');
    // 回到那句话本身：改身份就是改「我想做什么」，不是回到某个中间表单。
    setStage('intent');
  };

  const changeRequestType = (next: RequestType, byUser = true) => {
    if (byUser) setRequestTypeTouched(true);
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

  /*
    调用类型跟着「要做什么」走：说了识图就是图片理解，说了客服就是文字对话。
    推断值必须可见可改——界面上标了它是按哪个词判的，用户点过之后就不再自动跟。
  */
  useEffect(() => {
    if (requestTypeTouched || identityLocked) return;
    const next = taskFacet?.requestType;
    if (next && next !== requestType) changeRequestType(next, false);
  }, [taskFacet?.requestType, requestType, requestTypeTouched, identityLocked]);

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
    ? `已签发 · ${bundle.appCallerCode} · 团队 ${selectedTeam?.name ?? '未指定'} · ${budgetPair.monthly !== null ? `${budgetPair.monthly} USD/月` : '预算不限'}`
    : '';

  return (
    <PageShell>
      <PageHeader
        title="Quickstart"
        subtitle={onCreateScreen ? '先说清要做什么，再签发；密钥在下一屏只显示一次。' : '密钥只显示这一次，复制走再刷新。'}
      />

      <PageBody>
        {onCreateScreen ? (
          /*
            创建线是三屏一条路：说清要做什么 → 看颁发的码 → 落归属与预算。
            每屏只放同一类事，屏与屏之间不共存——「左右一起变」正是上一版要治的毛病。
            「怎么接进去」不在这条线上：它是结果的呈现形态，收进产物屏的页签。
          */
          <div className="lg-qs-flow">
            {phase === 'issuing' ? (
              <Card className="lg-qs-step-card">
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
              </Card>
            ) : stage === 'intent' ? (
              /*
                第一屏只有一件事：把那句话写下来。整块画布让给输入框，
                没有第二个控件抢注意力——用户此刻唯一要做的决定就是「我想做什么」。
              */
              <section className="lg-qs-ask" aria-label="第一步 说清要做什么">
                <div className="lg-qs-ask-inner">
                  <h2 className="lg-qs-ask-title">我想做什么</h2>
                  <p className="lg-qs-ask-sub">一句话说清：谁在调用、要做什么。</p>
                  <textarea
                    className="lg-qs-ask-input"
                    aria-label="我想做什么"
                    rows={4}
                    autoFocus
                    placeholder="例如：接入小米音响，对接大模型网关指令集"
                    value={intent}
                    maxLength={500}
                    disabled={!canCreateAccess}
                    onChange={(event) => setIntent(event.target.value)}
                    onKeyDown={(event) => {
                      // Ctrl/Cmd + Enter 直接提交：这一屏只有一个动作，不该逼人去够按钮。
                      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submitIntent();
                    }}
                  />
                  <div className="lg-qs-ask-foot">
                    <div className="lg-qs-ask-samples">
                      {INTENT_SAMPLES.map((sample) => (
                        <button key={sample} type="button" disabled={!canCreateAccess} onClick={() => setIntent(sample)}>{sample}</button>
                      ))}
                    </div>
                    <Button
                      variant="primary"
                      className="lg-qs-primary"
                      disabled={!canCreateAccess || intent.trim().length < MIN_INTENT_LENGTH}
                      onClick={() => void submitIntent()}
                    >准备接入</Button>
                  </div>
                  {!canCreateAccess ? <ReadOnlyNotice>当前角色不能创建 appCaller、签发密钥或执行安全直测。</ReadOnlyNotice> : null}
                </div>
              </section>
            ) : stage === 'draft' ? (
              /*
                第二屏：模型边推边吐，推完把码亮出来。
                这条码是谁给的（模型 / 本地降级 / 手改）必须写在脸上，用户才敢信它。
              */
              <Card className="lg-qs-step-card">
                <div className="lg-qs-step-head">
                  <div className="lg-qs-step-head-row">
                    <span className="lg-qs-step-no">2</span>
                    <div><strong>颁发调用用途码</strong></div>
                    <button type="button" className="lg-text-link" onClick={() => setStage('intent')}>改那句话</button>
                  </div>
                  {/* 副标题落第二行：和右上角的「改那句话」共处一条基线时，长一点就会撞上。 */}
                  <small className="lg-qs-step-sub">按你写的那句话推导</small>
                </div>
                {/* 层 1 · 你说的那句话 */}
                <div className="lg-qs-labeled">
                  <span className="lg-qs-label">你写的</span>
                  <blockquote className="lg-qs-quote">{intent}</blockquote>
                </div>

                {drafting ? (
                  <div className="lg-qs-thinking" role="status" aria-live="polite">
                    <div className="lg-qs-thinking-head"><strong>{draftStageText || '正在推导'}</strong><span className="lg-qs-thinking-dots"><i /><i /><i /></span></div>
                    <pre>{draftTrace}<span className="lg-qs-caret" /></pre>
                  </div>
                ) : null}

                {!drafting && draftNotice ? <div className="lg-test-result is-error" role="status">{draftNotice}</div> : null}

                {/*
                  层 2 · 系统推出来的结果。
                  码、来源、理由同属「系统给的结论」，收进同一个块里纵向叙述；
                  调用类型是「你要做的选择」，拆成下面那个独立字段。
                  旧版把两者塞进同一行 space-between，于是左右拉开、中间空着。
                */}
                {!drafting && derivedAppCallerCode ? (
                  <div className="lg-qs-layer">
                    <div className="lg-qs-issue is-ready">
                      <div className="lg-qs-issue-code">
                        <span>将颁发</span>
                        <code>{derivedAppCallerCode}</code>
                      </div>
                      {codeSourceLabel || draftReason ? (
                        <div className="lg-qs-draft-meta">
                          {codeSourceLabel ? <span className="lg-qs-draft-source">{codeSourceLabel}</span> : null}
                          {draftReason ? <span className="lg-qs-draft-reason">{draftReason}</span> : null}
                        </div>
                      ) : null}
                    </div>
                    <div className="lg-qs-labeled">
                      <span className="lg-qs-label">调用类型</span>
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
                    </div>
                  </div>
                ) : null}

                {/*
                  两段判定只在「模型没给出可用结果」时才摊开：模型正常时用户不需要看见它，
                  降级时它是唯一能让用户自己把码补齐的出口。
                */}
                {!drafting && codeSource !== 'model' ? (
                  <div className="lg-qs-facets">
                    <FacetRow
                      title="谁在调用"
                      facet={actorFacet}
                      options={INTENT_ACTORS}
                      picked={actorPick}
                      open={openFacet === 'actor'}
                      disabled={!canCreateAccess || identityLocked}
                      onToggle={() => setOpenFacet((current) => current === 'actor' ? null : 'actor')}
                      onPick={(code) => { setAppCallerCode(''); setCodeSource('manual'); setActorPick(code); }}
                    />
                    <FacetRow
                      title="要做什么"
                      facet={taskFacet}
                      options={INTENT_TASKS}
                      picked={taskPick}
                      open={openFacet === 'task'}
                      disabled={!canCreateAccess || identityLocked}
                      onToggle={() => setOpenFacet((current) => current === 'task' ? null : 'task')}
                      onPick={(code) => { setAppCallerCode(''); setCodeSource('manual'); setTaskPick(code); }}
                    />
                  </div>
                ) : null}

                {!drafting && !derivedAppCallerCode ? <span className="lg-qs-issue-miss">{intentMissing}</span> : null}

                <DetailsBlock title="改这条码（高级）">
                  <div className="lg-quickstart-inputs" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: GAP.section }}>
                    <Field label={`appCallerCode（以 ::${requestType} 结尾）`} value={derivedAppCallerCode} onChange={(next) => { setCodeSource('manual'); setAppCallerCode(next); }} placeholder={`{应用}.{用途}::${requestType}`} disabled={!canCreateAccess || identityLocked} />
                    <Field label="Client code" value={clientCode} onChange={setClientCode} placeholder="my-agent" disabled={!canCreateAccess || identityLocked} />
                  </div>
                </DetailsBlock>

                <div className="lg-qs-create-footer">
                  <span style={{ ...BODY_TEXT, margin: 0 }}>先确认这条码说的是你要做的事。</span>
                  <Button variant="secondary" disabled={drafting} onClick={() => void submitIntent()}>重新生成</Button>
                  <Button variant="primary" className="lg-qs-primary" disabled={!purposeReady || drafting} onClick={() => setStage('owner')}>下一步</Button>
                </div>
              </Card>
            ) : (
              /* 第三屏：算谁的。只有两个字段，一屏放完。 */
              <Card className="lg-qs-step-card">
                <div className="lg-qs-step-head">
                  <div className="lg-qs-step-head-row">
                    <span className="lg-qs-step-no">3</span>
                    <div><strong>算谁的</strong></div>
                    <button type="button" className="lg-text-link" onClick={() => setStage('draft')}>回上一步</button>
                  </div>
                  <small className="lg-qs-step-sub">密钥与预算都记在团队名下</small>
                </div>
                <div className="lg-qs-issue is-ready">
                  <div className="lg-qs-issue-code"><span>即将登记</span><code>{derivedAppCallerCode}</code></div>
                </div>

                {organizationLoading ? <SectionLoader text="正在读取当前租户、团队和成员" /> : null}
                {organizationError ? <div className="lg-test-result is-error">{organizationError}</div> : null}
                {blockedByTeam ? (
                  <div className="lg-quickstart-prerequisite" role="status">
                    <span><strong>先创建一个团队</strong><small>团队决定调用用途与密钥归谁管。</small></span>
                    <Link to="/organization">打开组织与团队</Link>
                  </div>
                ) : null}

                <div className="lg-qs-own-row">
                  {/*
                    密钥归团队，不归个人：这里只让人选团队，不再挑「负责人」。
                    谁点的创建由服务端记进审计（createdByUsername），不是用户要填的东西。
                  */}
                  <div className="lg-qs-own-col">
                    <span className="lg-qs-field-title">归属团队</span>
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
                  <div className="lg-qs-own-col">
                    <span className="lg-qs-field-title">月预算<small>留空即不限</small></span>
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
                </div>

                <DetailsBlock title="高级设置（已有默认值）">
                  <div className="lg-quickstart-inputs" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: GAP.section }}>
                    <Field label="单次预占上限（USD，留空按月预算派生）" value={holdCapUsd} onChange={setHoldCapUsd} placeholder="自动" disabled={!canCreateAccess} />
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
                    <span style={{ ...BODY_TEXT, margin: 0 }}>不创建通配 key；默认 60 次/分钟，只授权当前调用用途与四种协议，签发后自动跑一次安全试跑。</span>
                    <Button variant="primary" className="lg-qs-primary" title={blockedByTeam ? '请先创建团队' : undefined} disabled={issueDisabled} onClick={() => void createAccessBundle()}>
                      <KeyRound size={15} />创建密钥
                    </Button>
                  </div>
                ) : null}
              </Card>
            )}

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
            产物屏：三个页签，一页只讲一件事——
            ① 接入信息：地址、密钥、调用用途码，复制走就能用；
            ② cURL：一条能直接跑的请求，连带一键试跑与返回内容；
            ③ 提示词：按调用方式取用（系统提示词 / Agent Skill / 客户端配置）。
            结果条与失败条共用页签上方同一个槽位——成功也要留下 requestId，
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
              <>
                {/*
                  一次性密钥常驻在页签之上，**不属于任何一个页签**。
                  它是这一屏唯一取不回来的东西；放在「接入信息」页签里，切到 cURL 它就消失了。
                  视觉语言与第 2 步的结果块一致（accent 描边 + accent-soft 底），首尾呼应。
                */}
                <div className="lg-qs-key-hero">
                  <div className="lg-qs-key-main">
                    <div className="lg-qs-key-head">
                      <span className="lg-qs-key-eyebrow">一次性密钥</span>
                      <Chip label="只显示一次" color="var(--warn)" bg="var(--warn-bg)" />
                    </div>
                    <code className="lg-qs-key-value">{bundle.key}</code>
                    <small className="lg-qs-key-note">离开或刷新即不可再取；不要进仓库、截图或日志。</small>
                  </div>
                  <Button className="lg-qs-key-copy" onClick={() => void copyText('key', bundle.key)}>
                    {copied === 'key' ? <Check size={16} /> : <Copy size={16} />}
                    {copied === 'key' ? '已复制' : '复制密钥'}
                  </Button>
                </div>

                <div className="lg-qs-result-tabs" role="tablist" aria-label="接入产物">
                  {RESULT_TABS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={resultTab === item.id}
                      className={resultTab === item.id ? 'is-active' : ''}
                      onClick={() => setResultTab(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>

                {resultTab === 'access' ? (
                  <div className="lg-qs-access-grid">
                    <Card style={CARD_BODY} className="lg-qs-hero">
                      <div className="lg-qs-hero-head">
                        <strong>接入地址</strong>
                        <Button size="sm" variant="ghost" onClick={() => void copyText('base-url', `${displayBundle.baseUrl}${selectedProtocol.path}`)}>{copied === 'base-url' ? <Check size={13} /> : <Copy size={13} />}{copied === 'base-url' ? '已复制' : '复制'}</Button>
                      </div>
                      <code className="lg-qs-hero-value">{`${displayBundle.baseUrl}${selectedProtocol.path}`}</code>
                      <small className="lg-qs-hero-note">协议在 cURL 页签可切。</small>
                    </Card>

                    <Card style={CARD_BODY} className="lg-qs-hero is-caller">
                      <div className="lg-qs-hero-head">
                        <strong>调用用途</strong>
                        <Button size="sm" variant="ghost" onClick={() => void copyText('app-caller', displayBundle.appCallerCode)}>{copied === 'app-caller' ? <Check size={13} /> : <Copy size={13} />}{copied === 'app-caller' ? '已复制' : '复制'}</Button>
                      </div>
                      <code className="lg-qs-hero-value">{displayBundle.appCallerCode}</code>
                      <small className="lg-qs-hero-note">归属团队 {selectedTeam?.name ?? '未指定'}；这把 key 只授权了它一条，兼容协议下请求头可省略。</small>
                    </Card>
                  </div>
                ) : null}

                {resultTab === 'curl' ? (
                  <Card style={CARD_BODY} className="lg-qs-snippet-card lg-qs-curl-card">
                    {/*
                      一键测试：类型是这把 key 的调用用途本身携带的（appCallerCode 以 ::chat / ::vision
                      结尾，签发后不可改），所以这里只读展示；能选的是模型——且只列该类型模型池里的
                      成员，不让人填一个池外模型（`llm-gateway.md`：可选模型必须来自获准的池）。
                    */}
                    <div className="lg-qs-testbar">
                      <div className="lg-qs-testbar-controls">
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
                            {poolModels.map((model) => <option key={`${model.platformId}:${model.modelId}`} value={model.modelId} />)}
                          </datalist>
                        </label>
                      </div>

                      {/*
                        上输入下输出：两块同宽、同圆角、上下相邻，中间只隔一条动作行，
                        读起来就是一对。空态也占满 88px，跑起来页面不往下跳。
                        输入框里的内容同时进下面的 cURL 片段——两边永远是同一次请求。
                      */}
                      <div className="lg-qs-io">
                        {/*
                          按调用类型区分输入：看图这一类没有图片就不成立，所以图片是独立的一格，
                          不是藏在「或上传文本」后面的一个可选动作。没给图时如实说清用的是内置测试图
                          （只证明链路通，证明不了模型识图对不对），而不是静默塞一张 1x1 让人以为测过了。
                        */}
                        {displayBundle.requestType === 'vision' ? (
                          <div className="lg-qs-io-block">
                            <div className="lg-qs-io-head">
                              <span className="lg-qs-field-title">要看的图</span>
                              <label className="lg-qs-upload">
                                <Upload size={13} />
                                {attachment ? attachment.name : '上传图片'}
                                <input
                                  type="file"
                                  aria-label="上传要看的图"
                                  accept="image/*"
                                  onChange={(event) => { void pickAttachment(event.target.files?.[0] ?? null); event.target.value = ''; }}
                                />
                              </label>
                              {attachment ? <button type="button" className="lg-text-link" onClick={() => { setAttachment(null); setTestResult(null); }}>移除</button> : null}
                            </div>
                            <div className={`lg-qs-io-image${attachment ? ' is-ready' : ''}`}>
                              {attachment
                                ? <img src={attachment.dataUrl} alt="要发给模型看的图" />
                                : <span className="lg-qs-io-empty">没给图就发一张 1x1 测试图：只能证明链路通，证明不了模型识图对不对。</span>}
                            </div>
                          </div>
                        ) : null}

                        <div className="lg-qs-io-block">
                          <div className="lg-qs-io-head">
                            <span className="lg-qs-field-title">{displayBundle.requestType === 'vision' ? '要问什么' : '你要发什么'}</span>
                            {displayBundle.requestType === 'vision' ? null : (
                              <label className="lg-qs-upload">
                                <Upload size={13} />或上传文本
                                <input
                                  type="file"
                                  aria-label="上传测试输入"
                                  accept=".txt,.md,.json,text/*"
                                  onChange={(event) => { void pickAttachment(event.target.files?.[0] ?? null); event.target.value = ''; }}
                                />
                              </label>
                            )}
                          </div>
                          <textarea
                            className="lg-qs-io-input"
                            aria-label="试跑要发送的内容"
                            placeholder="写一句要发给模型的话，例如：用三句话说明什么是模型网关。留空发 Reply with OK。"
                            value={testPrompt}
                            onChange={(event) => { setTestPrompt(event.target.value); setTestResult(null); }}
                          />
                        </div>

                        <div className="lg-qs-io-actions">
                          <small className={`lg-qs-testbar-models${modelValid ? '' : ' is-bad'}`}>
                            {modelHint}安全试跑不打上游、不计费；真实调用会计入用量与费用。
                          </small>
                          {canCreateAccess ? (
                            <div className="lg-qs-io-buttons">
                              <Button size="sm" variant="secondary" disabled={testing || !modelValid} onClick={() => void runTest(bundle, 'safe')}>
                                <Play size={14} />{testing ? '执行中' : '安全试跑'}
                              </Button>
                              {/*
                                真实调用必须过路由闸：路由还在校验、校验失败、或识别出目标是
                                stub/mock 时按下去，跑的是假上游，页面却会报「真实调用已返回、
                                本次计费」——给用户一个假的成功。上方那对「安全试跑 / 真实模型」
                                早就判了这道闸，这个主按钮当初漏了。
                              */}
                              <Button
                                size="sm"
                                variant="primary"
                                disabled={testing || !modelValid || !realRouteReady}
                                title={!realRouteReady ? '真实路由还没确认就绪，先看下方的路由校验结果' : undefined}
                                onClick={() => void runRealTest()}
                              >
                                <Play size={14} />{liveOutput?.done ? '再跑一次' : '真实调用'}
                              </Button>
                            </div>
                          ) : null}
                        </div>

                        <div className="lg-qs-io-block">
                          <div className="lg-qs-io-head">
                            <span className="lg-qs-field-title">模型返回</span>
                            {liveOutput && !liveOutput.done ? <span className="lg-qs-io-dots" aria-hidden="true"><i /><i /><i /></span> : null}
                            {liveOutput?.done ? <span className="lg-qs-io-chip">{liveOutput.kind === 'image' ? '图片' : liveOutput.kind === 'audio' ? '音频' : '文字'}</span> : null}
                            {liveOutput ? (
                              <small className="lg-qs-io-meta">
                                {liveOutput.done
                                  ? `${testElapsedMs === null ? '已返回' : `${(testElapsedMs / 1000).toFixed(1)}s`} · 实际执行 ${effectiveTestModel === 'auto' ? currentRoutePreview?.actualModel || '由池调度' : effectiveTestModel}`
                                  : `已用 ${((Date.now() - (runStartedAt ?? Date.now())) / 1000).toFixed(1)}s`}
                              </small>
                            ) : null}
                            {liveOutput?.done && testResult?.requestId ? (
                              <a className="lg-qs-io-link" href={`/llmgw/logs?requestId=${encodeURIComponent(testResult.requestId)}`}>requestId</a>
                            ) : null}
                            {liveOutput ? <button type="button" className="lg-text-link" onClick={() => setLiveOutput(null)}>清除</button> : null}
                          </div>
                          <div
                            className={`lg-qs-output${liveOutput ? (liveOutput.done ? ' is-done' : ' is-streaming') : ''}`}
                            role="status"
                            aria-live="polite"
                          >
                            {!liveOutput ? <span className="lg-qs-io-empty">跑一次就出现在这里</span> : null}
                            {liveOutput?.kind === 'image' && liveOutput.url ? <img src={liveOutput.url} alt="模型返回的图片" /> : null}
                            {liveOutput?.kind === 'audio' && liveOutput.url ? <audio controls src={liveOutput.url} /> : null}
                            {liveOutput?.kind === 'text' ? (
                              <pre>{liveOutput.text || (liveOutput.done ? '（上游返回了空内容）' : '')}<span className={liveOutput.done ? 'lg-qs-caret is-done' : 'lg-qs-caret'} /></pre>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* 复制按钮从代码块右上角浮层收进 header 行：块本身干净，不再被按钮压着。 */}
                    <div className="lg-qs-snippet-head">
                      <span className="lg-qs-field-title">请求片段</span>
                      <select
                        aria-label="入口协议"
                        value={protocol}
                        onChange={(event) => { setProtocol(event.target.value as Protocol); setTestResult(null); if (bundle) void checkRealRoute(bundle); }}
                        style={inputStyle}
                      >
                        {PROTOCOLS.map((item) => <option key={item.id} value={item.id}>{`${item.label} ${item.path}`}</option>)}
                      </select>
                      <Button size="sm" className="lg-qs-snippet-copy" onClick={() => void copyText('curl', snippets.curl)}>{copied === 'curl' ? <Check size={14} /> : <Copy size={14} />}{copied === 'curl' ? '已复制' : '复制'}</Button>
                    </div>
                    <pre style={preStyle} className="lg-qs-code"><code>{snippets.curl}</code></pre>
                    <small className="lg-qs-note">{snippetMode === 'safe' ? '示例默认带 X-Gateway-Dry-Run: quickstart，不产生上游费用。' : '示例不带 dry-run，会真实调用模型。'}</small>
                  </Card>
                ) : null}

                {resultTab === 'prompt' ? (
                  <Card style={CARD_BODY} className="lg-qs-snippet-card">
                    <div className="lg-qs-snippet-head">
                      <div className="lg-qs-type-row" role="radiogroup" aria-label="调用方式">
                        {PROMPT_WAYS.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            role="radio"
                            aria-checked={promptWay === item.id}
                            className={promptWay === item.id ? 'is-active' : ''}
                            onClick={() => setPromptWay(item.id)}
                          >{item.label}</button>
                        ))}
                      </div>
                    </div>

                    {promptWay === 'client' ? (
                      <>
                        <div className="lg-qs-preset-list" role="radiogroup" aria-label="客户端">
                          {CLIENT_PRESETS.map((item) => (
                            <button
                              key={item.id}
                              type="button"
                              role="radio"
                              aria-checked={clientPreset === item.id}
                              className={clientPreset === item.id ? 'is-active' : ''}
                              onClick={() => setClientPreset(item.id)}
                            >
                              <span className="lg-qs-radio" aria-hidden="true" />
                              <strong>{item.label}</strong>
                              <span>{item.description}</span>
                            </button>
                          ))}
                        </div>
                        {clientPreset === 'api' ? (
                          <div className="lg-qs-code-wrap">
                            <pre style={preStyle} className="lg-qs-code"><code>{snippets.env}</code></pre>
                            <Button size="sm" style={{ position: 'absolute', top: 9, right: 9 }} onClick={() => void copyText('env', snippets.env)}>{copied === 'env' ? <Check size={14} /> : <Copy size={14} />}{copied === 'env' ? '已复制' : '复制'}</Button>
                          </div>
                        ) : (
                          <ClientQuickSetup bundle={{ ...displayBundle, clientPreset }} copied={copied} onCopy={copyText} />
                        )}
                      </>
                    ) : (
                      <div className="lg-qs-code-wrap">
                        <pre style={preStyle} className="lg-qs-code"><code>{promptWay === 'skill' ? snippets.skill : systemPromptSnippet(displayBundle)}</code></pre>
                        <Button size="sm" style={{ position: 'absolute', top: 9, right: 9 }} onClick={() => void copyText(promptWay, promptWay === 'skill' ? snippets.skill : systemPromptSnippet(displayBundle))}>{copied === promptWay ? <Check size={14} /> : <Copy size={14} />}{copied === promptWay ? '已复制' : '复制'}</Button>
                      </div>
                    )}
                    <small className="lg-qs-note">{PROMPT_WAYS.find((item) => item.id === promptWay)?.note}</small>
                  </Card>
                ) : null}
              </>
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

/**
 * 码的一段：认出来了就只占一行（值 + 凭什么这么判），认不出来才摊开清单让人挑。
 * 推断值必须可见、可改、可追责——所以匹配到的那个词原样回显，改过之后不再自动回弹。
 */
function FacetRow({ title, facet, options, picked, open, disabled, onToggle, onPick }: {
  title: string;
  facet: (IntentFacet & { matched?: string }) | null;
  options: IntentFacet[];
  picked: string | null;
  open: boolean;
  disabled: boolean;
  onToggle: () => void;
  onPick: (code: string | null) => void;
}) {
  return (
    <div className={`lg-qs-facet${facet ? ' is-ready' : ''}`}>
      <div className="lg-qs-facet-head">
        <span className="lg-qs-facet-title">{title}</span>
        {facet ? (
          <>
            <strong>{facet.label}</strong>
            <code>{facet.code}</code>
            <small>{picked ? '你指定的' : `来自「${facet.matched}」`}</small>
          </>
        ) : <em>还没认出来</em>}
        <button type="button" className="lg-text-link" disabled={disabled} onClick={onToggle}>
          {open ? '收起' : facet ? '换一个' : '手动选'}
        </button>
      </div>
      {open ? (
        <div className="lg-qs-facet-options" role="radiogroup" aria-label={title}>
          {options.map((item) => (
            <button
              key={item.code}
              type="button"
              role="radio"
              aria-checked={picked === item.code}
              className={picked === item.code ? 'is-active' : ''}
              disabled={disabled}
              onClick={() => { onPick(picked === item.code ? null : item.code); onToggle(); }}
            >{item.label}</button>
          ))}
        </div>
      ) : null}
    </div>
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

type TestAttachment = { name: string; kind: 'image'; dataUrl: string } | null;

function userContentFor(requestType: RequestType, attachment: TestAttachment, flavor: 'openai' | 'claude' | 'gemini', typedPrompt = '') {
  /*
    正文一律取用户在输入框里写的那句（上传文本会填进同一个框，所以只有这一个来源，
    输入框、cURL 片段、真正发出去的请求永远是同一份内容）；空着才退回 Reply with OK。
    图片仍走附件：上传了就用上传的那张，没传才用内嵌的 1x1 测试图。
  */
  const prompt = typedPrompt.trim() || 'Reply with OK';
  if (requestType !== 'vision') return flavor === 'gemini' ? [{ text: prompt }] : prompt;
  // 没上传图片就沿用内嵌的 1x1 测试图：那三个 vision*Content 仍是各协议形状的唯一来源。
  if (!attachment) {
    // 图用内嵌的那张，**话仍然用用户写的那句**：丢掉它，输入框里写着一句、发出去的是另一句。
    if (flavor === 'claude') return visionClaudeContent(prompt);
    if (flavor === 'gemini') return visionGeminiParts(prompt);
    return visionOpenAiContent(prompt);
  }
  const dataUrl = attachment.dataUrl;
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const mediaType = dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png';
  if (flavor === 'claude') return [
    { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
    { type: 'text', text: prompt },
  ];
  if (flavor === 'gemini') return [
    { inline_data: { mime_type: mediaType, data: base64 } },
    { text: prompt },
  ];
  return [
    { type: 'image_url', image_url: { url: dataUrl } },
    { type: 'text', text: prompt },
  ];
}

function dryRunBody(protocol: Protocol, requestType: RequestType, appCallerCode: string, requestId: string, model = 'auto', attachment: TestAttachment = null, stream = false, prompt = '', platformId = '') {
  /*
    model=auto 交给池调度；选了具体成员就要**按钉成员的契约**发，不能只把名字塞进 model
    再声明 pool：serving 在 model_policy=pool 时会把 ExpectedModel 当成**池标识**去找，
    而我们给的是模型名，appCaller 一旦绑了严格池契约就回 ROUTE_CONFIG_INCOMPATIBLE——
    选了成员反而跑不通，错误码还把人往「池没权限」上带。
    解析器认的是「ExpectedModel 与 PinnedModelId 相等 = 在已绑池内钉这个成员」，
    所以两处发同一个值、策略声明 pinned。
  */
  const pinned = model !== 'auto';
  const policy = pinned ? 'pinned' : 'auto';
  // 两个 id 都要给：解析器只在 pinnedPlatformId 与 pinnedModelId **都非空**时才构造
  // pinned target，缺一个就落到「PinnedModel 不在 appCaller 专用模型池内」，
  // 回的仍是 ROUTE_CONFIG_INCOMPATIBLE——与只发模型名时一模一样的失败。
  const pin = pinned && platformId
    ? { pinned_platform_id: platformId, pinned_model_id: model }
    : {};
  if (protocol === 'native') return {
    appCallerCode,
    modelType: requestType,
    ...pin,
    requestBody: { model, messages: [{ role: 'user', content: userContentFor(requestType, attachment, 'openai', prompt) }] },
    context: { requestId, sourceSystem: 'external', modelPolicy: policy },
  };
  if (protocol === 'claude') return { model, model_policy: policy, ...pin, max_tokens: 64, messages: [{ role: 'user', content: userContentFor(requestType, attachment, 'claude', prompt) }] };
  if (protocol === 'gemini') return { model, model_policy: policy, ...pin, contents: [{ role: 'user', parts: userContentFor(requestType, attachment, 'gemini', prompt) }] };
  return { model, model_policy: policy, ...pin, messages: [{ role: 'user', content: userContentFor(requestType, attachment, 'openai', prompt) }], stream };
}

/*
  内嵌 1x1 测试图的三种协议形状。**问什么由调用方给**——用户在输入框写了什么，
  发出去的就是什么；他没写才落到默认那句。写死一句会让输入框成为摆设。
*/
const DEFAULT_VISION_PROMPT = 'Describe this test image';

function visionOpenAiContent(prompt = DEFAULT_VISION_PROMPT) {
  return [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${TEST_IMAGE_BASE64}` } },
  ];
}

function visionClaudeContent(prompt = DEFAULT_VISION_PROMPT) {
  return [
    { type: 'text', text: prompt },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TEST_IMAGE_BASE64 } },
  ];
}

function visionGeminiParts(prompt = DEFAULT_VISION_PROMPT) {
  return [
    { text: prompt },
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

/**
 * 流里夹着的失败帧。serving 在响应头已发出后才发现上游失败时只能这样回：
 * HTTP 仍是 200，帧里带 `finishReason: "error"` 和一个 error 对象，随后 [DONE]。
 * 认不出它，页面就会把一次真扣了钱的失败报成成功。
 */
function readStreamError(line: string): { message: string; code?: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const data = trimmed.slice(5).trim();
  if (data.length === 0 || data === '[DONE]') return null;
  try {
    const parsed = JSON.parse(data) as {
      error?: { message?: unknown; code?: unknown; type?: unknown };
      choices?: Array<{ finishReason?: unknown; finish_reason?: unknown }>;
    };
    const finish = parsed.choices?.[0]?.finishReason ?? parsed.choices?.[0]?.finish_reason;
    const errored = parsed.error !== undefined || finish === 'error';
    if (!errored) return null;
    const message = typeof parsed.error?.message === 'string' && parsed.error.message.length > 0
      ? parsed.error.message
      : '上游模型调用失败';
    const code = typeof parsed.error?.code === 'string' ? parsed.error.code
      : typeof parsed.error?.type === 'string' ? parsed.error.type
      : undefined;
    return { message, code };
  } catch {
    return null;
  }
}

/** 解析一行 SSE：返回这一帧的文字增量；不是内容帧就返回 null。 */
function readStreamDelta(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const data = trimmed.slice(5).trim();
  if (data.length === 0 || data === '[DONE]') return null;
  try {
    const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }> };
    const content = parsed.choices?.[0]?.delta?.content;
    return typeof content === 'string' && content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

/** 非流式返回按形状判断类型：先图片、再音频、最后文字。绝不猜——认不出就原样给 JSON。 */
function readNonStreamOutput(payload: Record<string, unknown> | null): { kind: 'text' | 'image' | 'audio'; text: string; url?: string; done: boolean } {
  if (!payload) return { kind: 'text', text: '（上游没有返回可解析的内容）', done: true };
  const image = findFirstString(payload, ['b64_json', 'image_base64']);
  if (image) return { kind: 'image', text: '', url: image.startsWith('data:') ? image : `data:image/png;base64,${image}`, done: true };
  const imageUrl = findFirstString(payload, ['image_url']);
  if (imageUrl) return { kind: 'image', text: '', url: imageUrl, done: true };
  const audio = findFirstString(payload, ['audio_base64', 'audio_url']);
  if (audio) return { kind: 'audio', text: '', url: audio.startsWith('data:') || audio.startsWith('http') ? audio : `data:audio/mpeg;base64,${audio}`, done: true };
  const text = findFirstString(payload, ['content', 'text', 'output_text']);
  return { kind: 'text', text: text || JSON.stringify(payload, null, 2), done: true };
}

/** 深度找第一个非空字符串字段。上游形状各异，比逐协议写一套解析更耐改。 */
function findFirstString(node: unknown, keys: string[]): string | null {
  if (typeof node !== 'object' || node === null) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findFirstString(item, keys);
      if (hit) return hit;
    }
    return null;
  }
  const record = node as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  for (const value of Object.values(record)) {
    const hit = findFirstString(value, keys);
    if (hit) return hit;
  }
  return null;
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

/**
 * 可直接粘进用户自己应用的系统提示词。
 *
 * 它不是网关侧的提示词策略（那个挂在 appCaller 上，见 /prompt-policy），
 * 而是「你把这条 key 接进去时，告诉你自己那个模型/Agent 该怎么用它」的一段话。
 * 密钥不进正文——用环境变量占位，避免用户把提示词连同明文密钥一起贴到别处。
 */
function systemPromptSnippet(bundle: DisplayBundle) {
  const definition = protocolDefinition(bundle.protocol);
  return [
    '你通过 LLM Gateway 调用模型，不要直连任何模型供应商。',
    '',
    `接口地址：${bundle.baseUrl}${definition.path}`,
    '鉴权：请求头 Authorization: Bearer $LLMGW_API_KEY（密钥从环境变量读取，不要写进提示词或仓库）。',
    `调用用途：请求头 X-Gateway-App-Caller: ${bundle.appCallerCode}`,
    `来源标记：请求头 X-Gateway-Source: external`,
    `本条用途只允许 ${requestTypeLabel(bundle.requestType)} 类请求；换用途要另外登记一条码。`,
    '',
    '模型填 "auto" 由网关调度；要指定只能填该池内成员。',
    '每次调用返回 X-Request-Id，出问题拿它去请求记录页定位。',
    '预算与限流由网关统一管理，超限返回结构化错误，如实报告，不要重试绕过。',
  ].join('\n');
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

function exampleFor(protocol: Protocol, requestType: RequestType, baseUrl: string, appCaller: string, mode: TestMode, model = 'auto', attachment: TestAttachment = null, prompt = '', platformId = '') {
  const definition = protocolDefinition(protocol);
  const requestIdToken = '__LLMGW_REQUEST_ID__';
  const common = `-H "Authorization: Bearer \$LLMGW_API_KEY" \\
  -H "X-Gateway-Source: external" \\
  -H "X-Gateway-App-Caller: ${appCaller}" \\${mode === 'safe' ? '\n  -H "X-Gateway-Dry-Run: quickstart" \\' : ''}
  -H "X-Request-Id: \$REQUEST_ID"`;
  const body = JSON.stringify(dryRunBody(protocol, requestType, appCaller, requestIdToken, model, attachment, false, prompt, platformId), null, 2)
    .replace(requestIdToken, `'"$REQUEST_ID"'`);
  const extra = protocol === 'claude' ? ' \\\n  -H "anthropic-version: 2023-06-01"' : '';
  return `REQUEST_ID="quickstart-\$(date +%s)-\$RANDOM"
curl "${baseUrl}${protocolPathFor(definition, model)}" \\
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
const dlStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: GAP.normal, margin: 0 };
const labelStyle: React.CSSProperties = FIELD_LABEL;
const inputStyle: React.CSSProperties = FIELD_INPUT;
const preStyle: React.CSSProperties = { margin: 0, minHeight: 180, overflow: 'auto', padding: 14, paddingTop: 48, background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 'var(--fs-secondary)', lineHeight: 1.65 };
