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
import { useEffect, useRef, useState } from 'react';
import { PlugZap } from 'lucide-react';
import { getSystemSettings, saveSystemSettings, testSystemSettings } from '@/lib/api';
import type { SystemGatewaySettings, SystemGatewayTestResult } from '@/lib/types';
import { Button, Card, InlineAlert, SectionLoader, Spinner } from '@/components/ui';
import { PageBody, PageHeader, PageShell, DetailsBlock } from '@/components/PageShell';
import './GatewaySettingsPage.css';
import { GAP } from '@/lib/surface';
import { FIELD_LABEL, HINT_TEXT, MONO_META, SECTION_TITLE } from '@/lib/typography';

type ModelSource = 'auto' | 'pool' | 'model';

const SOURCES: Array<{ id: ModelSource; label: string; hint: string }> = [
  { id: 'auto', label: '自动选择', hint: '使用默认公开模型，线路按模型配置调度' },
  { id: 'model', label: '指定公开模型', hint: '固定公开模型标识，具体线路和升级仍按模型配置调度' },
];

const CREDENTIAL_TEXT: Record<SystemGatewaySettings['credentialState'], string> = {
  ready: '服务端已签发',
  'will-issue': '还没签过，首次调用时自动签发',
  'will-reissue': '旧的已失效，下次调用自动重签',
};

// 这一次测试正走到哪一步：后端是「确保凭据 → 真发一次极短对话」，单轮最长 40 秒，
// 凭据类失败还会自动重签重试一轮。等待期只挂一个不动的「正在测试」是体验缺陷
// （AGENTS.md 规则 #6），所以按已等的秒数说清此刻在做什么、大概还要多久。
function testingStage(seconds: number): string {
  if (seconds < 5) return '正在确认系统密钥，然后真发一次极短对话。';
  if (seconds < 15) return '请求已发出，正在等模型回第一个字。一般十几秒内就有结果。';
  if (seconds < 40) return '比平时慢：单轮最长等 40 秒，超时会如实报失败，不会一直转下去。';
  return '首轮疑似凭据问题，正在自动重签一把密钥再试一次——这是最后一轮。';
}

