import { useMemo, useState } from 'react';
import { Check, Copy, KeyRound, ListFilter, Rocket, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button, Chip } from '@/components/ui';

type Protocol = 'native' | 'openai' | 'claude' | 'gemini';

const PROTOCOLS: { id: Protocol; label: string; path: string }[] = [
  { id: 'native', label: 'GW Native', path: '/gw/v1/invoke' },
  { id: 'openai', label: 'OpenAI', path: '/v1/chat/completions' },
  { id: 'claude', label: 'Claude', path: '/v1/messages' },
  { id: 'gemini', label: 'Gemini', path: '/v1beta/models/auto:generateContent' },
];

export function QuickstartPage() {
  const [protocol, setProtocol] = useState<Protocol>('openai');
  const [baseUrl, setBaseUrl] = useState(resolveDefaultServingBaseUrl);
  const [appCallerCode, setAppCallerCode] = useState('my-team.quickstart::chat');
  const [copied, setCopied] = useState(false);
  const code = useMemo(
    () => exampleFor(protocol, baseUrl.replace(/\/$/, ''), appCallerCode.trim() || 'my-team.quickstart::chat').replaceAll('\n+', '\n'),
    [protocol, baseUrl, appCallerCode],
  );

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <header>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Rocket size={18} /><h1 style={{ margin: 0, fontSize: 18 }}>Quickstart</h1></div>
          <p style={{ margin: '7px 0 0', color: 'var(--text-muted)', fontSize: 13 }}>从租户密钥到第一条可在 Activity 定位的请求，四种协议使用同一套租户隔离与路由治理。</p>
        </header>

        <section className="lg-quickstart-steps" style={gridStyle}>
          <Step number="1" title="准备组织" text="由 owner 或 admin 创建租户、团队和成员。Developer 只能管理自己创建的密钥。" />
          <Step number="2" title="创建密钥" text="绑定 appCaller、协议、scope，可选团队、CIDR、有效期和每分钟限流。明文只显示一次。" link="/service-keys" />
          <Step number="3" title="发送请求" text="复制下方示例。示例永远使用占位符，不会把真实密钥写入页面源码或日志。" />
          <Step number="4" title="核对 Activity" text="从响应或 X-Request-Id 取得 requestId，再到请求日志搜索并核对租户、费用与路由。" link="/logs" />
        </section>

        <section style={cardStyle}>
          <div className="lg-quickstart-inputs" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
            <Field label="Gateway Base URL" value={baseUrl} onChange={setBaseUrl} />
            <Field label="appCallerCode" value={appCallerCode} onChange={setAppCallerCode} />
          </div>
          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 10 }}>
            {PROTOCOLS.map((item) => <Button key={item.id} size="sm" variant={protocol === item.id ? 'primary' : 'ghost'} onClick={() => setProtocol(item.id)}>{item.label}</Button>)}
          </div>
          <div style={{ position: 'relative' }}>
            <pre style={{ margin: 0, minHeight: 250, overflow: 'auto', padding: 14, background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 12, lineHeight: 1.6 }}><code>{code}</code></pre>
            <Button size="sm" style={{ position: 'absolute', top: 9, right: 9 }} onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制' : '复制'}</Button>
          </div>
          <p style={hintStyle}>先把 <code>YOUR_LLMGW_KEY</code> 放入本地环境变量 <code>LLMGW_API_KEY</code>。不要把真实密钥提交到仓库、截图或浏览器地址栏。</p>
        </section>

        <section className="lg-quickstart-detail-grid" style={{ ...gridStyle, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
          <div style={cardStyle}>
            <h2 style={headingStyle}><ListFilter size={15} />路由选择</h2>
            <dl style={dlStyle}>
              <RouteRow name="auto" text="不传池或固定目标，由 appCaller 默认池和健康路由选择。建议作为默认。" />
              <RouteRow name="pool" text="传 modelPoolId / model_pool_id，限制在指定池内路由。" />
              <RouteRow name="pinned" text="同时传 pinnedPlatformId 与 pinnedModelId，仅用于明确的诊断或对比。" />
            </dl>
          </div>
          <div style={cardStyle}>
            <h2 style={headingStyle}><Search size={15} />错误定位</h2>
            <dl style={dlStyle}>
              <RouteRow name="401" text="密钥缺失、错误、过期或已撤销。重新创建，旧明文无法找回。" />
              <RouteRow name="403" text="tenant/team、appCaller、协议、scope 或来源 CIDR 不允许。" />
              <RouteRow name="404 / 409" text="目标不存在，或同一 requestId 正在执行。" />
              <RouteRow name="429 / 5xx" text="密钥或 appCaller 限流；上游失败时用 requestId 到 Activity 查看路由链。" />
            </dl>
          </div>
        </section>

        <section style={cardStyle}>
          <h2 style={headingStyle}><KeyRound size={15} />能力边界</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            <Chip label="chat: 四协议" color="#3fb950" bg="rgba(63,185,80,0.14)" />
            <Chip label="vision: 四协议多模态形状" color="#3fb950" bg="rgba(63,185,80,0.14)" />
            <Chip label="stream: Native/OpenAI/Claude/Gemini" color="#58a6ff" bg="rgba(88,166,255,0.14)" />
            <Chip label="image: OpenAI images + Native raw" color="#d29922" bg="rgba(210,153,34,0.14)" />
            <Chip label="ASR/视频: 使用 Native raw 与异步状态接口" color="#d29922" bg="rgba(210,153,34,0.14)" />
          </div>
          <p style={hintStyle}>流式调用需要 <code>stream:invoke</code>，Native raw 需要 <code>raw:invoke</code>。不要为了测试批量调用付费模型；同类真实协议只验一次，其余使用假上游。</p>
        </section>
      </div>
    </div>
  );
}

