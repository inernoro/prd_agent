import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, FileCode2, KeyRound, ListFilter, Play, Rocket, Search, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createGatewayAppCaller, createServiceKey, getOrganization } from '@/lib/api';
import type { OrganizationData } from '@/lib/types';
import { Button, Chip, SectionLoader } from '@/components/ui';

type Protocol = 'native' | 'openai' | 'claude' | 'gemini';
type SnippetTab = 'curl' | 'env' | 'skill';

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
  appCallerCode: string;
  clientCode: string;
  environment: string;
  teamId: string;
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

export function QuickstartPage() {
  const [protocol, setProtocol] = useState<Protocol>('openai');
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
  const [copied, setCopied] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; requestId?: string } | null>(null);

  const selectedProtocol = protocolDefinition(protocol);
  const activeTeams = organization?.teams.filter((team) => team.status === 'active') ?? [];

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
    protocol,
    baseUrl: baseUrl.replace(/\/$/, ''),
    appCallerCode: bundle?.appCallerCode ?? (appCallerCode.trim() || 'my-agent.quickstart::chat'),
    clientCode: bundle?.clientCode ?? (clientCode.trim() || 'my-agent'),
    environment: bundle?.environment ?? environment,
    teamId: bundle?.teamId ?? teamId,
  };
  const snippets = useMemo(() => ({
    curl: exampleFor(displayBundle.protocol, displayBundle.baseUrl, displayBundle.appCallerCode),
    env: environmentSnippet(displayBundle),
    skill: agentSkillSnippet(displayBundle),
  }), [displayBundle.protocol, displayBundle.baseUrl, displayBundle.appCallerCode, displayBundle.key, displayBundle.clientCode, displayBundle.environment]);
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
    if (!teamId || !normalizedBaseUrl || !isValidAppCaller(normalizedCode) || !/^[a-z][a-z0-9._-]{1,79}$/.test(normalizedClient)) {
      setActionError('请确认团队、Gateway 地址、appCallerCode 和 clientCode 均有效。');
      return;
    }
    if (bundle && !window.confirm('将签发一把新密钥，现有密钥不会自动撤销。确认继续？')) return;

    setActionError(null);
    setTestResult(null);
    setCreatingStage('app-caller');
    const callerResponse = await createGatewayAppCaller({
      teamId,
      appCallerCode: normalizedCode,
      requestType: 'chat',
      title: `${normalizedClient} Quickstart`,
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
      scopes: ['invoke'],
      teamId,
      allowedCidrs: [],
    });
    setCreatingStage(null);
    if (!keyResponse.success) {
      setActionError(`appCaller 已就绪，但密钥签发失败：${keyResponse.error?.message || '未知错误'}。请先到接入密钥页确认是否已生成，再决定是否重试。`);
      return;
    }

    setBundle({
      key: keyResponse.data.key,
      keyId: keyResponse.data.id,
      keyPrefix: keyResponse.data.keyPrefix,
      appCallerCode: normalizedCode,
      clientCode: normalizedClient,
      environment,
      teamId,
    });
    setSnippetTab('env');
  };

  const runDryRun = async () => {
    if (!bundle) return;
    setTesting(true);
    setTestResult(null);
    setActionError(null);
    const definition = protocolDefinition(protocol);
    const normalizedBaseUrl = baseUrl.trim().replace(/\/$/, '');
    const requestId = createRequestId();
    try {
      const response = await fetch(new URL(definition.path, `${normalizedBaseUrl}/`).toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bundle.key}`,
          'Content-Type': 'application/json',
          'X-Gateway-Source': 'external',
          'X-Gateway-App-Caller': bundle.appCallerCode,
          'X-Gateway-Dry-Run': 'quickstart',
          'X-Request-Id': requestId,
        },
        body: JSON.stringify(dryRunBody(protocol, bundle.appCallerCode, requestId)),
        credentials: 'omit',
      });
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      const actualRequestId = readRequestId(response, payload) || requestId;
      const upstreamCalled = readUpstreamCalled(response, payload);
      if (!response.ok) {
        setTestResult({ ok: false, message: readErrorMessage(payload) || `dry-run 失败，HTTP ${response.status}`, requestId: actualRequestId });
      } else if (upstreamCalled === false) {
        setTestResult({ ok: true, message: `${definition.label} 协议、团队边界和密钥鉴权均通过；已写入请求记录，未访问上游。`, requestId: actualRequestId });
      } else {
        setTestResult({ ok: false, message: 'Gateway 未明确证明 upstreamCalled=false，本次结果不计为安全验收。', requestId: actualRequestId });
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
    setSnippetTab('curl');
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <header>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Rocket size={18} /><h1 style={{ margin: 0, fontSize: 18 }}>Quickstart</h1></div>
          <p style={{ margin: '7px 0 0', color: 'var(--text-muted)', fontSize: 13 }}>三步获得可审计的 Agent 接入配置：选择协议和团队，一次生成 appCaller 与密钥，再用真实协议地址执行零费用 dry-run。</p>
        </header>

        <section className="lg-quickstart-steps" style={{ ...gridStyle, gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
          <Step number="1" title="确认用途" text="选择团队、协议和 appCallerCode。appCaller 表示为什么调用，密钥表示谁在调用。" />
          <Step number="2" title="生成配置" text="同页创建 appCaller 并签发团队密钥。明文只保存在本页内存，刷新后不可找回。" />
          <Step number="3" title="测试并回查" text="点击测试当前协议，Gateway 不访问上游，但会返回 requestId 并写入租户请求记录。" />
        </section>

        <section style={cardStyle}>
          <h2 style={headingStyle}><ShieldCheck size={15} />第一条可审计请求</h2>
          {organizationLoading ? <SectionLoader text="正在读取当前租户和团队" /> : null}
          {organizationError ? <div className="lg-test-result is-error">{organizationError}</div> : null}
          {!organizationLoading ? (
            <div className="lg-quickstart-inputs" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
              <label style={labelStyle}>团队<select value={teamId} disabled={Boolean(bundle)} onChange={(event) => setTeamId(event.target.value)} style={inputStyle}>
                <option value="">选择团队</option>
                {activeTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
              </select></label>
              <Field label="appCallerCode" value={appCallerCode} onChange={setAppCallerCode} placeholder="my-agent.quickstart::chat" disabled={Boolean(bundle)} />
              <Field label="Client code" value={clientCode} onChange={setClientCode} placeholder="my-agent" disabled={Boolean(bundle)} />
              <label style={labelStyle}>环境<select value={environment} disabled={Boolean(bundle)} onChange={(event) => setEnvironment(event.target.value)} style={inputStyle}>
                <option value="development">开发</option><option value="test">测试</option><option value="staging">预发布</option><option value="production">生产</option>
              </select></label>
            </div>
          ) : null}

          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', margin: '12px 0' }}>
            {PROTOCOLS.map((item) => <Button key={item.id} size="sm" variant={protocol === item.id ? 'primary' : 'ghost'} onClick={() => { setProtocol(item.id); setTestResult(null); }}>{item.label}</Button>)}
          </div>

          <div className="lg-quickstart-inputs" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 8 }}>
            <label style={labelStyle}>Gateway 地址<code className="lg-derived-base-url">{baseUrl}</code></label>
            <label style={labelStyle}>测试路径<code className="lg-derived-base-url">{selectedProtocol.path}</code></label>
          </div>
          <details className="lg-advanced-base-url"><summary>使用其他 Gateway 地址</summary><Field label="自定义 Gateway 地址" value={baseUrl} onChange={setBaseUrl} /></details>

          <div className="lg-quickstart-actions">
            <div><strong>{creatingStage === 'app-caller' ? '正在创建 appCaller' : creatingStage === 'key' ? '正在签发团队密钥' : bundle ? '接入配置已生成' : '尚未生成接入配置'}</strong><small>{bundle ? `密钥 ${bundle.keyPrefix}，只授权当前 appCaller 和上方四种协议；切换协议后可直接测试。` : '不会创建通配 key，也不会调用付费模型。'}</small></div>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {bundle ? <Button variant="ghost" onClick={editIdentity}>修改身份</Button> : null}
              <Button variant="primary" disabled={organizationLoading || creatingStage !== null || activeTeams.length === 0} onClick={() => void createAccessBundle()}><KeyRound size={14} />{creatingStage ? '生成中' : bundle ? '再签一把同配置 key' : '一键生成 appCaller 与 key'}</Button>
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

          <div className="lg-safe-test-panel" style={{ marginTop: 12 }}>
            <div><Play size={17} /><span><strong>测试当前协议</strong><small>请求会发送到 {selectedProtocol.path}，经过 service key 与团队治理后写日志，并在模型解析前结束。</small></span></div>
            <div className="lg-safe-test-controls"><Button variant="primary" disabled={!bundle || testing} onClick={() => void runDryRun()}>{testing ? '正在测试并写日志' : '点击测试'}</Button><span style={{ alignSelf: 'center', color: 'var(--text-muted)', fontSize: 11 }}>明确返回 upstreamCalled=false 才算通过</span></div>
            {testResult ? <div className={testResult.ok ? 'lg-test-result is-ok' : 'lg-test-result is-error'} role="status">{testResult.message}{testResult.requestId ? <Link to={`/logs?requestId=${encodeURIComponent(testResult.requestId)}`}>打开 requestId 请求记录</Link> : null}</div> : null}
          </div>

          <div className="lg-snippet-tabs">
            <Button size="sm" variant={snippetTab === 'curl' ? 'primary' : 'ghost'} onClick={() => setSnippetTab('curl')}>cURL</Button>
            <Button size="sm" variant={snippetTab === 'env' ? 'primary' : 'ghost'} onClick={() => setSnippetTab('env')}>环境变量</Button>
            <Button size="sm" variant={snippetTab === 'skill' ? 'primary' : 'ghost'} onClick={() => setSnippetTab('skill')}><FileCode2 size={14} />Agent Skill</Button>
          </div>
          <div style={{ position: 'relative' }}>
            <pre style={preStyle}><code>{visibleSnippet}</code></pre>
            <Button size="sm" style={{ position: 'absolute', top: 9, right: 9 }} onClick={() => void copyText(snippetTab, visibleSnippet)}>{copied === snippetTab ? <Check size={14} /> : <Copy size={14} />}{copied === snippetTab ? '已复制' : '复制'}</Button>
          </div>
          <p style={hintStyle}>示例默认带 <code>X-Gateway-Dry-Run: quickstart</code>，不会产生上游费用。完成日志回查后，删除该 header 才会执行真实模型调用。不要把密钥提交到仓库、截图、URL 或日志。</p>
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
            <Chip label="本页一键测试: chat 四协议" color="#3fb950" bg="rgba(63,185,80,0.14)" />
            <Chip label="vision: 同一治理链，需多模态请求体" color="#8b949e" bg="rgba(139,148,158,0.14)" />
            <Chip label="dry-run: 不访问上游" color="#58a6ff" bg="rgba(88,166,255,0.14)" />
            <Chip label="费用: dry-run 保持未知" color="#d29922" bg="rgba(210,153,34,0.14)" />
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

function isValidAppCaller(value: string) {
  return /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+::chat$/.test(value) && value.length <= 200;
}

function createRequestId() {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replaceAll('-', '')
    : `${Date.now()}${Math.random().toString(16).slice(2)}`;
  return `quickstart-${suffix.slice(0, 24)}`;
}

function dryRunBody(protocol: Protocol, appCallerCode: string, requestId: string) {
  if (protocol === 'native') return {
    appCallerCode,
    modelType: 'chat',
    requestBody: { messages: [{ role: 'user', content: 'Reply with OK' }] },
    context: { requestId, sourceSystem: 'external', modelPolicy: 'auto' },
  };
  if (protocol === 'claude') return { model: 'auto', model_policy: 'auto', max_tokens: 64, messages: [{ role: 'user', content: 'Reply with OK' }] };
  if (protocol === 'gemini') return { model_policy: 'auto', contents: [{ role: 'user', parts: [{ text: 'Reply with OK' }] }] };
  return { model: 'auto', model_policy: 'auto', messages: [{ role: 'user', content: 'Reply with OK' }], stream: false };
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

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function environmentSnippet(bundle: DisplayBundle) {
  return `export LLMGW_BASE_URL="${bundle.baseUrl}"
export LLMGW_API_KEY="${bundle.key || 'YOUR_ONE_TIME_LLMGW_KEY'}"
export LLMGW_APP_CALLER="${bundle.appCallerCode}"
export LLMGW_PROTOCOL="${protocolDefinition(bundle.protocol).ingressProtocol}"
export LLMGW_CLIENT_CODE="${bundle.clientCode}"
export LLMGW_ENVIRONMENT="${bundle.environment}"`;
}

function agentSkillSnippet(bundle: DisplayBundle) {
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

## 执行规则

1. 请求 ${definition.path}。
2. 使用 Authorization: Bearer \$LLMGW_API_KEY。
3. 固定发送 X-Gateway-Source: external 与 X-Gateway-App-Caller: \$LLMGW_APP_CALLER。
4. 首次接入发送 X-Gateway-Dry-Run: quickstart；只有响应明确 upstreamCalled=false 才算安全测试通过。
5. 保存响应头 X-Request-Id，并打开控制台 /logs?requestId={requestId} 核对团队、service key、client 和 environment。
6. 正式调用时删除 X-Gateway-Dry-Run；同类真实协议验收最多一次，其余使用假上游。

## 安全边界

- 不发送 tenantId，租户只由服务端从 key 解析。
- 不记录、不输出、不提交 LLMGW_API_KEY。
- 401 时轮换密钥；403 时检查 team、appCaller、协议和 scope，禁止通过扩大到通配 key 绕过。`;
}

function exampleFor(protocol: Protocol, baseUrl: string, appCaller: string) {
  const definition = protocolDefinition(protocol);
  const common = `-H "Authorization: Bearer \$LLMGW_API_KEY" \\
  -H "X-Gateway-Source: external" \\
  -H "X-Gateway-App-Caller: ${appCaller}" \\
  -H "X-Gateway-Dry-Run: quickstart" \\
  -H "X-Request-Id: quickstart-\$(date +%s)"`;
  const body = JSON.stringify(dryRunBody(protocol, appCaller, 'quickstart-curl'), null, 2);
  const extra = protocol === 'claude' ? ' \\\n  -H "anthropic-version: 2023-06-01"' : '';
  return `curl "${baseUrl}${definition.path}" \\
  ${common}${extra} \\
  -H "Content-Type: application/json" \\
  -d '${body}'`;
}

function Step({ number, title, text }: { number: string; title: string; text: string }) {
  return <article style={cardStyle}><div style={{ color: 'var(--accent)', fontSize: 11, fontWeight: 700 }}>STEP {number}</div><h2 style={{ margin: '6px 0', fontSize: 13 }}>{title}</h2><p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.55 }}>{text}</p></article>;
}

function Field({ label, value, onChange, placeholder, disabled = false }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; disabled?: boolean }) {
  return <label style={labelStyle}>{label}<input value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} style={inputStyle} /></label>;
}

function RouteRow({ name, text }: { name: string; text: string }) {
  return <div><dt style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 650 }}>{name}</dt><dd style={{ margin: '3px 0 0', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5 }}>{text}</dd></div>;
}

const cardStyle: React.CSSProperties = { padding: 14, background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)' };
const gridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 };
const headingStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, margin: '0 0 10px', fontSize: 13 };
const dlStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, margin: 0 };
const hintStyle: React.CSSProperties = { margin: '10px 0 0', color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.55 };
const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, color: 'var(--text-muted)', fontSize: 11 };
const inputStyle: React.CSSProperties = { minWidth: 0, height: 36, padding: '0 9px', color: 'var(--text-primary)', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' };
const preStyle: React.CSSProperties = { margin: 0, minHeight: 250, overflow: 'auto', padding: 14, paddingTop: 48, background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 12, lineHeight: 1.6 };