export function GatewaySettingsPage() {
  const [data, setData] = useState<SystemGatewaySettings | null>(null);
  const [source, setSource] = useState<ModelSource>('auto');
  const [poolId, setPoolId] = useState('');
  const [modelName, setModelName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saveUncertain, setSaveUncertain] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  // 测试模型调用的代次：任何一次改选择 / 保存都作废上一次的结论，它的回写一律丢弃。
  const testSeq = useRef(0);
  const [testElapsed, setTestElapsed] = useState(0);
  const [testResult, setTestResult] = useState<SystemGatewayTestResult | null>(null);
  const testTimer = useRef<number | null>(null);
  /*
    逻辑模型清单的筛选关键字。

    清单单次只回前 200 条：不给筛选的话，排在 200 名之后的模型在这一页等于不存在——
    页面不报错，下拉里就是没有它，用户只会以为系统不支持那个模型。
    它只换清单，不改配置，所以**不作废测试结论**（改的不是「系统按什么走」）。
  */
  const [modelQuery, setModelQuery] = useState('');
  /** 读回配置的代次：只有最新那一条读允许写回 data / 选择框，先发后回的一律丢弃。 */
  const loadSeq = useRef(0);

  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(null), 5000); return () => window.clearTimeout(timer); }, [notice]);

  // 计时器只跟着 testing 起落，组件卸载也要清掉——否则在测试途中离开这一页会留下
  // 一个还在滴答的 setInterval。
  useEffect(() => {
    if (!testing) {
      if (testTimer.current !== null) { window.clearInterval(testTimer.current); testTimer.current = null; }
      return;
    }
    const startedAt = Date.now();
    setTestElapsed(0);
    testTimer.current = window.setInterval(() => {
      setTestElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => {
      if (testTimer.current !== null) { window.clearInterval(testTimer.current); testTimer.current = null; }
    };
  }, [testing]);

  /**
   * 读回服务端那份配置。
   *
   * `applySelection=false` 时只刷新 `data`（也就是「服务端现在存的是什么」），
   * 不动三个选择框——保存期间用户又改了选择时要的就是这个：既让 `dirty` 如实
   * 显示「你手上这份还没保存」，又不把他刚改的选择悄悄抹回服务端那份。
   */
  const load = async (applySelection = true, query = modelQuery, reconcile = false) => {
    /*
      读回也要按代次丢弃，理由和写入侧一样：连着敲几个关键字就有几条读在路上，
      先发的那条**后回来**就会把清单盖成上一个关键字的结果——搜索框里写着 B、
      下拉里装着 A 的模型。保存前发出的那条同理：它回来时带的是保存前那份配置，
      盖到 data 上会让刚存好的配置显示成「未保存」，连「测试模型调用」都跟着被禁用。
    */
    const loadId = ++loadSeq.current;
    const res = await getSystemSettings(query).catch(() => ({ success: false as const, data: null, error: { code: 'NETWORK_ERROR', message: '配置读取失败' } }));
    if (loadSeq.current !== loadId) return;
    if (!res.success) { setError(res.error?.message || '加载失败'); return; }
    setData(res.data);
    if (reconcile) { setSaveUncertain(false); setError(null); }
    if (!applySelection) return;
    setSource(res.data.modelSource);
    setPoolId(res.data.modelGroupId ?? res.data.pools.find((p) => p.isDefault)?.id ?? '');
    setModelName(res.data.modelName ?? '');
  };
  useEffect(() => { void load(); }, []);

  // 关键字改了就换一份清单，但不回填选择框——用户正在挑的那个不能被重新读回来的值顶掉。
  useEffect(() => {
    if (!data) return;
    const timer = window.setTimeout(() => { void load(false, modelQuery); }, 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelQuery]);

  /**
   * 作废上一次「测试模型调用」的结论。
   *
   * 那条绿色结果是**照当时那份配置**跑出来的。改了来源/池/模型还留着它，页面就变成
   * 「配置 B + 来自配置 A 的证明」——而这一页存在的理由正是让人当场确认这份配置能用。
   * 保存之后同样要作废：保存换的是「系统下一次调用按什么走」，旧结论证明不了新的那份。
   * 顺带把在途那次也顶掉（按代次丢弃回写）：不然它回来时会盖到新选择上。
   */
  const invalidateTestResult = () => {
    testSeq.current += 1;
    setTestResult(null);
    /*
      忙态也要一起收掉。

      上一版只顶代次不收忙态，于是作废之后那条请求回来时被代次挡在门外，
      `setTesting(false)` 永远执行不到——计时器跟着 `testing` 跑，按钮就一直停在
      「正在测试 N s」且禁用，只有刷新页面才能恢复。**我上一轮亲手造的**：
      加代次判据时只想着「别让旧结论写回去」，没想过「那条路径上还挂着收尾动作」。
      被代次挡掉的分支里如果还有别人依赖的收尾，那条收尾就得挪到挡不住的地方。
    */
    setTesting(false);
  };

  /**
   * 三处选择的唯一出口：记一次「用户动过手」，改值，作废旧结论。
   *
   * 记这一次的理由在 save 里：保存期间控件仍可编辑（该保留——保存是个快请求，
   * 为它锁住整屏不值当），而保存收尾会读回服务端那份并回填选择框。
   * 不记代次的话，用户在这一小段里改的选择会被读回来的旧值**静默覆盖**，
   * 且 `dirty` 随之归零——屏幕上显示的是他没选的那个，还告诉他「已保存」。
   */
  const selectionSeq = useRef(0);
  const changeSelection = (apply: () => void) => {
    selectionSeq.current += 1;
    apply();
    invalidateTestResult();
  };

  const save = async () => {
    if (saveUncertain || saving) return;
    const selectionAtStart = selectionSeq.current;
    setSaving(true); setError(null); setNotice(null);
    let res: Awaited<ReturnType<typeof saveSystemSettings>>;
    try {
      res = await saveSystemSettings({ modelSource: source, modelGroupId: source === 'pool' ? poolId : undefined, modelName: source === 'model' ? modelName : undefined });
    } catch { res = { success: false, data: null, error: { code: 'NETWORK_ERROR', message: '保存响应读取中断' } }; }
    finally { setSaving(false); }
    if (!res.success) {
      if (!['INVALID_INPUT', 'INVALID_MODEL_SOURCE', 'MODEL_POOL_REQUIRED', 'MODEL_POOL_NOT_FOUND', 'MODEL_POOL_NOT_MIGRATED', 'MODEL_NAME_REQUIRED', 'MODEL_NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED'].includes(res.error.code)) {
        ++loadSeq.current; invalidateTestResult(); setSaveUncertain(true);
        setError('保存结果未确认，当前选择已保留。请重新读取配置核对，再保存或测试。');
      } else setError(res.error.message || '保存被拒绝');
      return;
    }
    invalidateTestResult();
    const editedDuringSave = selectionSeq.current !== selectionAtStart;
    setNotice(editedDuringSave
      ? '已保存提交时的选择；当前修改尚未保存。连接测试结论已清除。'
      : '已保存，后续系统调用将使用此配置。原连接测试结论已清除。');
    await load(!editedDuringSave, modelQuery, true);
  };

  // 保存完必须能当场验一次——否则「最小输入」就退化成蒙着眼睛少填几个字。
  const runTest = async () => {
    if (saveUncertain || testing) return;
    const runId = ++testSeq.current;
    setTesting(true); setError(null); setTestResult(null);
    try {
      const res = await testSystemSettings();
      // 请求在路上时用户可能已经改了选择或保存过——那时这条结论说的已经不是屏幕上这份配置了，
      // 原样写回去就是拿旧配置的成败给新配置背书。
      if (testSeq.current !== runId) return;
      if (!res.success) { setError(res.error?.message || '测试请求失败'); return; }
      setTestResult(res.data);
    } finally {
      // 收忙态放 finally，且只由**当前这一代**收：被顶掉的那条不许把新一轮的忙态关掉。
      if (testSeq.current === runId) setTesting(false);
    }
  };

  if (!data) {
    return (
      <PageShell className="lg-gateway-settings">
        <PageHeader title="服务网关设置" subtitle="选择网关内部功能使用的模型。" />
        <PageBody>{error ? <InlineAlert tone="error">{error} <Button variant="ghost" onClick={() => void load(true, modelQuery, true)}>重新读取配置</Button></InlineAlert> : <SectionLoader text="正在读取系统级配置" />}</PageBody>
      </PageShell>
    );
  }

  /*
    当前选中的那个必须始终在可选项里——哪怕它不在这次筛出来的清单里。
    少这一手，用户一筛关键字，选中的模型就从下拉里消失、控件显示空白，
    而 React 里那个值其实还在：屏幕说「没选模型」，保存下去的却是它。
  */
  const modelOptions = modelName && !data.models.some((m) => m.publicId === modelName)
    ? [{ id: `current:${modelName}`, publicId: modelName, name: `${modelName}（当前选择）` }, ...data.models]
    : data.models;

  const sourceOptions = data.modelSource === 'pool' || source === 'pool' ? [...SOURCES, { id: 'pool' as const, label: '现有模型池（兼容配置）', hint: '保留旧设置；新配置请使用公开模型' }] : SOURCES;

  const dirty = source !== data.modelSource
    || (source === 'pool' && poolId !== (data.modelGroupId ?? ''))
    || (source === 'model' && modelName !== (data.modelName ?? ''));

  return (
    <PageShell className="lg-gateway-settings">
      <PageHeader
        title="服务网关设置"
        subtitle="选择网关内部功能使用的模型。"
      />
      <PageBody>
        {error ? <InlineAlert tone="error">{error} <Button variant="ghost" disabled={saving || testing} onClick={() => void load(false, modelQuery, true)}>重新读取配置</Button></InlineAlert> : null}

        <Card className="lg-gws-card">
          <div style={SECTION_TITLE}>系统级模型</div>
          <div className="lg-gws-sources" role="radiogroup" aria-label="系统级模型来源">
            {sourceOptions.map(item => <label key={item.id} className={source === item.id ? 'is-active' : undefined}>
              <input type="radio" name="system-model-source" value={item.id} checked={source === item.id} disabled={saveUncertain} onChange={() => changeSelection(() => setSource(item.id))} />
              <span><strong>{item.label}</strong><small>{item.hint}</small></span>
            </label>)}
          </div>

          {source === 'pool' ? <div className="lg-gws-field">
            <span style={FIELD_LABEL}>现有兼容配置</span>
            <span>{data.pools.find(pool => pool.id === poolId)?.name || poolId || '未记录模型池'}</span>
            <small style={HINT_TEXT}>模型池不再作为新配置入口。请选择公开模型继续维护；点击保存前，现有设置保持不变。</small>
          </div> : null}

          {source === 'model' ? (
            <label className="lg-gws-field">
              <span style={FIELD_LABEL}>公开模型</span>
              {/* 清单只回前 N 条，所以必须给一条够得着剩下那些的路，否则它们在这一页等于不存在。 */}
              <input
                type="search"
                disabled={saveUncertain}
                value={modelQuery}
                placeholder="按模型名或标识筛选"
                onChange={(event) => setModelQuery(event.target.value)}
              />
              <select disabled={saveUncertain} value={modelName} onChange={(event) => changeSelection(() => setModelName(event.target.value))}>
                <option value="">请选择一个模型</option>
                {/* 提交 publicId、显示 name：解析器按 publicId 匹配，拿显示名去存会匹配不上 */}
                {modelOptions.map((model) => (
                  <option key={model.id} value={model.publicId}>{model.name}</option>
                ))}
              </select>
              {data.models.length === 0 ? (
                <small style={HINT_TEXT}>
                  {modelQuery
                    ? `没有匹配「${modelQuery}」的启用中对话模型，换个关键字试试。`
                    : '当前没有启用的对话类逻辑模型，先去「逻辑模型」启用一个。'}
                </small>
              ) : data.modelTotal > data.models.length ? (
                <small style={HINT_TEXT}>共 {data.modelTotal} 个符合条件，这里只列出前 {data.models.length} 个——输关键字缩小范围就能选到其余的。</small>
              ) : null}
            </label>
          ) : null}

          <div className="lg-gws-impact">影响功能：{data.consumers.length ? data.consumers.map(item => item.feature).join('、') : '影响范围未记录，请核实后保存'}</div>
          <div className="lg-gws-current-state" role="status">{saveUncertain ? '保存结果未确认' : dirty ? '有未保存修改' : '与已读取配置一致'}</div>
          <div className="lg-gws-test-cost">测试会发送真实模型请求，可能产生费用，由「{data.teamName || '系统内部'}」团队承担{data.teamIsSystemOwned ? '，不计入业务团队预算' : ''}。</div>
          <div className="lg-gws-actions">
            <span className="lg-gws-actions-hint">
              {testing
                ? testingStage(testElapsed)
                : dirty
                  ? '测试模型调用测的是已保存的那一份配置，先保存再测，否则会拿旧配置报成功。'
                  : '测试已保存的配置，返回耗时与实际执行的模型。'}
            </span>
            {/* 改了还没保存时禁用：测试端点读的是库里那份，此时测出来的成功与屏幕上选的不是同一件事 */}
            <Button disabled={saveUncertain || testing || dirty} onClick={() => void runTest()}>
              {testing ? <Spinner size={15} /> : <PlugZap size={15} />}
              {testing ? `正在测试 ${testElapsed}s` : '测试模型调用'}
            </Button>
            <Button variant="primary" disabled={saveUncertain || saving || !dirty} onClick={() => void save()}>
              {saving ? '正在保存' : '保存设置'}
            </Button>
          </div>
          {notice ? <div role="status" className="lg-gws-save-feedback">{notice}</div> : null}
          {testResult ? (
            <InlineAlert tone={testResult.ok ? 'ok' : 'error'}>{testResult.message}</InlineAlert>
          ) : null}
        </Card>

        {/*
          系统替你配了什么：少填不等于少知道。这一块把地址、用途码、密钥状态、归属团队
          全部端出来，用户一眼能核对，出问题时也知道该去哪一页。
        */}
        <Card className="lg-gws-card">
          <div style={SECTION_TITLE}>服务与身份</div>
          <div className="lg-gws-facts">
            <div>
              <span style={FIELD_LABEL}>网关服务地址</span>
              <code style={MONO_META}>{data.servingReachable ? data.servingBaseUrl : '服务暂不可达'}</code>
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

        <DetailsBlock title="系统功能与调用用途">
          <ul className="lg-gws-consumers" style={{ display: 'grid', gap: GAP.normal, margin: 0, padding: 0, listStyle: 'none' }}>
            {data.consumers.map((item) => (
              <li key={item.appCallerCode}>
                <strong>{item.feature}</strong>
                <code style={MONO_META}>{item.appCallerCode}</code>
              </li>
            ))}
          </ul>
        </DetailsBlock>
      </PageBody>
    </PageShell>
  );
}
