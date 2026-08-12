// Provider（模型供应方）：先完成单个 Provider 的可理解自助配置，再把批量维护收进高级区。
// 密钥明文只随创建/轮换请求发送，列表永远只展示 hasKey。
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { bulkRotateApiKeys, claimPlatformToGateway, createPlatform, deletePlatform, deletePlatformApiKey, getPlatforms, getProviderPresets, getUpstreamModels, importUpstreamModels, rotatePlatformApiKey, setPlatformEnabled, testPlatformConnection } from '@/lib/api';
import type { CreatePlatformRequest, PlatformItem, PlatformTestResult, ProviderPresetItem, UpstreamModelsData } from '@/lib/types';
import { Chip, SectionLoader, Button, ReadOnlyNotice, InlineAlert } from '@/components/ui';
import { ProviderPresetPicker, TestResultBar, UpstreamModelPicker, keyPrefixWarning } from '@/components/ProviderSetup';
import { EntityPreviewDrawer } from '@/components/EntityPreviewDrawer';
import { boolChip } from '@/components/poolsHelpers';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';
import { FIELD_INPUT, FIELD_LABEL, HINT_TEXT, TABLE_CELL, TABLE_HEAD_CELL, TOOLBAR_CONTROL } from '@/lib/typography';

export function PlatformsPage() {
  const { tenant } = useAuth();
  const canWrite = canUseCapability(tenant?.role, 'configWrite');
  const [items, setItems] = useState<PlatformItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [keyEditId, setKeyEditId] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState('');
  const [bulkKeyValue, setBulkKeyValue] = useState('');
  const [bulkOnlyMissing, setBulkOnlyMissing] = useState(true);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [draft, setDraft] = useState<CreatePlatformRequest>({
    name: '',
    platformType: 'openai',
    apiUrl: '',
    apiKey: '',
    maxConcurrency: 20,
  });
  // 内置上游预设：选一个就把地址/协议/并发一次性带出来（minimal-user-input.md）
  const [presets, setPresets] = useState<ProviderPresetItem[]>([]);
  const [preset, setPreset] = useState<ProviderPresetItem | null>(null);
  // 接完之后的两件交代：能不能通、上游有哪些模型
  const [testResult, setTestResult] = useState<Record<string, PlatformTestResult>>({});
  const [discovery, setDiscovery] = useState<{ platformId: string; data: UpstreamModelsData } | null>(null);

  useEffect(() => {
    let alive = true;
    getPlatforms().then((res) => {
      if (!alive) return;
      if (res.success) {
        setItems(res.data.items);
        setShowCreate(res.data.items.length === 0);
      }
      else setError(res.error?.message || '加载失败');
    });
    getProviderPresets().then((res) => {
      if (alive && res.success) setPresets(res.data.items);
    });
    return () => {
      alive = false;
    };
  }, []);

  /** 选中预设 = 一次性填好所有系统知道的字段，用户只剩密钥要填。 */
  function applyPreset(next: ProviderPresetItem | null) {
    setPreset(next);
    setDraft((value) => next
      ? {
        ...value,
        name: next.name,
        platformType: next.platformType,
        apiUrl: next.apiUrl,
        providerId: next.providerId || undefined,
        maxConcurrency: next.maxConcurrency,
        // 本地/自建上游不校验密钥，但网关的 Provider 记录把密钥当必填不变量。
        // 系统自己知道该填什么就替他填（minimal-user-input），别让他对着一个
        // 「写着无需密钥、留空却被拒」的输入框卡住。已经敲过的密钥不覆盖。
        apiKey: next.keylessPlaceholder && !value.apiKey ? next.keylessPlaceholder : value.apiKey,
      }
      // 取消选中回到自定义：只清掉预设带来的地址，用户已经敲的密钥不动
      : { ...value, name: '', apiUrl: '', providerId: undefined });
  }

  async function runTest(p: PlatformItem) {
    setBusyId(p.id);
    setToast(null);
    const res = await testPlatformConnection(p.id);
    setBusyId(null);
    if (res.success) setTestResult((prev) => ({ ...prev, [p.id]: res.data }));
    else setToast(res.error?.message || '测试失败');
  }

  async function openDiscovery(p: PlatformItem) {
    setBusyId(p.id);
    setToast(null);
    const res = await getUpstreamModels(p.id);
    setBusyId(null);
    if (res.success) setDiscovery({ platformId: p.id, data: res.data });
    else setToast(res.error?.message || '拉取模型清单失败');
  }

  async function submitCreate(event: React.FormEvent) {
    event.preventDefault();
    setCreateBusy(true);
    setToast(null);
    const res = await createPlatform(draft);
    setCreateBusy(false);
    if (!res.success) {
      setDraft((value) => ({ ...value, apiKey: '' }));
      setToast(res.error?.message || '创建失败');
      return;
    }
    setItems((prev) => [...(prev || []), res.data]);
    setDraft({ name: '', platformType: 'openai', apiUrl: '', apiKey: '', maxConcurrency: 20 });
    setPreset(null);
    setShowCreate(false);
    setToast(`Provider「${res.data.name}」已保存。正在测试连接…`);
    // 保存完立刻自测一次：最小输入的连带义务是「当场知道对不对」，
    // 不能等到业务真去调模型时才发现密钥是错的。
    const test = await testPlatformConnection(res.data.id);
    if (test.success) {
      setTestResult((prev) => ({ ...prev, [res.data.id]: test.data }));
      setToast(test.data.reachable
        ? `Provider「${res.data.name}」已保存，连接正常，可以拉取模型清单了`
        : `Provider「${res.data.name}」已保存，但连接测试没通过，见下方提示`);
      if (test.data.reachable) await openDiscovery(res.data);
    } else {
      setToast(`Provider「${res.data.name}」已保存（自动测试没跑起来，可在列表里手动点「测试连接」）`);
    }
  }

  async function runImport(platformId: string, selected: UpstreamModelsData['items']) {
    setBusyId(platformId);
    setToast(null);
    const res = await importUpstreamModels(platformId, selected.map((m) => ({
      modelId: m.modelId,
      capabilities: m.inferredCapabilities,
      inputPricePerMillion: m.inputPricePerMillion,
      outputPricePerMillion: m.outputPricePerMillion,
      pricePerCall: m.pricePerCall,
      priceCurrency: m.priceCurrency,
    })));
    setBusyId(null);
    if (!res.success) {
      setToast(res.error?.message || '导入失败');
      return;
    }
    // 池同步失败时后端会如实回传：模型入库了但池路由选不到，不能报成全绿
    const base = `已导入 ${res.data.created} 个模型${res.data.skipped > 0 ? `，跳过 ${res.data.skipped} 个已存在的` : ''}`;
    setToast(res.data.poolSyncFailed && res.data.message ? `${base}。${res.data.message}` : base);
    setDiscovery(null);
  }

  async function toggle(p: PlatformItem) {
    setBusyId(p.id);
    setToast(null);
    const res = await setPlatformEnabled(p.id, !p.enabled);
    setBusyId(null);
    if (res.success) {
      setItems((prev) => (prev ? prev.map((x) => (x.id === p.id ? res.data : x)) : prev));
      setToast(`已${res.data.enabled ? '启用' : '停用'}平台「${res.data.name}」`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function claimPlatform(p: PlatformItem) {
    setBusyId(p.id);
    setToast(null);
    const res = await claimPlatformToGateway(p.id);
    setBusyId(null);
    if (res.success) {
      setItems((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? res.data : x)) : prev));
      setToast(`已将「${res.data.name}」导入平台配置`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function saveApiKey(p: PlatformItem) {
    const apiKey = keyValue.trim();
    if (!apiKey) {
      setToast('apiKey 不能为空');
      return;
    }
    setBusyId(p.id);
    setToast(null);
    const res = await rotatePlatformApiKey(p.id, apiKey);
    setBusyId(null);
    if (res.success) {
      setItems((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? res.data : x)) : prev));
      setKeyEditId(null);
      setKeyValue('');
      setToast(`已更新「${res.data.name}」的 GW 平台密钥`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function clearApiKey(p: PlatformItem) {
    if (!window.confirm(`清除「${p.name}」的 GW 平台密钥？`)) return;
    setBusyId(p.id);
    setToast(null);
    const res = await deletePlatformApiKey(p.id);
    setBusyId(null);
    if (res.success) {
      setItems((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? res.data : x)) : prev));
      setToast(`已清除「${res.data.name}」的 GW 平台密钥`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function removePlatform(p: PlatformItem) {
    if (!window.confirm(`彻底删除 Provider「${p.name}」？删除后它的地址与密钥都不再保留。`)) return;
    setBusyId(p.id);
    setToast(null);
    const res = await deletePlatform(p.id);
    setBusyId(null);
    if (res.success) {
      setItems((prev) => (prev ? prev.filter((x) => x.id !== p.id) : prev));
      setTestResult((prev) => {
        const next = { ...prev };
        delete next[p.id];
        return next;
      });
      setToast(`已删除 Provider「${p.name}」`);
    } else {
      // 后端拒绝时消息里已经写清「被谁引用、还剩几个」，原样透出即可
      setToast(res.error?.message || '删除失败');
    }
  }

  async function applyBulkApiKey() {
    const apiKey = bulkKeyValue.trim();
    if (!apiKey) {
      setToast('apiKey 不能为空');
      return;
    }
    if (!bulkConfirm) {
      setToast('请先勾选确认范围');
      return;
    }
    const scope = bulkOnlyMissing ? '缺失密钥的 GW 平台' : '全部 GW 平台';
    if (!window.confirm(`批量更新${scope}密钥？`)) return;
    setBusyId('bulk-platform-api-key');
    setToast(null);
    const res = await bulkRotateApiKeys({
      objectType: 'platform',
      apiKey,
      onlyMissing: bulkOnlyMissing,
      allGwOwned: true,
    });
    setBusyId(null);
    if (res.success) {
      setItems((prev) => (prev ? prev.map((p) => (
        p.authority === 'llm_gateway' && (!bulkOnlyMissing || !p.hasKey) ? { ...p, hasKey: true } : p
      )) : prev));
      setBulkKeyValue('');
      setBulkConfirm(false);
      setToast(`批量轮换完成：匹配 ${res.data.matchedCount}，更新 ${res.data.modifiedCount}，跳过 ${res.data.skippedCount}`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  if (error) return <Empty text={error} />;
  if (!items) return <SectionLoader text="正在加载平台…" />;

  const th = TABLE_HEAD_CELL;
  const td = TABLE_CELL;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <header className="lg-page-heading">
        <div style={{ maxWidth: 720 }}>
          <h1>Provider（模型供应方）</h1>
          <p>
            选平台、填密钥即可接入；这里存的是供应方密钥，不是业务应用用的 <code>gwk_</code> 接入密钥。
          </p>
          <div style={{ marginTop: 6, ...HINT_TEXT }}>
            fal.ai 等原生接口不走这里，图片分层请到 <Link className="lg-text-link" to="/exchanges#image-layering">Exchange 一键接入</Link>。
          </div>
        </div>
        {canWrite ? <Button variant="primary" size="sm" onClick={() => setShowCreate((value) => !value)}>
          {showCreate ? '收起配置' : '添加 Provider'}
        </Button> : null}
      </header>
      {showCreate && canWrite ? (
        <section style={createCardStyle}>
          {/* 第一步：选平台。地址、协议、并发都由预设带出来，用户不必去搜供应商文档。 */}
          <ProviderPresetPicker presets={presets} selectedKey={preset?.key ?? null} onSelect={applyPreset} />

          <form onSubmit={submitCreate} style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
            {/* 第二步：填密钥。这是唯一一个系统无从得知、必须由用户提供的字段。 */}
            <label style={{ ...fieldStyle, maxWidth: 520 }}>
              <span style={labelStyle}>
                {preset ? `${preset.name} 的通讯密钥` : 'Provider 通讯密钥'}
                {preset?.keyConsoleUrl ? (
                  <a href={preset.keyConsoleUrl} target="_blank" rel="noreferrer noopener" style={keyLinkStyle}>去这里领密钥</a>
                ) : null}
              </span>
              <input
                required={!preset || preset.keyConsoleUrl !== ''}
                type="password"
                autoComplete="new-password"
                value={draft.apiKey}
                onChange={(e) => setDraft((value) => ({ ...value, apiKey: e.target.value }))}
                placeholder={preset?.keyPrefixHint ? `以 ${preset.keyPrefixHint} 开头` : '只保存加密结果，不会回显'}
                style={formInputStyle}
              />
            </label>
            {preset?.keylessPlaceholder ? (
              <InlineAlert tone="info">
                这个上游不校验密钥，已替你填好占位值「{preset.keylessPlaceholder}」，直接保存即可；
                自建服务真开了 --api-key 就改成真密钥。
              </InlineAlert>
            ) : null}
            {keyPrefixWarning(preset, draft.apiKey) ? (
              <InlineAlert tone="info">{keyPrefixWarning(preset, draft.apiKey)}</InlineAlert>
            ) : null}

            {/* 其余字段都有正确默认值，收进高级区；用户想改 baseUrl 也在这里改。 */}
            <details open={!preset}>
              <summary style={advancedSummaryStyle}>
                高级：名称、API 地址、并发{preset ? `（已按「${preset.name}」填好，通常不用动）` : '（自定义上游必须填地址）'}
              </summary>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10, marginTop: 10 }}>
                <label style={fieldStyle}>
                  <span style={labelStyle}>名称</span>
                  <input required value={draft.name} onChange={(e) => setDraft((value) => ({ ...value, name: e.target.value }))} placeholder="例如：教程假上游" style={formInputStyle} />
                </label>
                <label style={fieldStyle}>
                  <span style={labelStyle}>接口类型</span>
                  <select value={draft.platformType} onChange={(e) => setDraft((value) => ({ ...value, platformType: e.target.value as CreatePlatformRequest['platformType'] }))} style={formInputStyle}>
                    <option value="openai">OpenAI 兼容</option>
                    <option value="claude">Claude 兼容</option>
                  </select>
                </label>
                <label style={{ ...fieldStyle, gridColumn: '1 / -1' }}>
                  <span style={labelStyle}>API 地址</span>
                  <input required type="url" value={draft.apiUrl} onChange={(e) => setDraft((value) => ({ ...value, apiUrl: e.target.value }))} placeholder="https://provider.example.com/v1" style={formInputStyle} />
                </label>
                <label style={fieldStyle}>
                  <span style={labelStyle}>最大并发</span>
                  <input required type="number" min={1} max={10000} value={draft.maxConcurrency ?? 20} onChange={(e) => setDraft((value) => ({ ...value, maxConcurrency: Number(e.target.value) }))} style={formInputStyle} />
                </label>
                <label style={fieldStyle}>
                  <span style={labelStyle}>供应方标识（可选）</span>
                  <input value={draft.providerId || ''} onChange={(e) => setDraft((value) => ({ ...value, providerId: e.target.value }))} placeholder="用于费用或日志归类" style={formInputStyle} />
                </label>
                <label style={fieldStyle}>
                  <span style={labelStyle}>备注（可选）</span>
                  <input value={draft.remark || ''} onChange={(e) => setDraft((value) => ({ ...value, remark: e.target.value }))} placeholder="例如：仅供教程测试" style={formInputStyle} />
                </label>
              </div>
            </details>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Button type="submit" variant="primary" size="sm" disabled={createBusy}>{createBusy ? '保存中…' : '保存并测试连接'}</Button>
              <span style={HINT_TEXT}>保存后自动测连接，通了直接列出上游模型。</span>
            </div>
          </form>
        </section>
      ) : null}
      {!canWrite ? <ReadOnlyNotice /> : null}
      {toast ? (
        <div style={{ flexShrink: 0, fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>{toast}</div>
      ) : null}
      {/* 自测结果与模型清单挂在表格上方：接完之后「通没通、上游有什么」必须看得见。 */}
      {Object.entries(testResult).map(([platformId, result]) => {
        const owner = items.find((x) => x.id === platformId);
        return (
          <div key={platformId} style={{ flexShrink: 0 }}>
            <div style={{ ...HINT_TEXT, marginBottom: 4 }}>{owner?.name || platformId} 的连接测试</div>
            <TestResultBar result={result} />
          </div>
        );
      })}
      {discovery ? (
        <section style={{ ...createCardStyle, flexShrink: 0 }}>
          <div style={{ marginBottom: 10, fontWeight: 600 }}>
            {items.find((x) => x.id === discovery.platformId)?.name || discovery.platformId} 的上游模型
          </div>
          <UpstreamModelPicker
            data={discovery.data}
            busy={busyId === discovery.platformId}
            onImport={(selected) => void runImport(discovery.platformId, selected)}
            onCancel={() => setDiscovery(null)}
          />
        </section>
      ) : null}
      {items.length > 0 && canWrite ? (
        <details style={{ flexShrink: 0 }}>
          <summary style={{ cursor: 'pointer', fontSize: 'var(--fs-secondary)', color: 'var(--text-secondary)', padding: '6px 2px' }}>高级：批量轮换已有 Provider 密钥</summary>
          <div style={toolbarStyle}>
            <span style={toolbarTitleStyle}>批量维护 Provider 密钥</span>
            <input type="password" autoComplete="new-password" value={bulkKeyValue} onChange={(e) => setBulkKeyValue(e.target.value)} placeholder="新 apiKey" style={inputStyle} />
            <label style={checkStyle}><input type="checkbox" checked={bulkOnlyMissing} onChange={(e) => setBulkOnlyMissing(e.target.checked)} />只补缺失</label>
            <label style={checkStyle}><input type="checkbox" checked={bulkConfirm} onChange={(e) => setBulkConfirm(e.target.checked)} />确认应用到当前 Provider</label>
            <Button size="sm" variant="ghost" disabled={busyId === 'bulk-platform-api-key'} onClick={() => void applyBulkApiKey()}>
              {busyId === 'bulk-platform-api-key' ? '处理中…' : '批量轮换密钥'}
            </Button>
          </div>
        </details>
      ) : null}
      {items.length === 0 ? (
        <Empty text={canWrite ? '还没有 Provider。请填写上方 4 个必填项，保存后再去添加第一个模型。' : '当前租户还没有 Provider。请联系 Owner 或 Admin 添加。'} />
      ) : (
      <div className="lg-config-table-shell" style={{ flex: 1, minHeight: 160, overflow: 'auto', overscrollBehavior: 'contain', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)' }}>
        <table className="lg-data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-surface)' }}>
            <tr>
              <th style={th}>平台</th>
              <th style={th}>类型</th>
              <th style={th}>API URL</th>
              <th style={th}>并发</th>
              <th style={th}>配置来源</th>
              <th style={th}>状态</th>
              <th style={th}>密钥</th>
              <th style={th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => {
              const en = boolChip(p.enabled, '启用', '停用');
              const key = boolChip(p.hasKey, '已配置', '未配置');
              return (
                <tr key={p.id}>
                  <td style={td}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 150 }}>
                      <span style={{ fontWeight: 600 }}>{p.name}</span>
                      <EntityPreviewDrawer
                        buttonLabel="查看接口"
                        kicker="Provider 接口预览"
                        title={p.name}
                        summary="确认网关把请求发往哪里、用哪种协议、是否已有密钥。预览不访问供应方。"
                        status={[
                          { label: p.enabled ? '已启用' : '已停用', tone: p.enabled ? 'good' : 'warning' },
                          { label: p.hasKey ? '通讯密钥已配置' : '通讯密钥缺失', tone: p.hasKey ? 'good' : 'warning' },
                        ]}
                        sections={[
                          {
                            title: '连接方式',
                            fields: [
                              { label: '接口类型', value: platformTypeLabel(p.platformType) },
                              { label: 'API 地址', value: <code>{p.apiUrl || '未配置'}</code>, hint: '这是供应方地址，不是业务应用调用 Gateway 的地址。' },
                              { label: '供应方标识', value: p.providerId || '未单独设置' },
                              { label: '最大并发', value: p.maxConcurrency ?? '未配置' },
                            ],
                          },
                          {
                            title: '平台归属',
                            description: '配置来源决定这条 Provider 是否可在当前控制台直接维护。',
                            fields: [
                              { label: '配置来源', value: p.authority === 'llm_gateway' ? 'Gateway 权威配置' : '旧 MAP 配置，需先导入' },
                              { label: '备注', value: p.remark || '无备注' },
                              { label: '最近更新', value: formatPlatformTime(p.updatedAt) },
                            ],
                          },
                        ]}
                      />
                    </div>
                  </td>
                  <td style={td}>{p.platformType || '—'}</td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.apiUrl || ''}>{p.apiUrl || '—'}</td>
                  <td style={td}>{p.maxConcurrency || '—'}</td>
                  <td style={td}>
                    {p.authority === 'llm_gateway' ? (
                      <Chip label="平台配置" color="#7aa2ff" bg="rgba(122,162,255,0.14)" title={p.claimedAt ? `导入于 ${p.claimedAt}` : undefined} />
                    ) : (
                      <Chip label="待导入" color="var(--text-muted)" bg="var(--bg-elevated)" />
                    )}
                  </td>
                  <td style={td}><Chip label={en.label} color={en.color} bg={en.bg} /></td>
                  <td style={td}><Chip label={key.label} color={key.color} bg={key.bg} /></td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {canWrite ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      {keyEditId === p.id ? (
                        <>
                          <input
                            type="password"
                            autoComplete="new-password"
                            value={keyValue}
                            onChange={(e) => setKeyValue(e.target.value)}
                            placeholder="apiKey"
                            style={inputStyle}
                          />
                          <Button size="sm" variant="primary" disabled={busyId === p.id} onClick={() => void saveApiKey(p)}>
                            保存
                          </Button>
                          <Button size="sm" variant="ghost" disabled={busyId === p.id} onClick={() => { setKeyEditId(null); setKeyValue(''); }}>
                            取消
                          </Button>
                        </>
                      ) : (
                        <>
                          {p.authority === 'llm_gateway' ? (
                            <>
                              {/* 加了密钥之后必须能当场验证、能看到上游有什么模型，
                                  否则用户只知道「存下了」，不知道「对不对、下一步干嘛」。 */}
                              <Button size="sm" variant="ghost" disabled={busyId === p.id || !p.hasKey} onClick={() => void runTest(p)} title={p.hasKey ? '用已保存的密钥打一次上游' : '先配置密钥'}>
                                测试连接
                              </Button>
                              <Button size="sm" variant="ghost" disabled={busyId === p.id || !p.hasKey || p.platformType === 'claude'} onClick={() => void openDiscovery(p)} title={p.platformType === 'claude' ? 'Claude 原生协议没有模型列表接口' : '从上游拉取模型清单并勾选导入'}>
                                查看模型
                              </Button>
                              <Button size="sm" variant="ghost" disabled={busyId === p.id} onClick={() => { setKeyEditId(p.id); setKeyValue(''); }}>
                                更新密钥
                              </Button>
                              {p.hasKey ? (
                                <Button size="sm" variant="ghost" disabled={busyId === p.id} onClick={() => void clearApiKey(p)}>
                                  清除密钥
                                </Button>
                              ) : null}
                              {/* 接错的上游、试完的测试 Provider 得能真删掉，不然共享库里越积越多。
                                  后端有引用就拒绝并说清被谁引用，这里不做二次判断，只负责问一句。 */}
                              <Button size="sm" variant="ghost" disabled={busyId === p.id} onClick={() => void removePlatform(p)} title="从网关配置里彻底删除这个 Provider">
                                删除
                              </Button>
                            </>
                          ) : (
                            <Button size="sm" variant="ghost" disabled={busyId === p.id} onClick={() => void claimPlatform(p)}>
                              {busyId === p.id ? '处理中…' : '导入到平台'}
                            </Button>
                          )}
                          <Button size="sm" variant={p.enabled ? 'ghost' : 'primary'} disabled={busyId === p.id} onClick={() => void toggle(p)}>
                            {busyId === p.id ? '处理中…' : p.enabled ? '停用' : '启用'}
                          </Button>
                        </>
                      )}
                    </span> : <span style={{ color: 'var(--text-muted)' }}>只读</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = { ...TOOLBAR_CONTROL, flex: '1 1 190px' };

const toolbarStyle: React.CSSProperties = {
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  padding: '8px 10px',
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius)',
};

const toolbarTitleStyle: React.CSSProperties = {
  fontSize: 'var(--fs-secondary)',
  fontWeight: 600,
  color: 'var(--text-secondary)',
};

const checkStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 'var(--fs-secondary)',
  color: 'var(--text-secondary)',
};


const keyLinkStyle: React.CSSProperties = {
  marginLeft: 8,
  fontSize: 'var(--fs-caption)',
  fontWeight: 400,
  color: 'var(--accent-primary)',
};

const advancedSummaryStyle: React.CSSProperties = {
  cursor: 'pointer',
  fontSize: 'var(--fs-secondary)',
  color: 'var(--text-secondary)',
  padding: '4px 2px',
};

const createCardStyle: React.CSSProperties = {
  flexShrink: 0,
  padding: 14,
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius)',
};

const fieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  minWidth: 0,
};

const labelStyle: React.CSSProperties = FIELD_LABEL;

const formInputStyle: React.CSSProperties = FIELD_INPUT;

function Empty({ text }: { text: string }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 'var(--fs-secondary)' }}>
      {text}
    </div>
  );
}

function platformTypeLabel(value: string) {
  return ({ openai: 'OpenAI 兼容', claude: 'Claude 兼容' } as Record<string, string>)[value] || value || '未配置';
}

function formatPlatformTime(value?: string | null) {
  if (!value) return '暂无记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