function resolveDefaultServingBaseUrl() {
  const configured = (import.meta.env.VITE_LLMGW_SERVING_BASE_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;

  const current = new URL(window.location.href);
  if (current.pathname === '/llmgw' || current.pathname.startsWith('/llmgw/')) return current.origin;
  if (current.hostname.includes('-llmgw-web.')) {
    current.hostname = current.hostname.replace('-llmgw-web.', '.');
    current.port = '';
    return current.origin;
  }
  return 'https://gateway.example.com';
}

function Step({ number, title, text, link }: { number: string; title: string; text: string; link?: string }) {
  return <article style={cardStyle}><div style={{ color: 'var(--accent)', fontSize: 11, fontWeight: 700 }}>STEP {number}</div><h2 style={{ margin: '6px 0', fontSize: 13 }}>{title}</h2><p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.55 }}>{text}</p>{link ? <Link to={link} style={{ display: 'inline-block', marginTop: 8, color: 'var(--accent)', fontSize: 12 }}>打开页面</Link> : null}</article>;
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label style={{ display: 'flex', flexDirection: 'column', gap: 5, color: 'var(--text-muted)', fontSize: 11 }}>{label}<input value={value} onChange={(event) => onChange(event.target.value)} style={{ height: 34, padding: '0 9px', color: 'var(--text-primary)', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }} /></label>;
}

function RouteRow({ name, text }: { name: string; text: string }) {
  return <div><dt style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 650 }}>{name}</dt><dd style={{ margin: '3px 0 0', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5 }}>{text}</dd></div>;
}

function exampleFor(protocol: Protocol, baseUrl: string, appCaller: string) {
  const common = `-H "Authorization: Bearer $LLMGW_API_KEY" \\\n+  -H "X-Gateway-Source: external" \\\n+  -H "X-Gateway-App-Caller: ${appCaller}" \\\n+  -H "X-Request-Id: quickstart-$(date +%s)"`;
  if (protocol === 'native') return `curl "${baseUrl}/gw/v1/invoke" \\\n+  ${common} \\\n+  -H "Content-Type: application/json" \\\n+  -d '{
    "appCallerCode": "${appCaller}",
    "modelType": "chat",
    "requestBody": {
      "messages": [{ "role": "user", "content": "Reply with OK" }]
    },
    "context": { "requestId": "quickstart-native", "sourceSystem": "external", "modelPolicy": "auto" }
  }'`;
  if (protocol === 'claude') return `curl "${baseUrl}/v1/messages" \\\n+  ${common} \\\n+  -H "Content-Type: application/json" \\\n+  -H "anthropic-version: 2023-06-01" \\\n+  -d '{
    "model": "auto",
    "model_policy": "auto",
    "max_tokens": 64,
    "messages": [{ "role": "user", "content": "Reply with OK" }]
  }'`;
  if (protocol === 'gemini') return `curl "${baseUrl}/v1beta/models/auto:generateContent" \\\n+  ${common} \\\n+  -H "Content-Type: application/json" \\\n+  -d '{
    "model_policy": "auto",
    "contents": [{ "role": "user", "parts": [{ "text": "Reply with OK" }] }]
  }'`;
  return `curl "${baseUrl}/v1/chat/completions" \\\n+  ${common} \\\n+  -H "Content-Type: application/json" \\\n+  -d '{
    "model": "auto",
    "model_policy": "auto",
    "messages": [{ "role": "user", "content": "Reply with OK" }],
    "stream": false
  }'`;
}

const cardStyle: React.CSSProperties = { padding: 14, background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)' };
const gridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 };
const headingStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, margin: '0 0 10px', fontSize: 13 };
const dlStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, margin: 0 };
const hintStyle: React.CSSProperties = { margin: '10px 0 0', color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.55 };
