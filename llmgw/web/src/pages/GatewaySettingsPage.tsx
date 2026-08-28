// 服务网关设置：网关自己要调模型时，用哪个池 / 哪个模型。
//
// 为什么要有这一页（用户原话：「系统就是服务网关，还有 401 问题?」）：
// 控制台的内部功能也要调模型。第一版把它接在环境变量 + 一把手签的 service key 上，
// 那把 key 一旦被撤销、轮换，或容器 env 与网关库的密钥目录对不上，serving 就在鉴权门上
// 回一个裸 401 —— 网关对自己说「你没权限」，而用户除了看见三个数字什么也做不了。
//
// 所以这一页只让用户做**一个**决定：这套系统功能用哪个模型。
// serving 地址、系统 appCaller、密钥全部由后端自己管、失效自愈，在这里只读展示不做输入
// （minimal-user-input：系统自己知道的值，不许摆成输入框）。
// 连带义务同样落在这一页：能当场测一次、看得到系统替你配了什么、失败给得出下一步。
import { useEffect, useState } from 'react';
import { Boxes, Cpu, PlugZap, Sparkles } from 'lucide-react';
import { getSystemSettings, saveSystemSettings, testSystemSettings } from '@/lib/api';
import type { SystemGatewaySettings, SystemGatewayTestResult } from '@/lib/types';
import { Button, Card, InlineAlert, SectionLoader } from '@/components/ui';
import { PageBody, PageHeader, PageShell, Prose } from '@/components/PageShell';
import { GAP } from '@/lib/surface';
import { FIELD_LABEL, HINT_TEXT, MONO_META, SECTION_TITLE } from '@/lib/typography';

type ModelSource = 'auto' | 'pool' | 'model';

const SOURCES: Array<{ id: ModelSource; label: string; hint: string; icon: typeof Sparkles }> = [
  { id: 'auto', label: '交给网关挑', hint: '按默认对话池调度，池里换成员不用改这里', icon: Sparkles },
  { id: 'pool', label: '钉一个模型池', hint: '只在这个池里调度，池内仍可自动换成员', icon: Boxes },
  { id: 'model', label: '钉一个模型', hint: '固定用这一个模型，不再自动换', icon: Cpu },
];

const CREDENTIAL_TEXT: Record<SystemGatewaySettings['credentialState'], string> = {
  ready: '已就绪，网关自己签的',
  'will-issue': '还没签过，首次调用时自动签发',
  'will-reissue': '旧的已失效，下次调用自动重签',
};

