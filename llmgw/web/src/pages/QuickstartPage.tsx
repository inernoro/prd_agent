import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, FileCode2, KeyRound, ListFilter, Play, Rocket, Search, Server, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { bulkClaimConfigAuthority, createGatewayAppCaller, createServiceKey, ensurePoolTypes, getOrganization, updateGatewayAppCaller } from '@/lib/api';
import type { OrganizationData } from '@/lib/types';
import { Button, Chip, ReadOnlyNotice, SectionLoader } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';

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

const TEST_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export function QuickstartPage() {
  const { tenant } = useAuth();
  const canCreateAccess = canUseCapability(tenant?.role, 'appCallerWrite') && canUseCapability(tenant?.role, 'serviceKeyWrite');
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
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; requestId?: string } | null>(null);

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
    if (bundle && !window.confirm('将签发一把新密钥，现有密钥不会自动撤销。确认继续？')) return;

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
        setTestResult({ ok: false, message: readErrorMessage(payload) || `${mode === 'safe' ? '安全测试' : '真实请求'}失败，HTTP ${response.status}`, requestId: actualRequestId });
      } else if (mode === 'safe' && upstreamCalled === false) {
        setTestResult({ ok: true, message: `${definition.label} 的 ${requestTypeLabel(target.requestType)}、团队边界和密钥鉴权均通过；已写入请求记录，未访问上游。`, requestId: actualRequestId });
      } else if (mode === 'safe') {
        setTestResult({ ok: false, message: 'Gateway 未明确证明 upstreamCalled=false，本次结果不计为安全验收。', requestId: actualRequestId });
      } else {
        const actualModel = readActualModel(payload) || currentRoutePreview?.actualModel || '已解析模型';
        const provider = currentRoutePreview?.actualPlatformName || currentRoutePreview?.actualPlatformId || '已解析 Provider';
        setTestResult({ ok: true, message: `真实上游已返回，Provider：${provider}，模型：${actualModel}。请用 requestId 核对实际模型、耗时和费用。`, requestId: actualRequestId });
      }
    } catch (error) {
      setTestResult({ ok: false, message: error instanceof Error ? `无法访问 Gateway：${error.message}` : '无法访问 Gateway。' });
    } finally {
      setTesting(false);
    }
  };

  const editIdentity = () => {
    if (!bundle) return;
    if (!window.confirm('当前一次性密钥明文将从页面清除；已签发密钥仍然有效，可到“接入密钥”页撤销。确认修改身份？')) return;
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

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <header>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Rocket size={19} /><h1 style={{ margin: 0, fontSize: 20, lineHeight: '36px', fontWeight: 600 }}>Quickstart</h1></div>
          <p style={{ margin: '4px 0 0', color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.6 }}>目标 3 分钟：选择客户端，生成配置，系统自动验证密钥和团队边界。高级选项默认收起。</p>
        </header>

        <section className="lg-client-presets" aria-label="接入方式">
          {CLIENT_PRESETS.map((item) => (
            <button key={item.id} type="button" disabled={identityLocked} className={clientPreset === item.id ? 'is-active' : ''} onClick={() => selectClientPreset(item.id)}>
              <strong>{item.label}</strong>
              <span>{item.description}</span>
            </button>
          ))}
        </section>

        <section className="lg-quickstart-steps" style={{ ...gridStyle, gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
          <Step number="1" title={`选择 ${selectedClient.label}`} text="系统已自动填写团队、appCaller、协议和安全默认值。" />
          <Step number="2" title="生成并自动验证" text="一次生成 appCaller 与 API Key，自动执行不访问付费上游的安全测试。" />
          <Step number="3" title="复制并连接" text="复制客户端配置即可使用；失败时用自动生成的 requestId 回查。" />
        </section>

        <section style={cardStyle}>
          <h2 style={headingStyle}><ShieldCheck size={15} />{selectedClient.label} 接入配置</h2>
          {!canCreateAccess ? <ReadOnlyNotice>当前角色可以阅读四协议接入教程和复制示例，但不能创建 appCaller、签发密钥或执行安全直测。</ReadOnlyNotice> : null}
          {organizationLoading ? <SectionLoader text="正在读取当前租户和团队" /> : null}
          {organizationError ? <div className="lg-test-result is-error">{organizationError}</div> : null}
          {!organizationLoading && !organizationError && activeTeams.length === 0 ? <div className="lg-quickstart-prerequisite" role="status"><span><strong>先创建一个团队</strong><small>团队决定 appCaller 和 API Key 由谁管理。创建后回到本页即可生成客户端配置。</small></span><Link to="/organization">打开组织与团队</Link></div> : null}
          {!organizationLoading ? (
            <>
              <div className="lg-quickstart-summary">
                <span><small>团队</small><strong>{selectedTeam?.name || '尚未选择'}</strong></span>
                <span><small>appCaller</small><strong>{appCallerCode}</strong></span>
                <span><small>协议</small><strong>{selectedProtocol.label}</strong></span>
              </div>
              <details className="lg-quickstart-advanced-identity">
                <summary>自定义身份、协议和 Gateway 地址</summary>
                <div className="lg-quickstart-inputs" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12, marginTop: 12 }}>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <div style={labelStyle}>调用类型</div>
                    <div className="lg-quickstart-request-types" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginTop: 5 }}>
                      {REQUEST_TYPES.map((item) => <button key={item.id} type="button" disabled={identityLocked} onClick={() => changeRequestType(item.id)} aria-pressed={requestType === item.id} className={requestType === item.id ? 'is-active' : ''}><strong>{item.label}</strong><span>{item.description}</span></button>)}
                    </div>
                  </div>
                  <label style={labelStyle}>团队<select value={teamId} disabled={!canCreateAccess || identityLocked} onChange={(event) => setTeamId(event.target.value)} style={inputStyle}><option value="">选择团队</option>{activeTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
                  <Field label={`appCallerCode（以 ::${requestType} 结尾）`} value={appCallerCode} onChange={setAppCallerCode} placeholder={`my-agent.quickstart::${requestType}`} disabled={!canCreateAccess || identityLocked} />
                  <Field label="Client code" value={clientCode} onChange={setClientCode} placeholder="my-agent" disabled={!canCreateAccess || identityLocked} />
                  <label style={labelStyle}>环境<select value={environment} disabled={!canCreateAccess || identityLocked} onChange={(event) => setEnvironment(event.target.value)} style={inputStyle}><option value="development">开发</option><option value="test">测试</option><option value="staging">预发布</option><option value="production">生产</option></select></label>
                  <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 6, overflowX: 'auto' }}>{PROTOCOLS.map((item) => <Button key={item.id} size="sm" variant={protocol === item.id ? 'primary' : 'ghost'} onClick={() => { setProtocol(item.id); setTestResult(null); if (bundle) void checkRealRoute(bundle); }}>{item.label}</Button>)}</div>
                  <label style={labelStyle}>Gateway 地址<code className="lg-derived-base-url">{baseUrl}</code></label>
                  <label style={labelStyle}>测试路径<code className="lg-derived-base-url">{selectedProtocol.path}</code></label>
                  <Field label="自定义 Gateway 地址" value={baseUrl} onChange={changeBaseUrl} />
                </div>
              </details>
            </>
          ) : null}

          <div className="lg-quickstart-actions">
            <div><strong>{creatingStage === 'app-caller' ? '正在创建 appCaller' : creatingStage === 'key' ? '正在签发团队密钥' : bundle ? '接入配置已生成' : '尚未生成接入配置'}</strong><small>{bundle ? `密钥 ${bundle.keyPrefix}，只授权当前 ${requestTypeLabel(bundle.requestType)} appCaller 和上方四种协议，默认限制 60 次/分钟；切换协议后可直接测试。` : '不会创建通配 key；密钥默认限制 60 次/分钟，也不会调用付费模型。'}</small></div>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {canCreateAccess && bundle ? <Button variant="ghost" onClick={editIdentity}>修改身份</Button> : null}
              {canCreateAccess ? <Button variant="primary" title={activeTeams.length === 0 ? '请先创建团队' : undefined} disabled={organizationLoading || creatingStage !== null || activeTeams.length === 0} onClick={() => void createAccessBundle()}><KeyRound size={14} />{creatingStage ? '生成中' : bundle ? '再签一把同配置 key' : `生成并验证 ${selectedClient.label}`}</Button> : null}
            </div>
          </div>

          {bundle ? (
            <div className="lg-quickstart-secret">
              <div><strong>一次性密钥</strong><small>只保存在当前页面内存；请先复制环境变量或 Agent Skill，再刷新页面。</small></div>
              <code>{bundle.key}</code>
              <Button size="sm" onClick={() => void copyText('key', bundle.key)}>{copied === 'key' ? <Check size={14} /> : <Copy size={14} />}{copied === 'key' ? '已复制' : '复制密钥'}</Button>
            </div>
          ) : null}
          {actionError ? <div className="lg-test-result is-error" role="alert">{actionError}</div> : null}

          <div className="lg-snippet-tabs">
            <Button size="sm" variant={snippetTab === 'client' ? 'primary' : 'ghost'} onClick={() => setSnippetTab('client')}>{selectedClient.label}</Button>
            <Button size="sm" variant={snippetTab === 'curl' ? 'primary' : 'ghost'} onClick={() => setSnippetTab('curl')}>cURL</Button>
            <Button size="sm" variant={snippetTab === 'env' ? 'primary' : 'ghost'} onClick={() => setSnippetTab('env')}>环境变量</Button>
            <Button size="sm" variant={snippetTab === 'skill' ? 'primary' : 'ghost'} onClick={() => setSnippetTab('skill')}><FileCode2 size={14} />Agent Skill</Button>
          </div>
          {snippetTab === 'client' && bundle && bundle.clientPreset !== 'api' ? (
            <ClientQuickSetup bundle={displayBundle} copied={copied} onCopy={copyText} />
          ) : (
            <div style={{ position: 'relative' }}>
              <pre style={preStyle}><code>{visibleSnippet}</code></pre>
              <Button size="sm" style={{ position: 'absolute', top: 9, right: 9 }} onClick={() => void copyText(snippetTab, visibleSnippet)}>{copied === snippetTab ? <Check size={14} /> : <Copy size={14} />}{copied === snippetTab ? '已复制' : '复制'}</Button>
            </div>
          )}
          <p style={hintStyle}>{snippetMode === 'safe' ? <>cURL 与 Agent Skill 默认带 <code>X-Gateway-Dry-Run: quickstart</code>，不会产生上游费用。</> : <>当前示例不带 dry-run，会执行一次真实模型调用；请先核对下方真实路由。</>} 不要把密钥提交到仓库、截图、URL 或共享日志。</p>

          <div className="lg-safe-test-panel" style={{ marginTop: 12 }}>
            <div><Play size={17} /><span><strong>接入验证</strong><small>生成配置后会自动执行安全连通测试；只有明确选择真实模型时才会产生费用。</small></span></div>
            <div className="lg-test-mode" role="group" aria-label="测试模式">
              <button type="button" className={testMode === 'safe' ? 'is-active' : ''} onClick={() => { setTestMode('safe'); setTestResult(null); }}>安全连通</button>
              <button type="button" className={testMode === 'real' ? 'is-active' : ''} disabled={!realRouteReady || routeChecking} title={!realRouteReady ? '在下方展开真实路由，确认当前地址已就绪' : undefined} onClick={() => { setTestMode('real'); setTestResult(null); }}>真实模型</button>
            </div>
            <div className="lg-safe-test-controls">{canCreateAccess ? <Button variant="primary" disabled={!bundle || testing || (testMode === 'real' && !realRouteReady)} onClick={() => void runTest()}>{testing ? (testMode === 'real' ? '正在等待真实模型' : '正在验证并写日志') : testMode === 'real' ? '发送一次真实请求' : '验证接入边界'}</Button> : null}<span style={{ alignSelf: 'center', color: 'var(--text-muted)', fontSize: 13 }}>{canCreateAccess ? (testMode === 'real' ? '只调用下方已解析的真实模型' : '返回 requestId 且 upstreamCalled=false 才算通过') : '请联系 Owner、Admin 或 Developer 完成签发与测试'}</span></div>
            {testResult ? <div className={testResult.ok ? 'lg-test-result is-ok' : 'lg-test-result is-error'} role="status">{testResult.message}{testResult.requestId ? <Link to={`/logs?requestId=${encodeURIComponent(testResult.requestId)}`}>打开 requestId 请求记录</Link> : null}</div> : null}
          </div>

          <details className="lg-route-preview" style={{ marginTop: 12 }}>
            <summary className="lg-route-preview-heading"><Server size={17} /><span><strong>真实路由与排障</strong><small>{currentRoutePreview?.success ? `${currentRoutePreview.actualPlatformName || currentRoutePreview.actualPlatformId || 'Provider'} · ${currentRoutePreview.actualModel || '已解析模型'}` : '首次接入不必展开；需要调用真实模型或排查时再查看。'}</small></span></summary>
            {!bundle ? <p>生成 appCaller 与 key 后自动检查。</p> : routeChecking ? <p>正在检查模型池、Provider 和实际模型。</p> : currentRoutePreview?.success ? (
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
                {tenant?.isInternal && canManagePromptPolicy ? <Button size="sm" variant="secondary" disabled={!bundle || preparingRoute} onClick={() => void prepareRealRoute()}>{preparingRoute ? '正在只补缺失配置' : '一键准备现有真实上游'}</Button> : null}
                {!tenant?.isInternal ? <span>请先为当前租户添加 Provider 密钥、启用模型，并把模型加入此类型的默认池。</span> : null}
              </div>
            )}
            {bundle ? <Button size="sm" variant="ghost" disabled={routeChecking} onClick={() => void checkRealRoute()}>{routeChecking ? '检查中' : '重新检查'}</Button> : null}
          </details>

          <details className="lg-quickstart-safety" style={{ marginTop: 10, padding: '10px 12px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface)' }}>
            <summary style={{ cursor: 'pointer', color: 'var(--text-primary)', fontSize: 12, fontWeight: 650 }}>展开安全测试选项</summary>
            <dl style={{ ...dlStyle, marginTop: 10 }}>
              <RouteRow name="安全连通" text="发送 X-Gateway-Dry-Run: quickstart，在模型解析、预算预占和上游发送前结束。" />
              <RouteRow name="真实模型" text="只有路由预览成功且不是明显开发桩时才能点击；请求不带 dry-run，并把实际结果写入同一套租户日志。" />
              <RouteRow name="调用类型" text={displayBundle.requestType === 'vision' ? '图片理解：使用内嵌的 1×1 测试图片，只验证多模态协议形状，不读取用户文件。' : '文字对话：使用固定的测试文字，只验证 chat 协议形状。'} />
              <RouteRow name="通过标准" text="HTTP 成功、返回 requestId，并且 Gateway 明确返回 upstreamCalled=false；缺少任一项都不算通过。" />
              <RouteRow name="审计边界" text="日志记录服务端解析的 tenant、team、service key、client 和 environment；不记录密钥明文，费用保持 unknown。" />
            </dl>
          </details>

          {bundle ? (
            <details className="lg-quickstart-follow-up">
              <summary>后续治理：提示词策略</summary>
              <div>
                <span><strong>给这个 {requestTypeLabel(bundle.requestType)} appCaller 配置提示词策略</strong><small>策略预览不保存、不调用模型；保存后日志只记录 policy id、version 和 hash。</small></span>
                {canManagePromptPolicy ? <Link to={`/app-callers/${encodeURIComponent(bundle.appCallerId)}/prompt-policy`}>打开提示词策略</Link> : <span>请由 Owner 或 Admin 配置策略</span>}
              </div>
            </details>
          ) : null}
        </section>

        <section className="lg-quickstart-detail-grid" style={{ ...gridStyle, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
          <div style={cardStyle}>
            <h2 style={headingStyle}><ListFilter size={15} />三个身份不要混用</h2>
            <dl style={dlStyle}>
              <RouteRow name="service key" text="回答谁在调用；绑定 tenant、team、client、environment、appCaller 和协议。" />
              <RouteRow name="appCallerCode" text="回答为什么调用；用于提示词策略、预算、限流、统计与专属路由。" />
              <RouteRow name="model pool" text="回答去哪里调用；默认池与特殊池由平台规则管理，不由 key 承担。" />
            </dl>
          </div>
          <div style={cardStyle}>
            <h2 style={headingStyle}><Search size={15} />失败怎么定位</h2>
            <dl style={dlStyle}>
              <RouteRow name="401" text="密钥错误、过期或已撤销。明文无法找回，只能创建或轮换。" />
              <RouteRow name="403" text="团队、appCaller、协议、scope 或来源范围不匹配。" />
              <RouteRow name="404 / 409" text="appCaller 尚未创建，或同一身份已归属于其他团队。" />
              <RouteRow name="requestId" text="测试结果会直接打开请求记录，核对 key、client、environment、状态与路由。" />
            </dl>
          </div>
        </section>

        <section style={cardStyle}>
          <h2 style={headingStyle}><KeyRound size={15} />能力边界</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            <Chip label="本页测试：chat/vision 四协议" color="#3fb950" bg="rgba(63,185,80,0.14)" />
            <Chip label="安全连通：不访问上游" color="#58a6ff" bg="rgba(88,166,255,0.14)" />
            <Chip label="真实模型：明确选择后才调用" color="#d29922" bg="rgba(210,153,34,0.14)" />
          </div>
          <p style={hintStyle}>首版提示词策略只用于 chat/vision。图片生成、ASR、视频和 raw 接口不通过本页批量试跑；需要真实协议验收时，每类最多一次，其余使用假上游。</p>
        </section>
      </div>
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
      <div className="lg-client-quick-step"><strong>2. 填入四项</strong><span>逐项复制，不需要理解协议或请求头。</span>
        <div className="lg-client-copy-values">
          <CopyValue label="API 地址" value={bundle.baseUrl} copyId="cherry-base-url" copied={copied} onCopy={onCopy} />
          <CopyValue label="API Key" value={bundle.key || 'YOUR_ONE_TIME_LLMGW_KEY'} copyId="cherry-key" copied={copied} onCopy={onCopy} secret />
          <CopyValue label="模型" value="auto" copyId="cherry-model" copied={copied} onCopy={onCopy} />
          <CopyValue label="服务商名称" value="LLM Gateway" copyId="cherry-name" copied={copied} onCopy={onCopy} />
        </div>
      </div>
      <div className="lg-client-quick-step"><strong>3. 检查并使用</strong><span>手动添加模型 auto，打开右上角启用开关，点击 API Key 旁的“检查”，然后在新对话选择 LLM Gateway / auto。</span></div>
    </div>;
  }

  const command = openClawSetupCommand(bundle);
  return <div className="lg-client-quick-setup">
    <div className="lg-client-quick-step"><strong>1. 复制配置命令</strong><span>命令使用 OpenClaw 官方增量写入，不会覆盖已有 Provider。</span></div>
    <div className="lg-client-command"><pre><code>{command}</code></pre><Button size="sm" onClick={() => void onCopy('openclaw-command', command)}>{copied === 'openclaw-command' ? <Check size={14} /> : <Copy size={14} />}{copied === 'openclaw-command' ? '已复制' : '复制命令'}</Button></div>
    <div className="lg-client-quick-step"><strong>2. 粘贴到终端</strong><span>OpenClaw 会合并 llmgw Provider、设为默认模型并校验配置；按终端提示重启 Gateway。</span></div>
    <div className="lg-client-quick-step"><strong>3. 发一条消息</strong><span>运行 openclaw chat，发送“只回复 LLMGW_OK”，再用本页 requestId 或请求记录确认实际调用。</span></div>
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

function Step({ number, title, text }: { number: string; title: string; text: string }) {
  return <article style={cardStyle}><div style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 700 }}>步骤 {number}</div><h2 style={{ margin: '6px 0', fontSize: 15, fontWeight: 600 }}>{title}</h2><p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.55 }}>{text}</p></article>;
}

function Field({ label, value, onChange, placeholder, disabled = false }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; disabled?: boolean }) {
  return <label style={labelStyle}>{label}<input value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} style={inputStyle} /></label>;
}

function RouteRow({ name, text }: { name: string; text: string }) {
  return <div><dt style={{ color: 'var(--text-primary)', fontSize: 14, fontWeight: 600 }}>{name}</dt><dd style={{ margin: '3px 0 0', color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.5 }}>{text}</dd></div>;
}

function RouteFact({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong title={value}>{value}</strong></div>;
}

const cardStyle: React.CSSProperties = { padding: 14, background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)' };
const gridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 };
const headingStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, margin: '0 0 10px', fontSize: 15, fontWeight: 600 };
const dlStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, margin: 0 };
const hintStyle: React.CSSProperties = { margin: '10px 0 0', color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.55 };
const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, color: 'var(--text-muted)', fontSize: 13 };
const inputStyle: React.CSSProperties = { minWidth: 0, height: 38, padding: '0 10px', color: 'var(--text-primary)', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', fontSize: 14 };
const preStyle: React.CSSProperties = { margin: 0, minHeight: 180, overflow: 'auto', padding: 14, paddingTop: 48, background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 13, lineHeight: 1.65 };
