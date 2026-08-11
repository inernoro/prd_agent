// Provider（模型供应方）：先完成单个 Provider 的可理解自助配置，再把批量维护收进高级区。
// 密钥明文只随创建/轮换请求发送，永不回显；列表最多展示头尾打码的指纹（keyFingerprint），
// 用来分辨同名同 URL 的两条上游是哪一把——指纹仅在具备 config:write 时由服务端下发。
import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { bulkRotateApiKeys, claimPlatformToGateway, createPlatform, deletePlatform, deletePlatformApiKey, getPlatforms, mergePlatformInto, rotatePlatformApiKey, setPlatformEnabled, updatePlatform } from '@/lib/api';
import type { CreatePlatformRequest, PlatformItem, UpdatePlatformRequest } from '@/lib/types';
import { Chip, SectionLoader, Button, ReadOnlyNotice } from '@/components/ui';
import { EntityPreviewDrawer } from '@/components/EntityPreviewDrawer';
import { boolChip } from '@/components/poolsHelpers';
import { useDialogs } from '@/components/ConfirmDialog';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';
import { FIELD_INPUT, FIELD_LABEL, HINT_TEXT, TABLE_CELL, TABLE_HEAD_CELL, TOOLBAR_CONTROL } from '@/lib/typography';

export function PlatformsPage() {
  const { tenant } = useAuth();
  const canWrite = canUseCapability(tenant?.role, 'configWrite');
  const { confirm, promptText } = useDialogs();
  const [items, setItems] = useState<PlatformItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [keyEditId, setKeyEditId] = useState<string | null>(null);
  // 行内编辑：只在展开的那一行生效，避免整页进「编辑模式」
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<UpdatePlatformRequest>({});
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
    return () => {
      alive = false;
    };
  }, []);

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
    setShowCreate(false);
    setToast(`Provider「${res.data.name}」已保存，通讯密钥已加密，可继续添加模型`);
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
    if (!await confirm({ title: `清除「${p.name}」的 GW 平台密钥？`, description: '清除后这条上游会退回「未配置密钥」，用它的模型将无法调用。', tone: 'danger', confirmLabel: '清除密钥' })) return;
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

  function beginEdit(p: PlatformItem) {
    setEditId(p.id);
    setKeyEditId(null);
    setEditDraft({
      name: p.name,
      // 原样带上，不要 || 'openai' 兜底：认领自 MAP 的上游可能是 openrouter / google
      // 这类存量类型，兜底成 openai 等于在用户没点过类型选择器的情况下悄悄给它改了协议。
      platformType: p.platformType || '',
      apiUrl: p.apiUrl || '',
      maxConcurrency: p.maxConcurrency,
      remark: p.remark || '',
    });
  }

  async function saveEdit(p: PlatformItem) {
    setBusyId(p.id);
    setToast(null);
    // 类型没改就不提交这个字段：更新端点只收 openai / claude，而存量类型（openrouter / google 等）
    // 原样回传会被 INVALID_INPUT 挡下——用户只想改个名字，却被要求先把上游重新分类。
    // 端点把 null 当「这个字段不改」，所以省掉即可。
    const typeChanged = (editDraft.platformType ?? '') !== (p.platformType || '');
    const res = await updatePlatform(p.id, {
      ...editDraft,
      platformType: typeChanged ? editDraft.platformType : undefined,
    });
    setBusyId(null);
    if (res.success) {
      setItems((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? res.data : x)) : prev));
      setEditId(null);
      setToast(`已保存「${res.data.name}」`);
    } else {
      setToast(res.error?.message || '保存失败');
    }
  }

  /**
   * 合并上游：把源名下的模型与池成员改嫁给目标，然后删掉源。
   *
   * 为「两条同名同址、只有密钥不同」这种局面准备的——手工一个个改绑再删，
   * 中间漏一步就留下指向已删平台的池成员，看起来正常、实际解析不到。
   */
  async function mergeInto(source: PlatformItem) {
    // 接口类型不同的不列为候选：没写 Protocol 的模型继承所属上游的类型，
    // 合过去等于把它们的报文协议换掉。服务端也会拒（PLATFORM_TYPE_MISMATCH），
    // 但让用户先选了再被拒是白走一趟——不该出现在选项里。
    const candidates = (items || []).filter((x) => (
      x.id !== source.id
      && x.authority === 'llm_gateway'
      && (x.platformType ?? '') === (source.platformType ?? '')
    ));
    if (candidates.length === 0) {
      setToast(`没有可合并的目标上游（只能并入接口类型同为 ${source.platformType || '未设置'} 的上游）`);
      return;
    }
    const listed = candidates.map((x, i) => `${i + 1}. ${x.name}（${x.apiUrl || '无地址'}）`).join('\n');
    const picked = await promptText({
      title: `把「${source.name}」并入哪一条？`,
      description: `它名下的模型与池成员会改指到目标，重复的会被去重，随后源上游被删除。\n\n${listed}`,
      inputLabel: '输入目标序号',
      placeholder: '1',
      confirmLabel: '下一步',
    });
    if (picked === null) return;
    const index = Number(picked.trim()) - 1;
    const target = candidates[index];
    if (!target) {
      setToast('序号无效，已取消合并');
      return;
    }
    if (!await confirm({ title: `确认把「${source.name}」并入「${target.name}」？`, description: '源上游会被删除，无法撤销。', tone: 'danger', confirmLabel: '合并' })) return;
    setBusyId(source.id);
    setToast(null);
    const res = await mergePlatformInto(source.id, target.id);
    setBusyId(null);
    if (!res.success) {
      setToast(res.error?.message || '合并失败');
      return;
    }
    const r = res.data;
    const reload = await getPlatforms();
    if (reload.success) setItems(reload.data.items);
    setToast(
      `已并入「${target.name}」：模型改嫁 ${r.modelsMoved}、去重 ${r.modelsDropped}，`
      + `池成员改指 ${r.poolMembersRepointed}、去重 ${r.poolMembersDeduped}，`
      + `逻辑模型 offering 改指 ${r.offeringsRepointed}、去重 ${r.offeringsDeduped}`
      + (r.sourceDeleted ? '，源上游已删除' : '，源上游仍有残留引用未删除'),
    );
  }

  /**
   * 删除整条上游。
   *
   * 两道闸：确认框要求敲平台名（删错一条正在服务的上游，代价是整条链路静默失联，
   * 而池成员按 (modelId, platformId) 定位、平台没了它们仍在，看起来正常、实际解析不到）；
   * 服务端再查一次引用，被占用就带清单拒绝——这里把清单原样端给用户，让他知道先摘哪几个。
   */
  async function removePlatform(p: PlatformItem) {
    const typed = await promptText({
      title: `删除上游「${p.name}」`,
      description: `${p.apiUrl || '无地址'}\n删除后这条上游的地址与密钥一并消失，无法撤销。`,
      inputLabel: '确认请输入平台名',
      requireExact: p.name,
      tone: 'danger',
      confirmLabel: '删除',
    });
    if (typed === null) return;
    if (typed.trim() !== p.name) {
      setToast('输入的平台名不一致，已取消删除');
      return;
    }
    setBusyId(p.id);
    setToast(null);
    const res = await deletePlatform(p.id);
    setBusyId(null);
    if (res.success) {
      setItems((prev) => (prev ? prev.filter((x) => x.id !== p.id) : prev));
      setToast(`已删除上游「${p.name}」`);
      return;
    }
    setToast(res.error?.message || '删除失败');
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
    if (!await confirm({ title: `批量更新${scope}密钥？`, description: '这会覆盖范围内每一条的现有密钥。', tone: 'danger', confirmLabel: '批量更新' })) return;
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
            Provider 告诉网关“去哪里调用模型”。这里保存的是供应方地址和供应方通讯密钥；它不是给业务应用使用的 <code>gwk_</code> 接入密钥。
          </p>
          <div style={{ marginTop: 6, ...HINT_TEXT }}>
            第一步添加 Provider，第二步到“模型管理”添加具体模型，第三步再生成应用接入 key。
          </div>
          <div style={{ marginTop: 6, ...HINT_TEXT }}>
            fal.ai 等原生接口不属于 OpenAI 或 Claude Provider。图片分层请到 <Link className="lg-text-link" to="/exchanges#image-layering">Exchange 一键接入</Link>。
          </div>
        </div>
        {canWrite ? <Button variant="primary" size="sm" onClick={() => setShowCreate((value) => !value)}>
          {showCreate ? '收起配置' : '添加 Provider'}
        </Button> : null}
      </header>
      {showCreate && canWrite ? (
        <section style={createCardStyle}>
          <form onSubmit={submitCreate} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10 }}>
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
              <span style={labelStyle}>Provider 通讯密钥</span>
              <input required type="password" autoComplete="new-password" value={draft.apiKey} onChange={(e) => setDraft((value) => ({ ...value, apiKey: e.target.value }))} placeholder="必填，只保存加密结果" style={formInputStyle} />
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
            <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 10 }}>
              <Button type="submit" variant="primary" size="sm" disabled={createBusy}>{createBusy ? '保存中…' : '保存并继续添加模型'}</Button>
              <span style={HINT_TEXT}>保存后列表只显示“已配置”，不会回显密钥。</span>
            </div>
          </form>
        </section>
      ) : null}
      {!canWrite ? <ReadOnlyNotice /> : null}
      {toast ? (
        <div style={{ flexShrink: 0, fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>{toast}</div>
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
              // 密文在库但解不开（多半轮换过 ApiKeyCrypto:Secret）不能显示成「已配置」——
              // 那会让人以为这条上游能用，实际每次调用都会失败
              const key = p.keyStatus === 'unreadable'
                ? { label: '解不开', color: 'var(--semantic-warning-text, #b45309)', bg: 'rgba(180,83,9,0.14)' }
                : boolChip(p.hasKey, '已配置', '未配置');
              return (
                // 一行可能渲染两个兄弟节点（数据行 + 展开的编辑行），列表里的 Fragment 必须带 key
                <Fragment key={p.id}>
                <tr>
                  <td style={td}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 150 }}>
                      <span style={{ fontWeight: 600 }}>{p.name}</span>
                      <EntityPreviewDrawer
                        buttonLabel="查看接口"
                        kicker="Provider 接口预览"
                        title={p.name}
                        summary="确认网关把请求发往哪里、用哪种协议、这条上游有没有密钥。预览不访问供应方。"
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
                  <td style={td}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                      <Chip label={key.label} color={key.color} bg={key.bg} />
                      {/* 指纹：同名同 URL 的两条上游只有密钥不同时，这是唯一能分清谁是谁的线索 */}
                      {p.keyFingerprint ? (
                        <code
                          style={{ fontSize: 'var(--fs-tertiary)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}
                          title="密钥指纹（头尾各留几位，中间打码），用于分辨是哪一把，不是完整密钥">
                          {p.keyFingerprint}
                        </code>
                      ) : null}
                    </div>
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {canWrite ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
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
                              <Button size="sm" variant="ghost" disabled={busyId === p.id} onClick={() => { setKeyEditId(p.id); setKeyValue(''); }}>
                                更新密钥
                              </Button>
                              {p.hasKey ? (
                                <Button size="sm" variant="ghost" disabled={busyId === p.id} onClick={() => void clearApiKey(p)}>
                                  清除密钥
                                </Button>
                              ) : null}
                            </>
                          ) : (
                            <Button size="sm" variant="ghost" disabled={busyId === p.id} onClick={() => void claimPlatform(p)}>
                              {busyId === p.id ? '处理中…' : '导入到平台'}
                            </Button>
                          )}
                          {p.authority === 'llm_gateway' ? (
                            <Button size="sm" variant="ghost" disabled={busyId === p.id} onClick={() => beginEdit(p)}>
                              编辑
                            </Button>
                          ) : null}
                          <Button size="sm" variant={p.enabled ? 'ghost' : 'primary'} disabled={busyId === p.id} onClick={() => void toggle(p)}>
                            {busyId === p.id ? '处理中…' : p.enabled ? '停用' : '启用'}
                          </Button>
                          {/* 这条上游到底有没有在被调、报什么错——不看日志答不上来 */}
                          <Link
                            className="lg-secondary-action"
                            style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}
                            to={`/logs?platformId=${encodeURIComponent(p.id)}`}>
                            查看日志
                          </Link>
                          {p.authority === 'llm_gateway' ? (
                            <>
                              <Button size="sm" variant="ghost" disabled={busyId === p.id} onClick={() => void mergeInto(p)}>
                                合并到…
                              </Button>
                              <Button size="sm" variant="ghost" disabled={busyId === p.id} onClick={() => void removePlatform(p)}>
                                删除
                              </Button>
                            </>
                          ) : null}
                        </>
                      )}
                    </span> : <span style={{ color: 'var(--text-muted)' }}>只读</span>}
                  </td>
                </tr>
                {editId === p.id ? (
                  <tr>
                    {/* 编辑表单占满整行：塞进窄窄的操作列会把指纹和按钮一起挤到换行 */}
                    <td style={{ ...td, background: 'var(--bg-elevated)' }} colSpan={8}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ ...HINT_TEXT, marginRight: 4 }}>编辑上游</span>
                          <input
                            aria-label="平台名称"
                            value={editDraft.name ?? ''}
                            onChange={(e) => setEditDraft((v) => ({ ...v, name: e.target.value }))}
                            placeholder="名称"
                            style={{ ...inputStyle, width: 150 }}
                          />
                          <select
                            aria-label="接口类型"
                            value={editDraft.platformType ?? ''}
                            onChange={(e) => setEditDraft((v) => ({ ...v, platformType: e.target.value }))}
                            style={inputStyle}>
                            {/* 存量类型（openrouter / google 等）先如实列出来，否则选择器显示为空，
                                用户看不出这条上游现在到底是什么类型，随手一点就把协议改了。 */}
                            {editDraft.platformType
                              && !['openai', 'claude'].includes(editDraft.platformType) ? (
                                <option value={editDraft.platformType}>
                                  {editDraft.platformType}（存量类型）
                                </option>
                              ) : null}
                            <option value="openai">openai</option>
                            <option value="claude">claude</option>
                          </select>
                          <input
                            aria-label="API 地址"
                            value={editDraft.apiUrl ?? ''}
                            onChange={(e) => setEditDraft((v) => ({ ...v, apiUrl: e.target.value }))}
                            placeholder="https://…"
                            style={{ ...inputStyle, width: 240 }}
                          />
                          <input
                            aria-label="并发"
                            type="number"
                            value={editDraft.maxConcurrency ?? 0}
                            onChange={(e) => setEditDraft((v) => ({ ...v, maxConcurrency: Number(e.target.value) }))}
                            style={{ ...inputStyle, width: 80 }}
                          />
                          <input
                            aria-label="备注"
                            value={editDraft.remark ?? ''}
                            onChange={(e) => setEditDraft((v) => ({ ...v, remark: e.target.value }))}
                            placeholder="备注"
                            style={{ ...inputStyle, width: 160 }}
                          />
                          <Button size="sm" variant="primary" disabled={busyId === p.id} onClick={() => void saveEdit(p)}>
                            保存
                          </Button>
                          <Button size="sm" variant="ghost" disabled={busyId === p.id} onClick={() => setEditId(null)}>
                            取消
                          </Button>
                      </div>
                    </td>
                  </tr>
                ) : null}
                </Fragment>
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