export function GatewaySettingsPage() {
  const [data, setData] = useState<SystemGatewaySettings | null>(null);
  const [source, setSource] = useState<ModelSource>('auto');
  const [poolId, setPoolId] = useState('');
  const [modelName, setModelName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SystemGatewayTestResult | null>(null);

  const load = async () => {
    const res = await getSystemSettings();
    if (!res.success) { setError(res.error?.message || '加载失败'); return; }
    setData(res.data);
    setSource(res.data.modelSource);
    setPoolId(res.data.modelGroupId ?? res.data.pools.find((p) => p.isDefault)?.id ?? '');
    setModelName(res.data.modelName ?? '');
  };
  useEffect(() => { void load(); }, []);

  const save = async () => {
    setSaving(true); setError(null); setNotice(null);
    const res = await saveSystemSettings({
      modelSource: source,
      modelGroupId: source === 'pool' ? poolId : undefined,
      modelName: source === 'model' ? modelName : undefined,
    });
    setSaving(false);
    if (!res.success) { setError(res.error?.message || '保存失败'); return; }
    setNotice('已保存。系统功能下一次调用就按这个走。');
    await load();
  };

  // 保存完必须能当场验一次——否则「最小输入」就退化成蒙着眼睛少填几个字。
  const runTest = async () => {
    setTesting(true); setError(null); setTestResult(null);
    const res = await testSystemSettings();
    setTesting(false);
    if (!res.success) { setError(res.error?.message || '测试请求失败'); return; }
    setTestResult(res.data);
  };

  if (!data) {
    return (
      <PageShell>
        <PageHeader title="服务网关设置" subtitle="网关自己要调模型时用哪个池、哪个模型。" />
        <PageBody>{error ? <InlineAlert tone="error">{error}</InlineAlert> : <SectionLoader text="正在读取系统级配置" />}</PageBody>
      </PageShell>
    );
  }

  const dirty = source !== data.modelSource
    || (source === 'pool' && poolId !== (data.modelGroupId ?? ''))
    || (source === 'model' && modelName !== (data.modelName ?? ''));

  return (
    <PageShell>
      <PageHeader
        title="服务网关设置"
        subtitle="网关自己要调模型时用哪个池、哪个模型。"
      />
      <PageBody>
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        {notice ? <InlineAlert tone="ok">{notice}</InlineAlert> : null}

        <Card className="lg-gws-card">
          <div style={SECTION_TITLE}>系统级模型</div>
          <div className="lg-gws-sources" role="radiogroup" aria-label="系统级模型来源">
            {SOURCES.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={source === item.id}
                  className={source === item.id ? 'is-active' : ''}
                  onClick={() => setSource(item.id)}
                >
                  <Icon size={16} />
                  <strong>{item.label}</strong>
                  <small>{item.hint}</small>
                </button>
              );
            })}
          </div>

          {source === 'pool' ? (
            <label className="lg-gws-field">
              <span style={FIELD_LABEL}>对话模型池</span>
              <select value={poolId} onChange={(event) => setPoolId(event.target.value)}>
                <option value="">请选择一个池</option>
                {data.pools.map((pool) => (
                  <option key={pool.id} value={pool.id}>{pool.name}{pool.isDefault ? '（默认池）' : ''}</option>
                ))}
              </select>
              {data.pools.length === 0 ? <small style={HINT_TEXT}>当前租户下还没有对话类模型池，先去「模型池」建一个。</small> : null}
            </label>
          ) : null}

          {source === 'model' ? (
            <label className="lg-gws-field">
              <span style={FIELD_LABEL}>逻辑模型</span>
              <select value={modelName} onChange={(event) => setModelName(event.target.value)}>
                <option value="">请选择一个模型</option>
                {data.models.map((model) => (
                  <option key={model.id} value={model.name}>{model.name}</option>
                ))}
              </select>
              {data.models.length === 0 ? <small style={HINT_TEXT}>当前没有启用的对话类逻辑模型，先去「逻辑模型」启用一个。</small> : null}
            </label>
          ) : null}

          <div className="lg-gws-actions">
            <span className="lg-gws-actions-hint">测试连接会真发一次极短对话，回报耗时与实际执行的模型。</span>
            <Button disabled={testing} onClick={() => void runTest()}>
              <PlugZap size={15} />{testing ? '正在测试' : '测试连接'}
            </Button>
            <Button variant="primary" disabled={saving || !dirty} onClick={() => void save()}>
              {saving ? '正在保存' : '保存设置'}
            </Button>
          </div>
          {testResult ? (
            <InlineAlert tone={testResult.ok ? 'ok' : 'error'}>{testResult.message}</InlineAlert>
          ) : null}
        </Card>

        {/*
          系统替你配了什么：少填不等于少知道。这一块把地址、用途码、密钥状态、归属团队
          全部端出来，用户一眼能核对，出问题时也知道该去哪一页。
        */}
        <Card className="lg-gws-card">
          <div style={SECTION_TITLE}>系统替你配好的</div>
          <div className="lg-gws-facts">
            <div>
              <span style={FIELD_LABEL}>网关服务地址</span>
              <code style={MONO_META}>{data.servingReachable ? data.servingBaseUrl : '没探到'}</code>
              <small style={HINT_TEXT}>同一部署内的固定地址，不需要填。</small>
            </div>
            <div>
              <span style={FIELD_LABEL}>系统调用用途码</span>
              <code style={MONO_META}>{data.appCallerCode}</code>
              <small style={HINT_TEXT}>网关自己的用量记在它名下，与业务用途码分开。</small>
            </div>
            <div>
              <span style={FIELD_LABEL}>系统密钥</span>
              <code style={MONO_META}>{data.credentialPrefix ?? '尚未签发'}</code>
              <small style={HINT_TEXT}>{CREDENTIAL_TEXT[data.credentialState]}；明文只在服务端，永不下发。</small>
            </div>
            <div>
              <span style={FIELD_LABEL}>归属团队</span>
              <code style={MONO_META}>{data.teamName ?? '系统内部'}</code>
              <small style={HINT_TEXT}>
                {data.teamIsSystemOwned
                  ? '系统自己的团队，单独计费：这些消耗不进任何业务团队的预算，也不随谁在操作而变。'
                  : '系统功能的用量与预算记在这个团队名下。'}
              </small>
            </div>
          </div>
        </Card>

        <Card className="lg-gws-card">
          <div style={SECTION_TITLE}>谁在用它</div>
          <Prose>改上面那一项会影响下列功能。</Prose>
          <ul className="lg-gws-consumers" style={{ display: 'grid', gap: GAP.normal, margin: 0, padding: 0, listStyle: 'none' }}>
            {data.consumers.map((item) => (
              <li key={item.appCallerCode}>
                <strong>{item.feature}</strong>
                <code style={MONO_META}>{item.appCallerCode}</code>
              </li>
            ))}
          </ul>
        </Card>
      </PageBody>
    </PageShell>
  );
}
