// 模型池：每个池一张卡，展示策略/类型/默认标记 + 池内每个模型的健康 chip。
// 「默认池」可就地切换：GW 权威池写 llm_gateway，MAP 来源池写旧集合。
//
// 按「控制台风格调性 v1.2」原则 6 / 7 迁移（详见
// doc/rule.platform.llm-gateway.console-design-tonality.md）：
//   - 走 PageShell 骨架、贴边全宽；页头此前自己套了 maxWidth:760，现在副标题宽度
//     统一由 .lg-prose / .lg-page-heading p 的 --measure 管。
//   - 文字预算：此前是全站最大页（8 段 / 488 汉字）。「有则增加，无则不变」这段平台
//     补齐语义收进 HelpPopover，平台托管池的追加规则收进 DetailsBlock，路由机制收进
//     页尾的 DetailsBlock + 教程深链；常驻正文只留只读角色提示一段。
//   - 六种调度策略此前只有标签没有解释（用户看到「最少连接」并不知道它意味着什么），
//     补成 StrategyHelp，挂在策略字段与策略 chip 旁按需展开。
//   - 本路由被 e2e/llmgw-layout-drift.mjs 监测：只用内联表单与扁平 DOM，
//     卡片内边距只允许 CARD_PADDING(14) 与嵌套块 INSET_PADDING(10) 两种。
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { bulkCalibratePoolPriceCurrency, bulkClaimPools, bulkImportPoolModels, claimPoolToGateway, createPool, deletePool, ensurePoolTypes, getExchanges, getModels, getParameterCapabilitiesMeta, getPools, getPoolTypes, recoverPoolModel, removePoolModel, setPoolDefault, updatePool, upsertPoolModel } from '@/lib/api';
import type { ExchangeItem, ModelCapability, ModelItem, ModelPool, ParameterCapabilityMetaItem, PoolModelInfo, PoolTypesData } from '@/lib/types';
import { Chip, SectionLoader, Button, ReadOnlyNotice } from '@/components/ui';
import { DetailsBlock, HelpPopover, PageBody, PageHeader, PageShell, Prose, TutorialLink } from '@/components/PageShell';
import { useDialogs } from '@/components/ConfirmDialog';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';
import { BODY_TEXT, FIELD_INPUT, HINT_TEXT, SECTION_TITLE } from '@/lib/typography';
import { CARD_BODY, CARD_PADDING, GAP, INSET_BLOCK, INSET_PADDING } from '@/lib/surface';

const STRATEGY_LABEL: Record<number, string> = {
  0: '顺位优先', 1: '轮询', 2: '按权重', 3: '最少连接', 4: '随机', 5: '顺位优先 + 熔断',
};

/**
 * 池级状态四档。此前叫「运行健康 / 部分模型异常 / 无可用模型 / 尚未配置模型」——
 * 说的是构成（几个成员坏了），而运维此刻要判断的是后果（这个池还接不接得住）。
 * 成员级四档（可用 / 需关注 / 不可用 / 验证中）与之共用同一批词，不再一边说
 * 「部分模型异常」一边说「部分异常」。
 */
const POOL_STATUS: Record<string, { label: string; color: string; bg: string; severity: number }> = {
  unavailable: { label: '已中断', color: '#f85149', bg: 'rgba(248,81,73,0.14)', severity: 0 },
  degraded: { label: '需关注', color: '#d29922', bg: 'rgba(210,153,34,0.14)', severity: 1 },
  empty: { label: '未配置成员', color: 'var(--text-muted)', bg: 'var(--bg-elevated)', severity: 2 },
  healthy: { label: '正常', color: '#3fb950', bg: 'rgba(63,185,80,0.14)', severity: 3 },
};

/** 成员级状态：0/1/2 来自后端 healthStatus，verify 是前端的本地中间态（见 recoverUnavailablePoolModel）。 */
const MEMBER_STATUS: Record<string, { label: string; color: string; bg: string }> = {
  '0': { label: '可用', color: '#3fb950', bg: 'rgba(63,185,80,0.14)' },
  '1': { label: '需关注', color: '#d29922', bg: 'rgba(210,153,34,0.14)' },
  '2': { label: '不可用', color: '#f85149', bg: 'rgba(248,81,73,0.14)' },
  verify: { label: '验证中', color: '#58a6ff', bg: 'rgba(88,166,255,0.14)' },
};

/** 分诊条的档位。「需要处理」把 degraded 也算进去——它恰恰是最需要人看的一档。 */
const TRIAGE_SEGMENTS: { key: string; label: string; color: string }[] = [
  { key: 'attention', label: '需要处理', color: '#f85149' },
  { key: 'unavailable', label: '已中断', color: '#f85149' },
  { key: 'degraded', label: '需关注', color: '#d29922' },
  { key: 'empty', label: '未配置', color: 'var(--text-muted)' },
  { key: 'healthy', label: '正常', color: '#3fb950' },
  { key: 'all', label: '全部', color: 'var(--text-secondary)' },
];

/**
 * 六种调度策略的说明。原来页面上只有「优先级 / 轮询 / 加权 / 最少连接 / 随机 / 故障转移」
 * 六个裸标签，选的人得自己猜；说明写成常驻段落又会把这一页的文字预算撑爆。
 * 所以做成出口一（字段旁的 ?），在策略字段与策略 chip 两处复用同一份文案，不抄第二遍。
 */
const STRATEGY_DETAIL: { value: number; detail: string }[] = [
  { value: 0, detail: '每次都从第 1 顺位试起，失败当次顺延到下一顺位' },
  { value: 1, detail: '可用成员依次轮流承接，流量平均' },
  { value: 2, detail: '按成员权重分配；成员没有权重字段时实际等同随机' },
  { value: 3, detail: '优先给当前在途请求最少的成员' },
  { value: 4, detail: '在可用成员中随机挑一个，不保留任何调度状态' },
  { value: 5, detail: '与顺位优先相同，但成员连续失败后会被摘除一段时间，不再每次重试' },
];

/**
 * 池级证据。后端只给成员级的连续失败次数，池级没有这个数。
 * 口径固定取**第 1 顺位**：用户此刻要判断的是「主力还能不能用」。
 * 求和会把几个成员的历史混成一个无法行动的数字；取最差成员则可能落在
 * 从不承接流量的末位后备身上，两种都答非所问。
 */
function poolEvidence(pool: ModelPool): { text: string; tone: string } {
  const lead = pool.models.slice().sort((a, b) => a.priority - b.priority)[0];
  if (pool.health === 'empty') return { text: '没有成员，调用会直接失败', tone: 'var(--text-muted)' };
  if (!lead) return { text: '没有成员，调用会直接失败', tone: 'var(--text-muted)' };
  const failed = relativeTime(lead.lastFailedAt);
  const ok = relativeTime(lead.lastSuccessAt);
  if (pool.health === 'unavailable') {
    return { text: `第1顺位连续失败 ${lead.consecutiveFailures} 次 · 最近失败 ${failed} · 最近成功 ${ok}`, tone: '#f85149' };
  }
  if (pool.health === 'degraded') {
    return { text: `第1顺位连续失败 ${lead.consecutiveFailures} 次（${failed}起）· 池仍在承接`, tone: '#d29922' };
  }
  if (pool.recentRequests === 0) {
    return { text: `最近调用 ${relativeTime(pool.lastRequestAt)} · 无窗口内数据`, tone: 'var(--text-muted)' };
  }
  return { text: `最近失败 ${failed} · 最近成功 ${ok}`, tone: 'var(--text-secondary)' };
}

/** 相对时间。绝对时间戳在排障时要用户自己做减法，这一页全部换成「多久之前」。 */
function relativeTime(value?: string | null): string {
  if (!value) return '从未';
  const at = new Date(value).getTime();
  if (!Number.isFinite(at)) return '从未';
  const diff = Date.now() - at;
  if (diff < 0) return '刚刚';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

/**
 * 指标窗口标签。后端每个池都回了 trafficWindowHours，此前 UI 把「7 天」写死在文案里，
 * 窗口一旦调整页面就会睁眼说瞎话。改成按真值渲染。
 */
function windowLabel(hours: number): string {
  if (!hours || hours <= 0) return '窗口未知';
  if (hours % 24 === 0) return `${hours / 24}天`;
  return `${hours}小时`;
}

function StrategyHelp({ align }: { align?: 'start' | 'end' }) {
  return (
    <HelpPopover label="调度策略" align={align}>
      <dl>
        {STRATEGY_DETAIL.map((item) => (
          <div key={item.value}>
            <dt>{STRATEGY_LABEL[item.value]}</dt>
            <dd>{item.detail}</dd>
          </div>
        ))}
      </dl>
    </HelpPopover>
  );
}
type PoolEditDraft = { name: string; code: string; modelType: string; priority: string; strategyType: string; description: string };
type PoolMemberDraft = { modelKey: string; priority: string; protocol: string; parameterCapabilities: string };
type PoolBulkImportDraft = { platformId: string; capabilityFilter: string; maxCount: string; enabledOnly: boolean; overwriteExisting: boolean };
type PriceCurrencyCalibrationDraft = { modelType: string; targetCurrency: string; onlyMissing: boolean; includeMembersWithoutPrice: boolean };

export function ModelPoolsPage() {
  const { tenant } = useAuth();
  const navigate = useNavigate();
  const canWrite = canUseCapability(tenant?.role, 'configWrite');
  const { confirm, promptText } = useDialogs();
  const [pools, setPools] = useState<ModelPool[] | null>(null);
  const [poolTypes, setPoolTypes] = useState<PoolTypesData | null>(null);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [parameterMeta, setParameterMeta] = useState<ParameterCapabilityMetaItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // strategyType / isDefaultForType 此前被硬编码吞掉（恒 0 / 恒 false），而这两个决定
  // 恰恰决定这个池会不会承接流量、怎么承接。新建向导第 2 步把它们交回给用户。
  const [createDraft, setCreateDraft] = useState({ name: '', code: '', modelType: 'chat', priority: '50', isDefaultForType: false, strategyType: '0', description: '' });
  const [bulkModelType, setBulkModelType] = useState('');
  const [priceCurrencyDraft, setPriceCurrencyDraft] = useState<PriceCurrencyCalibrationDraft>({
    modelType: '',
    targetCurrency: 'CNY',
    onlyMissing: true,
    includeMembersWithoutPrice: false,
  });
  const [addDrafts, setAddDrafts] = useState<Record<string, PoolMemberDraft>>({});
  const [bulkImportDrafts, setBulkImportDrafts] = useState<Record<string, PoolBulkImportDraft>>({});
  const [memberParameterCaps, setMemberParameterCaps] = useState<Record<string, string>>({});
  const [memberPriorities, setMemberPriorities] = useState<Record<string, string>>({});
  const [editDrafts, setEditDrafts] = useState<Record<string, PoolEditDraft>>({});
  const [drawer, setDrawer] = useState<{ kind: 'create' } | { kind: 'pool'; poolId: string } | null>(null);
  // 分诊 / 检索 / 排序：定位坏池的三层。默认停在「需要处理」，坏的永远在第一屏第一行。
  const [triage, setTriage] = useState('attention');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [sortBy, setSortBy] = useState('severity');
  const [showFill, setShowFill] = useState(false);
  // 「恢复接单」的本地中间态。后端把成员留在不可用、只发一张进入半开的入场券，
  // 等下一条真实业务请求验证；若 UI 不记这一笔，点完按钮红标签纹丝不动、按钮还在原地，
  // 用户只会反复点。这个 Set 让该成员立刻显示「验证中」并收起按钮。
  const [verifying, setVerifying] = useState<Set<string>>(new Set());
  const [createStep, setCreateStep] = useState(1);
  const [addPositions, setAddPositions] = useState<Record<string, 'tail' | 'pick'>>({});

  useEffect(() => {
    let alive = true;
    Promise.all([getPools(), getPoolTypes(), getModels({ enabled: true }), getExchanges({ enabled: true }), getParameterCapabilitiesMeta()]).then(([poolRes, typeRes, modelRes, exchangeRes, parameterRes]) => {
      if (!alive) return;
      if (poolRes.success) setPools(poolRes.data.items);
      else setError(poolRes.error?.message || '加载失败');
      if (typeRes.success) setPoolTypes(typeRes.data);
      const exchangeCandidates = exchangeRes.success ? toExchangeModelCandidates(exchangeRes.data.items) : [];
      setModels([...(modelRes.success ? modelRes.data.items : []), ...exchangeCandidates]);
      if (parameterRes.success) {
        setParameterMeta(parameterRes.data.items.filter((item) =>
          !isImageSizeControlParameter(`parameter:${item.name}`)));
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  async function ensureDefaultPools() {
    setBusyId('ensure-pool-types');
    setToast(null);
    const res = await ensurePoolTypes();
    setBusyId(null);
    if (!res.success) {
      setToast(res.error?.message || '补齐失败');
      return;
    }
    setPoolTypes(res.data.types);
    const fresh = await getPools();
    if (fresh.success) setPools(fresh.data.items);
    setToast(`补齐完成：新增 ${res.data.typesCreated} 个类型、${res.data.poolsCreated} 个默认池，追加 ${res.data.modelsAppended} 个兼容模型`);
  }

  async function makeDefault(pool: ModelPool) {
    if (pool.isDefaultForType) return;
    setBusyId(pool.id);
    setToast(null);
    const res = await setPoolDefault(pool.id, true);
    setBusyId(null);
    if (res.success) {
      // 同类型互斥：本池置默认，其它同 modelType 池清默认（前端同步反映后端行为）。
      setPools((prev) => (prev ? prev.map((x) => (x.modelType === res.data.modelType ? { ...x, isDefaultForType: x.id === res.data.id } : x)) : prev));
      setToast(`已将「${res.data.name}」设为 ${res.data.modelType || 'chat'} 类型的默认池`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  // 删除模型池。后端把「它是某类型的当前默认池」和「还有 appCaller 绑着它」分开报，
  // 因为前者要先改默认、后者要先解绑，补救动作不一样，合并成一句会让运维不知道先做哪个。
  async function removePool(pool: ModelPool) {
    const label = pool.name || pool.code || pool.id;
    const typed = await promptText({
      title: `删除模型池「${label}」`,
      description: `它的 ${pool.models.length} 个成员配置一并消失，无法撤销。`,
      inputLabel: '确认请输入模型池名称',
      requireExact: label,
      tone: 'danger',
      confirmLabel: '删除',
    });
    if (typed === null) return;
    if (typed.trim() !== label) { setToast('输入的名称不一致，已取消删除'); return; }
    setBusyId(pool.id);
    setToast(null);
    const res = await deletePool(pool.id);
    setBusyId(null);
    if (!res.success) { setToast(res.error?.message || '删除失败'); return; }
    setDrawer(null);
    setPools((prev) => (prev ? prev.filter((x) => x.id !== pool.id) : prev));
    setToast(`已删除模型池「${label}」`);
  }

  async function claimPool(pool: ModelPool) {
    setBusyId(pool.id);
    setToast(null);
    const res = await claimPoolToGateway(pool.id);
    setBusyId(null);
    if (res.success) {
      setPools((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? mergePoolMutation(x, res.data) : x)) : prev));
      setToast(`已将「${res.data.name}」导入平台模型池`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function createGatewayPool() {
    const name = createDraft.name.trim();
    const modelType = createDraft.modelType.trim();
    const priority = toPositiveInt(createDraft.priority);
    if (!name) {
      setToast('模型池名称不能为空');
      return;
    }
    if (!modelType) {
      setToast('模型类型不能为空');
      return;
    }
    if (priority === null) {
      setToast('优先级必须是正整数');
      return;
    }
    setBusyId('create-pool');
    setToast(null);
    const res = await createPool({
      name,
      code: createDraft.code.trim() || undefined,
      modelType,
      priority,
      isDefaultForType: createDraft.isDefaultForType,
      strategyType: toStrategyType(createDraft.strategyType) ?? 0,
      description: createDraft.description.trim() || undefined,
    });
    setBusyId(null);
    if (res.success) {
      setPools((prev) => {
        const current = prev || [];
        const normalized = res.data.isDefaultForType
          ? current.map((p) => (p.modelType === res.data.modelType ? { ...p, isDefaultForType: false } : p))
          : current;
        return [res.data, ...normalized];
      });
      setCreateDraft({ name: '', code: '', modelType, priority: '50', isDefaultForType: false, strategyType: '0', description: '' });
      setCreateStep(1);
      // 建完直接落到该池详情：顶部结论句与最近调用时间就是「改对了没有」的验证依据。
      setDrawer({ kind: 'pool', poolId: res.data.id });
      setToast(`已创建模型池「${res.data.name}」`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function bulkClaim() {
    setBusyId('bulk-claim-pools');
    setToast(null);
    const res = await bulkClaimPools({ modelType: bulkModelType.trim() || undefined, overwrite: false });
    setBusyId(null);
    if (res.success) {
      const fresh = await getPools();
      if (fresh.success) setPools(fresh.data.items);
      setToast(`批量认领完成：新增/更新 ${res.data.claimed} 个，跳过 ${res.data.skipped} 个`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function calibratePriceCurrency() {
    setBusyId('bulk-calibrate-price-currency');
    setToast(null);
    const res = await bulkCalibratePoolPriceCurrency({
      modelType: priceCurrencyDraft.modelType.trim() || undefined,
      targetCurrency: priceCurrencyDraft.targetCurrency,
      onlyMissing: priceCurrencyDraft.onlyMissing,
      includeMembersWithoutPrice: priceCurrencyDraft.includeMembersWithoutPrice,
    });
    setBusyId(null);
    if (res.success) {
      const fresh = await getPools();
      if (fresh.success) setPools(fresh.data.items);
      setToast(`价格币种校准完成：扫描 ${res.data.scannedPools} 个池，更新 ${res.data.updatedMembers} 个成员为 ${res.data.targetCurrency}`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  function startEditPool(pool: ModelPool) {
    setEditDrafts((prev) => ({
      ...prev,
      [pool.id]: {
        name: pool.name,
        code: pool.code,
        modelType: pool.modelType || 'chat',
        priority: String(pool.priority),
        strategyType: String(pool.strategyType),
        // 原值，不是展示用的过滤值：过滤值命中内部标记时是 null，保存就会把描述清空。
        description: pool.description || '',
      },
    }));
  }

  function cancelEditPool(poolId: string) {
    setEditDrafts((prev) => {
      const next = { ...prev };
      delete next[poolId];
      return next;
    });
  }

  async function savePool(pool: ModelPool) {
    const draft = editDrafts[pool.id];
    if (!draft) return;
    const name = draft.name.trim();
    const code = draft.code.trim();
    const modelType = draft.modelType.trim();
    const priority = toPositiveInt(draft.priority);
    const strategyType = toStrategyType(draft.strategyType);
    if (!name) {
      setToast('模型池名称不能为空');
      return;
    }
    if (!code) {
      setToast('模型池 Code 不能为空');
      return;
    }
    if (!modelType) {
      setToast('模型类型不能为空');
      return;
    }
    if (priority === null) {
      setToast('优先级必须是正整数');
      return;
    }
    if (strategyType === null) {
      setToast('策略类型必须是 0 到 5');
      return;
    }
    setBusyId(`pool-edit:${pool.id}`);
    setToast(null);
    const res = await updatePool(pool.id, {
      name,
      code: pool.appendOnly ? undefined : code,
      modelType: pool.appendOnly ? undefined : modelType,
      priority,
      strategyType,
      description: draft.description.trim(),
    });
    setBusyId(null);
    if (res.success) {
      setPools((prev) => {
        if (!prev) return prev;
        const normalized = res.data.isDefaultForType
          ? prev.map((p) => (p.modelType === res.data.modelType ? { ...p, isDefaultForType: false } : p))
          : prev;
        return normalized.map((p) => (p.id === res.data.id ? mergePoolMutation(p, res.data) : p));
      });
      cancelEditPool(pool.id);
      setToast(`已保存模型池「${res.data.name}」`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function addPoolModel(pool: ModelPool) {
    const draft = addDrafts[pool.id];
    if (!draft?.modelKey) {
      setToast('请选择要加入模型池的模型');
      return;
    }
    const selected = models.find((m) => modelOptionKey(m) === draft.modelKey);
    if (!selected) {
      setToast('模型不存在或已被筛选移除');
      return;
    }
    // 顺位默认落末位。此前留空会被 toPositiveInt('') 解成 1，也就是**抢占第 1 顺位**，
    // 而输入框占位符写的是 P{末位}，明示追加到末尾——一个安静的、会改线上流量走向的误操作。
    const mode = addPositions[pool.id] ?? 'tail';
    const tailPriority = pool.models.length + 1;
    const priority = mode === 'tail' ? tailPriority : toPositiveInt(draft.priority);
    if (priority === null) {
      setToast('顺位必须是正整数');
      return;
    }
    const lead = pool.models.slice().sort((a, b) => a.priority - b.priority)[0];
    if (mode === 'pick' && lead && priority <= lead.priority) {
      const ok = await confirm({
        title: '插入第 1 顺位会立刻改变线上流量',
        description: `新成员将抢占全部流量，原第 1 顺位「${lead.modelId}」顺延为后备。确认要这样放吗？`,
        confirmLabel: '确认插入第 1 顺位',
        tone: 'danger',
      });
      if (!ok) return;
    }
    if (containsImageSizeControlParameter(draft.parameterCapabilities)) {
      setToast('图片尺寸能力请在模型高级配置中维护，不能写入模型池成员');
      return;
    }
    setBusyId(pool.id);
    setToast(null);
    const res = await upsertPoolModel(pool.id, {
      modelId: selected.modelName || selected.id,
      platformId: selected.platformId || undefined,
      priority: pool.appendOnly ? undefined : priority,
      protocol: pool.appendOnly ? undefined : draft.protocol.trim() || undefined,
      enablePromptCache: pool.appendOnly ? undefined : selected.enablePromptCache ?? undefined,
      maxTokens: pool.appendOnly ? undefined : selected.maxTokens ?? undefined,
      capabilities: pool.appendOnly ? undefined : mergeParameterCapabilities(selected.capabilities, draft.parameterCapabilities),
    });
    setBusyId(null);
    if (res.success) {
      setPools((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? mergePoolMutation(x, res.data) : x)) : prev));
      setAddDrafts((prev) => ({ ...prev, [pool.id]: emptyMemberDraft() }));
      setToast(`已更新「${res.data.name}」的模型池成员`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function bulkImportModels(pool: ModelPool) {
    const draft = bulkImportDrafts[pool.id] || emptyBulkImportDraft();
    const maxCount = toPositiveInt(draft.maxCount);
    if (maxCount === null) {
      setToast('最大数量必须是正整数');
      return;
    }
    if (!await confirm({ title: `批量导入「${pool.name}」的模型池成员？`, description: '按当前筛选把匹配的模型追加进这个池。', confirmLabel: '批量导入' })) return;
    setBusyId(`pool-bulk-import:${pool.id}`);
    setToast(null);
    const res = await bulkImportPoolModels(pool.id, {
      platformId: draft.platformId || undefined,
      capabilityFilter: pool.appendOnly ? 'compatible' : draft.capabilityFilter,
      enabledOnly: pool.appendOnly ? true : draft.enabledOnly,
      overwriteExisting: pool.appendOnly ? false : draft.overwriteExisting,
      maxCount,
    });
    setBusyId(null);
    if (res.success) {
      if (res.data.pool) {
        setPools((prev) => (prev ? prev.map((x) => (x.id === res.data.pool?.id ? mergePoolMutation(x, res.data.pool) : x)) : prev));
      }
      setToast(`批量导入完成：新增 ${res.data.imported}，更新 ${res.data.updated}，跳过已有 ${res.data.skippedExisting}`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function savePoolModelPriority(pool: ModelPool, member: PoolModelInfo) {
    const key = memberKey(pool.id, member);
    const priority = toPositiveInt(memberPriorities[key] ?? String(member.priority));
    if (priority === null) {
      setToast('优先级必须是正整数');
      return;
    }
    const parameterCapabilities = memberParameterCaps[key] ?? parameterCapabilityText(member.capabilities);
    if (containsImageSizeControlParameter(parameterCapabilities)) {
      setToast('图片尺寸能力请在模型高级配置中维护，不能写入模型池成员');
      return;
    }
    setBusyId(key);
    setToast(null);
    const res = await upsertPoolModel(pool.id, {
      modelId: member.modelId,
      platformId: member.platformId,
      priority,
      protocol: member.protocol || undefined,
      enablePromptCache: member.enablePromptCache ?? undefined,
      maxTokens: member.maxTokens ?? undefined,
      inputPricePerMillion: member.inputPricePerMillion ?? undefined,
      outputPricePerMillion: member.outputPricePerMillion ?? undefined,
      pricePerCall: member.pricePerCall ?? undefined,
      priceCurrency: member.priceCurrency || undefined,
      capabilities: mergeParameterCapabilities(member.capabilities, parameterCapabilities),
    });
    setBusyId(null);
    if (res.success) {
      setPools((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? mergePoolMutation(x, res.data) : x)) : prev));
      setMemberParameterCaps((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setToast(`已保存「${member.modelId}」的池内优先级`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  function updateMemberPriceCurrency(poolId: string, member: PoolModelInfo, priceCurrency: string) {
    setPools((prev) => {
      if (!prev) return prev;
      return prev.map((poolItem) => {
        if (poolItem.id !== poolId) return poolItem;
        return {
          ...poolItem,
          models: poolItem.models.map((currentMember) => (
            currentMember.modelId === member.modelId && currentMember.platformId === member.platformId
              ? { ...currentMember, priceCurrency }
              : currentMember
          )),
        };
      });
    });
  }

  async function deletePoolModel(pool: ModelPool, member: PoolModelInfo) {
    setBusyId(memberKey(pool.id, member));
    setToast(null);
    const res = await removePoolModel(pool.id, member.modelId, member.platformId);
    setBusyId(null);
    if (res.success) {
      setPools((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? mergePoolMutation(x, res.data) : x)) : prev));
      setToast(`已从「${res.data.name}」移除「${member.modelId}」`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function recoverUnavailablePoolModel(pool: ModelPool, member: PoolModelInfo) {
    const key = memberKey(pool.id, member);
    setBusyId(key);
    setToast(null);
    const res = await recoverPoolModel(pool.id, member.modelId, member.platformId);
    setBusyId(null);
    if (res.success) {
      setPools((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? mergePoolMutation(x, res.data) : x)) : prev));
      // 后端刻意让成员留在「不可用」——它只授予进入半开的资格，由下一条真实业务请求验证，
      // 不发额外的付费探测。所以这里必须自己记一笔中间态，否则界面看起来毫无变化。
      setVerifying((prev) => new Set(prev).add(key));
      setToast(`「${member.modelId}」已恢复接单，等下一条真实业务请求验证（不发探测请求）`);
    } else {
      setToast(res.error?.message || '恢复失败');
    }
  }

  if (error) return <Empty text={error} />;
  if (!pools) return <SectionLoader text="正在加载模型池…" />;
  const modelTypes = poolTypes?.items.map((item) => item.code) ?? Array.from(new Set(pools.map((p) => p.modelType).filter(Boolean))).sort();
  const platformIds = Array.from(new Set(models.map((m) => m.platformId).filter((x): x is string => !!x))).sort();
  const selectedPool = drawer?.kind === 'pool' ? pools.find((pool) => pool.id === drawer.poolId) ?? null : null;
  const totalBoundAppCallers = pools.reduce((sum, pool) => sum + pool.boundAppCallerCount, 0);
  const totalRecentRequests = pools.reduce((sum, pool) => sum + pool.recentRequests, 0);
  const statusCounts = pools.reduce<Record<string, number>>((acc, pool) => {
    acc[pool.health] = (acc[pool.health] || 0) + 1;
    return acc;
  }, {});
  const segmentCount = (key: string) => (
    key === 'all' ? pools.length
      : key === 'attention' ? pools.length - (statusCounts.healthy || 0)
        : statusCounts[key] || 0
  );
  const windowText = windowLabel(pools[0]?.trafficWindowHours ?? 168);

  const filtered = pools.filter((pool) => {
    if (triage === 'attention') { if (pool.health === 'healthy') return false; }
    else if (triage !== 'all' && pool.health !== triage) return false;
    if (typeFilter !== 'all' && (pool.modelType || 'chat') !== typeFilter) return false;
    const keyword = query.trim().toLowerCase();
    if (keyword) {
      const haystack = [pool.name, pool.code, pool.modelType,
        ...pool.models.map((m) => m.modelId),
        ...pool.boundAppCallers.map((c) => c.title || c.appCallerCode)].join(' ').toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  }).sort((a, b) => {
    const sev = (p: ModelPool) => POOL_STATUS[p.health]?.severity ?? 9;
    if (sortBy === 'requests') return b.recentRequests - a.recentRequests;
    if (sortBy === 'idle') return new Date(a.lastRequestAt || 0).getTime() - new Date(b.lastRequestAt || 0).getTime();
    if (sortBy === 'failed') {
      const at = (p: ModelPool) => Math.max(...p.models.map((m) => new Date(m.lastFailedAt || 0).getTime()), 0);
      return at(b) - at(a);
    }
    return sev(a) - sev(b) || b.recentRequests - a.recentRequests;
  });

  // 「全部正常」只在**没有任何筛选条件**时才敢下这个结论。带着搜索词或类型筛选时结果为空，
  // 说明的是「没搜到」而不是「一切正常」——把后者显示成前者，就是一次没真正执行的检查报了绿灯。
  const allClear = filtered.length === 0 && pools.length > 0
    && triage === 'attention' && query.trim() === '' && typeFilter === 'all';

  const detailPool = selectedPool;
  const isCreate = drawer?.kind === 'create';
  const railPools = pools.slice().sort((a, b) => (POOL_STATUS[a.health]?.severity ?? 9) - (POOL_STATUS[b.health]?.severity ?? 9));

  return (
    <PageShell>
      <ParameterCapabilityOptions parameterMeta={parameterMeta} />
      <style>{COLUMN_PRIORITY_CSS}</style>
      {isCreate || detailPool ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 0 }} className="mp-detail-shell">
          <aside className="mp-rail" style={{ borderRight: '1px solid var(--border-subtle)', background: 'var(--bg-surface)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, padding: INSET_PADDING, borderBottom: '1px solid var(--border-subtle)' }}>
              <Button size="sm" variant="ghost" onClick={() => { setDrawer(null); setCreateStep(1); }}>返回列表</Button>
              <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-caption)' }}>{pools.length} 个池 · 按严重度排</span>
            </div>
            {railPools.map((pool) => {
              const status = POOL_STATUS[pool.health] || POOL_STATUS.healthy;
              const active = pool.id === detailPool?.id;
              return (
                <button
                  key={pool.id}
                  type="button"
                  onClick={() => setDrawer({ kind: 'pool', poolId: pool.id })}
                  style={{ display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer', padding: `${INSET_PADDING}px`, border: 0, borderBottom: '1px solid var(--border-subtle)', borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`, background: active ? 'var(--bg-elevated)' : 'transparent' }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: GAP.tight, minWidth: 0 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: status.color }} />
                    <span style={{ color: 'var(--text-primary)', fontSize: 'var(--fs-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pool.name}</span>
                  </span>
                  <span style={{ display: 'block', paddingLeft: 13, color: 'var(--text-muted)', fontSize: 'var(--fs-micro)' }}>
                    {status.label} · {pool.recentRequests === 0 ? '无流量' : `${pool.recentRequests} 次/${windowText}`}
                  </span>
                </button>
              );
            })}
          </aside>
          <div style={{ minWidth: 0, padding: CARD_PADDING, display: 'flex', flexDirection: 'column', gap: GAP.section }}>
            {toast ? <div role="status" style={{ ...INSET_BLOCK, border: '1px solid var(--border-subtle)', ...BODY_TEXT }}>{toast}</div> : null}
            {isCreate && canWrite ? (
              <PoolCreateWizard
                draft={createDraft}
                step={createStep}
                modelTypes={modelTypes}
                pools={pools}
                busy={busyId === 'create-pool'}
                onDraftChange={setCreateDraft}
                onStep={setCreateStep}
                onCreate={() => void createGatewayPool()}
                onCancel={() => { setDrawer(null); setCreateStep(1); }}
              />
            ) : detailPool ? (
              <PoolDetail
                pool={detailPool}
                windowText={windowText}
                canWrite={canWrite}
                busyId={busyId}
                editDraft={editDrafts[detailPool.id]}
                models={models}
                parameterMeta={parameterMeta}
                platformIds={platformIds}
                addDraft={addDrafts[detailPool.id] || emptyMemberDraft()}
                addPosition={addPositions[detailPool.id] ?? 'tail'}
                bulkDraft={bulkImportDrafts[detailPool.id] || emptyBulkImportDraft()}
                memberPriorities={memberPriorities}
                memberParameterCaps={memberParameterCaps}
                verifying={verifying}
                onStartEdit={() => startEditPool(detailPool)}
                onCancelEdit={() => cancelEditPool(detailPool.id)}
                onEditDraftChange={(next) => setEditDrafts((prev) => ({ ...prev, [detailPool.id]: next }))}
                onSavePool={() => void savePool(detailPool)}
                onClaim={() => void claimPool(detailPool)}
                onMakeDefault={() => void makeDefault(detailPool)}
                onRemovePool={() => void removePool(detailPool)}
                onAddDraftChange={(next) => setAddDrafts((prev) => ({ ...prev, [detailPool.id]: next }))}
                onAddPositionChange={(mode) => setAddPositions((prev) => ({ ...prev, [detailPool.id]: mode }))}
                onAddMember={() => void addPoolModel(detailPool)}
                onBulkDraftChange={(next) => setBulkImportDrafts((prev) => ({ ...prev, [detailPool.id]: next }))}
                onBulkImport={() => void bulkImportModels(detailPool)}
                onPriorityChange={(key, value) => setMemberPriorities((prev) => ({ ...prev, [key]: value }))}
                onParameterChange={(key, value) => setMemberParameterCaps((prev) => ({ ...prev, [key]: value }))}
                onCurrencyChange={updateMemberPriceCurrency}
                onSaveMember={savePoolModelPriority}
                onRecoverMember={recoverUnavailablePoolModel}
                onDeleteMember={deletePoolModel}
              />
            ) : <Empty text="模型池不存在或已被移除" />}
          </div>
        </div>
      ) : (
        <>
          <PageHeader
            title="模型池"
            subtitle="一次调用落到一个池，池内按顺位挑一个可用成员承接，成员不可用就交给下一顺位。"
            actions={(
              <>
                {canWrite ? <Button size="sm" variant="primary" onClick={() => { setDrawer({ kind: 'create' }); setCreateStep(1); }}>新建模型池</Button> : null}
                <Button size="sm" variant="ghost" onClick={() => navigate('/learn')}>路由机制</Button>
              </>
            )}
          />
          <PageBody>
            {toast ? <div role="status" style={{ flexShrink: 0, ...INSET_BLOCK, border: '1px solid var(--border-subtle)', ...BODY_TEXT }}>{toast}</div> : null}
            {/* 分诊条：每一段都是筛选器，默认停在「需要处理」。此前页头那句「N 个池需要处理」
                不可点击，而页面没有筛选也没有排序，需要处理的池可能在第三屏，只能一张张翻。 */}
            <section style={{ display: 'flex', alignItems: 'center', gap: GAP.section, flexWrap: 'wrap', ...CARD_BODY, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', background: 'var(--bg-surface)' }}>
              <div style={{ display: 'flex', gap: GAP.tight, flexWrap: 'wrap' }}>
                {TRIAGE_SEGMENTS.map((segment) => {
                  const count = segmentCount(segment.key);
                  const active = triage === segment.key;
                  return (
                    <button
                      key={segment.key}
                      type="button"
                      onClick={() => setTriage(segment.key)}
                      style={{ display: 'flex', alignItems: 'center', gap: GAP.tight, cursor: 'pointer', padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: `1px solid ${active ? 'var(--border-strong)' : 'var(--border-subtle)'}`, background: active ? 'var(--bg-elevated)' : 'transparent' }}
                    >
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: segment.color }} />
                      <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-caption)' }}>{segment.label}</span>
                      <strong className="tabular" style={{ color: segment.color, fontSize: 'var(--fs-heading)' }}>{count}</strong>
                    </button>
                  );
                })}
              </div>
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: GAP.normal }}>
                <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-micro)' }}>
                  平台规则覆盖
                  <HelpPopover label="程序池类型规则">
                    有则增加，无则不变：只创建缺失类型默认池，只向平台托管默认池追加兼容且未存在的模型，不覆盖、删除或重排已有成员。
                  </HelpPopover>
                  <br />
                  <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-caption)' }}>{poolTypes?.total ?? 0} 类规则 · {poolTypes?.waiting ?? 0} 类待补模型</span>
                </span>
                {canWrite ? (
                  <Button size="sm" variant="secondary" disabled={busyId === 'ensure-pool-types'} onClick={() => setShowFill((v) => !v)}>
                    {busyId === 'ensure-pool-types' ? '正在补齐' : '补齐缺失的池与成员…'}
                  </Button>
                ) : null}
              </div>
            </section>
            {/* 补齐是写操作：它会建池，也会往**已经在承接流量的**托管池里追加成员。
                只说「创建 N 个池」会让用户点完发现别的池多了成员，所以两段分开列。 */}
            {showFill && canWrite ? (
              <section style={{ ...CARD_BODY, border: '1px solid var(--accent)', borderRadius: 'var(--radius)', background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column', gap: GAP.normal }}>
                <strong style={{ ...SECTION_TITLE }}>
                  按平台规则补齐
                  {/* 补齐的完整语义与「有则增加，无则不变」同源，复用上面那个出口，不抄第二遍。 */}
                  <HelpPopover label="补齐会做什么">
                    有则增加，无则不变：只创建缺失类型默认池，只向平台托管默认池追加兼容且未存在的模型，不覆盖、删除或重排已有成员。
                  </HelpPopover>
                </strong>
                <span style={{ color: '#d29922', fontSize: 'var(--fs-caption)' }}>写操作：会建池，也会往已经在承接流量的托管池里追加成员。</span>
                <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-micro)' }}>待补模型的类型 {poolTypes?.waiting ?? 0} 个 · 已可用 {poolTypes?.ready ?? 0} 个</span>
                <div style={{ display: 'flex', gap: GAP.normal }}>
                  <Button size="sm" variant="primary" disabled={busyId === 'ensure-pool-types'} onClick={() => { setShowFill(false); void ensureDefaultPools(); }}>确认补齐</Button>
                  <Button size="sm" variant="ghost" onClick={() => setShowFill(false)}>取消</Button>
                </div>
              </section>
            ) : null}
            {!canWrite ? <ReadOnlyNotice>当前角色可以查看模型池、成员健康和路由使用情况，但不能修改平台配置。</ReadOnlyNotice> : null}
            {pools.length === 0 ? (
              <section style={{ ...CARD_BODY, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', background: 'var(--bg-surface)', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: GAP.section, paddingTop: 40, paddingBottom: 40 }}>
                <strong style={{ color: 'var(--text-primary)', fontSize: 'var(--fs-metric)' }}>还没有模型池，所有 AI 调用现在都会失败</strong>
                <span style={{ ...BODY_TEXT }}>{canWrite ? '可以按平台规则一次性铺出各类型的默认池，也可以手动建第一个。' : '当前租户暂无模型池，请联系 Owner 或 Admin 配置。'}</span>
                {canWrite ? (
                  <div style={{ display: 'flex', gap: GAP.normal, flexWrap: 'wrap', justifyContent: 'center' }}>
                    <Button size="sm" variant="primary" disabled={busyId === 'ensure-pool-types'} onClick={() => void ensureDefaultPools()}>按平台规则创建默认池</Button>
                    <Button size="sm" variant="secondary" onClick={() => { setDrawer({ kind: 'create' }); setCreateStep(1); }}>手动新建一个池</Button>
                  </div>
                ) : null}
                <div style={{ display: 'flex', gap: GAP.tight, flexWrap: 'wrap', justifyContent: 'center' }}>
                  {(poolTypes?.items ?? []).map((item) => <Chip key={item.code} label={`${item.name}（${item.code}）`} color="var(--text-secondary)" bg="var(--bg-elevated)" />)}
                </div>
              </section>
            ) : (
              <section style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', background: 'var(--bg-surface)', overflowX: 'auto' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, flexWrap: 'wrap', padding: INSET_PADDING, borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)' }}>
                  <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜池名 / 模型名 / appCaller" style={{ ...inputStyle, width: 220 }} aria-label="搜索模型池" />
                  <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} style={smallSelectStyle(150)} aria-label="按类型筛选">
                    <option value="all">类型：全部</option>
                    {modelTypes.map((code) => <option key={code} value={code}>{poolTypes?.items.find((i) => i.code === code)?.name || code}（{code}）</option>)}
                  </select>
                  <select value={sortBy} onChange={(event) => setSortBy(event.target.value)} style={smallSelectStyle(160)} aria-label="排序方式">
                    <option value="severity">排序：严重度</option>
                    <option value="failed">排序：最近失败时间</option>
                    <option value="requests">排序：请求量</option>
                    <option value="idle">排序：闲置时长</option>
                  </select>
                  <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 'var(--fs-caption)' }}>显示 {filtered.length} / {pools.length} 个池</span>
                </div>
                <div className="mp-row mp-head" style={{ padding: INSET_PADDING, borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-muted)', fontSize: 'var(--fs-micro)' }}>
                  <div>状态</div>
                  <div>池 / 类型</div>
                  <div>证据</div>
                  <div>成员顺位</div>
                  <div style={{ textAlign: 'right' }}>成功率·{windowText}</div>
                  <div className="mp-c-dur" style={{ textAlign: 'right' }}>平均耗时·{windowText}</div>
                  <div className="mp-c-req" style={{ textAlign: 'right' }}>请求·{windowText}</div>
                  <div className="mp-c-call" style={{ textAlign: 'right' }}>最近调用</div>
                  <div className="mp-c-badge">标记</div>
                  <div />
                </div>
                {filtered.map((pool) => (
                  <PoolRow key={pool.id} pool={pool} windowText={windowText} onOpen={() => setDrawer({ kind: 'pool', poolId: pool.id })} />
                ))}
                {allClear ? (
                  <div style={{ padding: 28, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: GAP.tight }}>
                    <Chip label="没有需要处理的池" color="#3fb950" bg="rgba(63,185,80,0.14)" />
                    <span style={{ color: 'var(--text-primary)', fontSize: 'var(--fs-heading)' }}>{pools.length} 个池全部正常</span>
                    <span style={{ ...BODY_TEXT }}>如需巡检，<a href="#all" onClick={(event) => { event.preventDefault(); setTriage('all'); }} style={{ color: 'var(--accent)' }}>查看全部 {pools.length} 个池</a>。</span>
                  </div>
                ) : null}
                {filtered.length === 0 && !allClear ? (
                  <div style={{ padding: 24, textAlign: 'center', ...BODY_TEXT }}>
                    当前筛选下没有池。<a href="#reset" onClick={(event) => { event.preventDefault(); setTriage('all'); setQuery(''); setTypeFilter('all'); }} style={{ color: 'var(--accent)' }}>清除筛选</a>
                  </div>
                ) : null}
              </section>
            )}
            {canWrite ? (
              <details style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', background: 'var(--bg-surface)', ...CARD_BODY }}>
                <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 'var(--fs-secondary)', fontWeight: 600 }}>高级维护</summary>
                <PoolAdvancedBar
                  busyId={busyId}
                  modelTypes={modelTypes}
                  bulkModelType={bulkModelType}
                  priceCurrencyDraft={priceCurrencyDraft}
                  onBulkModelTypeChange={setBulkModelType}
                  onPriceCurrencyDraftChange={setPriceCurrencyDraft}
                  onBulkClaim={() => void bulkClaim()}
                  onCalibratePriceCurrency={() => void calibratePriceCurrency()}
                />
              </details>
            ) : null}
            {/* 页头原来常驻这几个全局数字，但它们不回答「要不要管」，占的正是分诊条要用的位置。
                它们是观察性数字，收进折叠块；概览页就位后应整体迁走。 */}
            <details style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', background: 'var(--bg-surface)', ...CARD_BODY }}>
              <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 'var(--fs-secondary)', fontWeight: 600 }}>全局用量</summary>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: GAP.normal, marginTop: GAP.normal }}>
                <CardStat label="模型池" value={`${pools.length} 个`} />
                <CardStat label="业务路由" value={`${modelTypes.length} 类`} />
                <CardStat label="已绑定 appCaller" value={`${totalBoundAppCallers} 个`} />
                <CardStat label={`请求·${windowText}`} value={`${totalRecentRequests} 次`} />
              </div>
            </details>
            <DetailsBlock title="工作原理：一次调用怎么落到某个模型池">
              <Prose>
                调用方指定模型池时直接用它；没指定时按业务类型落到该类型的默认池，再由调度策略在池内挑一个可用成员承接。
              </Prose>
              <TutorialLink chapter="chapter-17">查看教程：第 17 章 模型池与路由</TutorialLink>
            </DetailsBlock>
          </PageBody>
        </>
      )}
    </PageShell>
  );
}


/**
 * 列优先级：十列在 1400px 以下逐档收，但**六列永不隐藏**——状态、池名、证据、成员顺位、
 * 成功率、操作，它们是排障必需。隐藏顺序按信息价值反向：标记 → 请求量 → 平均耗时 → 最近调用。
 * 容器仍保留横向滚动兜底，所以极窄屏也不会丢内容，只是要滑。
 */
const COLUMN_PRIORITY_CSS = `
.mp-row{display:grid;gap:12px;align-items:center;min-width:0}
.mp-row{grid-template-columns:88px minmax(140px,1.3fr) minmax(190px,1.9fr) minmax(150px,1.3fr) 92px 100px 88px 96px 128px 68px}
.mp-head{white-space:nowrap}
@media(max-width:1400px){.mp-row{grid-template-columns:88px minmax(140px,1.3fr) minmax(190px,1.9fr) minmax(150px,1.3fr) 92px 100px 88px 96px 68px}.mp-c-badge{display:none}}
@media(max-width:1280px){.mp-row{grid-template-columns:88px minmax(140px,1.3fr) minmax(190px,1.9fr) minmax(150px,1.3fr) 92px 100px 68px}.mp-c-req{display:none}}
@media(max-width:1150px){.mp-row{grid-template-columns:88px minmax(140px,1.3fr) minmax(190px,1.9fr) minmax(150px,1.3fr) 92px 68px}.mp-c-dur{display:none}}
@media(max-width:1020px){.mp-row{grid-template-columns:88px minmax(130px,1.2fr) minmax(170px,1.8fr) minmax(140px,1.2fr) 84px 68px}.mp-c-call{display:none}}
.mp-detail-shell{grid-template-columns:minmax(0,1fr)}
.mp-rail{display:none}
@media(min-width:960px){.mp-detail-shell{grid-template-columns:264px minmax(0,1fr)}.mp-rail{display:block}}
`;

/**
 * 一行一个池。卡片网格一屏只放得下 8 张，而且每张都在重复标签文字；改成行之后
 * 状态、证据、成功率、第 1 顺位在同一竖列上对齐，可以纵向扫描而不是横向阅读。
 */
function PoolRow({ pool, windowText, onOpen }: { pool: ModelPool; windowText: string; onOpen: () => void }) {
  const status = POOL_STATUS[pool.health] || POOL_STATUS.healthy;
  const evidence = poolEvidence(pool);
  const lead = pool.models.slice().sort((a, b) => a.priority - b.priority)[0];
  const leadStatus = lead ? (MEMBER_STATUS[String(lead.healthStatus)] || MEMBER_STATUS['0']) : null;
  const rate = pool.recentSuccessRatePercent;
  const rateColor = rate == null ? 'var(--text-muted)' : rate === 0 ? '#f85149' : rate < 90 ? '#d29922' : 'var(--text-primary)';
  return (
    <div className="mp-row" style={{ padding: INSET_PADDING, borderBottom: '1px solid var(--border-subtle)', background: pool.health === 'unavailable' ? 'rgba(248,81,73,0.06)' : 'transparent' }}>
      <div><Chip label={status.label} color={status.color} bg={status.bg} /></div>
      <div style={{ minWidth: 0 }}>
        <div style={{ color: 'var(--text-primary)', fontSize: 'var(--fs-secondary)', fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pool.name}</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-micro)' }}>{pool.modelType || 'chat'}</div>
      </div>
      <div style={{ color: evidence.tone, fontSize: 'var(--fs-caption)', minWidth: 0 }}>{evidence.text}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: GAP.tight, minWidth: 0, fontSize: 'var(--fs-caption)' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: leadStatus?.color || 'var(--text-muted)' }} />
          {lead ? <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>第{lead.priority}顺位</span> : null}
          <span style={{ color: lead ? 'var(--text-primary)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lead ? lead.modelId : '无成员'}</span>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-micro)' }}>
          {pool.models.length > 1 ? `另有 ${pool.models.length - 1} 个后备顺位` : pool.models.length === 1 ? '无后备顺位' : '需先添加成员'}
        </div>
      </div>
      <div style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-secondary)', color: rateColor }}>
        {rate == null ? '无流量' : `${rate}%`}
      </div>
      <div className="mp-c-dur" style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}>
        {pool.averageDurationMs == null ? '—' : `${(pool.averageDurationMs / 1000).toFixed(1)}s`}
      </div>
      <div className="mp-c-req" style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}>{pool.recentRequests}</div>
      <div className="mp-c-call" style={{ textAlign: 'right', fontSize: 'var(--fs-caption)', color: pool.recentRequests === 0 ? 'var(--text-muted)' : 'var(--text-secondary)' }}>
        {pool.lastRequestAt ? relativeTime(pool.lastRequestAt) : `${windowText}内无请求`}
      </div>
      <div className="mp-c-badge" style={{ display: 'flex', gap: GAP.tight, flexWrap: 'wrap' }}>
        {pool.isDefaultForType ? <Chip label="默认池" color="var(--accent)" bg="var(--accent-soft)" /> : null}
        {poolSourceBadge(pool)}
      </div>
      <div style={{ textAlign: 'right' }}><Button size="sm" variant="secondary" onClick={onOpen}>打开</Button></div>
    </div>
  );
}

/**
 * 来源标记一律走中性色。橙色在这一页已经是「需关注」的含义，身份标记再用橙色，
 * 一行里就会出现两级看似告警的颜色（红色已中断 + 橙色外部来源），读起来像两个问题。
 * 另外「外部来源」此前完全没有标记，用户只能进详情后发现按钮少了一半。
 */
function poolSourceBadge(pool: ModelPool) {
  if (pool.appendOnly) return <Chip label="平台托管" color="var(--text-secondary)" bg="var(--bg-elevated)" />;
  if (pool.authority !== 'llm_gateway') return <Chip label="外部来源" color="var(--text-secondary)" bg="var(--bg-elevated)" />;
  return null;
}

function CardStat({ label, value }: { label: string; value: string }) {
  return <div style={{ padding: INSET_PADDING, background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', minWidth: 0 }}><div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-micro)' }}>{label}</div><div style={{ color: 'var(--text-primary)', fontSize: 'var(--fs-secondary)', fontWeight: 650, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div></div>;
}

/** 指标格：每一格都带自己的窗口，否则同屏两个成功率会被读成互相矛盾。 */
function MetricStat({ label, value, window: windowText, tone }: { label: string; value: string; window: string; tone?: string }) {
  return (
    <div style={{ padding: INSET_PADDING, background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', minWidth: 0 }}>
      <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-micro)' }}>{label}</div>
      <div style={{ color: tone || 'var(--text-primary)', fontSize: 'var(--fs-heading)', fontWeight: 650, marginTop: 2 }}>{value}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-micro)', marginTop: 2 }}>{windowText}</div>
    </div>
  );
}

/** 池详情结论句：先说「还接不接得住」，再让用户往下看证据。 */
function poolVerdict(pool: ModelPool): string {
  const members = pool.models.slice().sort((a, b) => a.priority - b.priority);
  const lead = members[0];
  const healthy = members.find((m) => m.healthStatus === 0);
  if (pool.health === 'empty' || !lead) return '池已建好但没有成员，落到这里的调用会直接失败。';
  if (pool.health === 'unavailable') {
    return `全部 ${members.length} 个顺位都不可用，这个池现在接不了任何调用；最近一次成功是 ${relativeTime(lead.lastSuccessAt)}。`;
  }
  if (pool.health === 'degraded') {
    const bad = members.find((m) => m.healthStatus !== 0) || lead;
    const tail = healthy ? `，第${healthy.priority}顺位 ${healthy.modelId} 在承接` : '';
    return `第${bad.priority}顺位 ${bad.modelId} ${(MEMBER_STATUS[String(bad.healthStatus)] || MEMBER_STATUS['1']).label}（连续失败 ${bad.consecutiveFailures} 次）${tail}；建议处理但未中断。`;
  }
  if (pool.recentRequests === 0) return `状态正常，但最近调用是 ${relativeTime(pool.lastRequestAt)}，指标为最后一次结果。`;
  return `全部顺位可用，最近一次失败是 ${relativeTime(lead.lastFailedAt)}。`;
}

/**
 * 只用于**展示**：带内部迁移标记的描述不端到用户面前。
 *
 * 它绝不能用来填编辑草稿——此前 startEditPool 拿的就是这个过滤后的值，命中标记时得到 null，
 * 草稿变成空串，用户点一下「保存属性」就把原描述真删了，全程无提示。以前描述压根不显示，
 * 这个缺陷看不出来；按新设计把描述摆到详情标题下之后，用户会亲眼看到自己写的东西凭空消失。
 * 所以编辑一律走原值（见 startEditPool）。
 */
function publicPoolDescription(value?: string | null) {
  if (!value) return null;
  return /\b(?:P\d+|legacy|stub|full-http|gate)\b|权威|迁移|兜底/i.test(value) ? null : value;
}

function mergePoolMutation(previous: ModelPool, next: ModelPool): ModelPool {
  const healthyMembers = next.models.filter((model) => model.healthStatus === 0).length;
  const degradedMembers = next.models.filter((model) => model.healthStatus === 1).length;
  const unavailableMembers = next.models.filter((model) => model.healthStatus === 2).length;
  const health: ModelPool['health'] = next.models.length === 0
    ? 'empty'
    : healthyMembers === 0
      ? 'unavailable'
      : degradedMembers > 0 || unavailableMembers > 0
        ? 'degraded'
        : 'healthy';
  return {
    ...next,
    boundAppCallerCount: previous.boundAppCallerCount,
    boundAppCallers: previous.boundAppCallers,
    recentRequests: previous.recentRequests,
    recentSucceeded: previous.recentSucceeded,
    recentFailed: previous.recentFailed,
    recentSuccessRatePercent: previous.recentSuccessRatePercent,
    lastRequestAt: previous.lastRequestAt,
    trafficWindowHours: previous.trafficWindowHours,
    health,
    healthyMembers,
    degradedMembers,
    unavailableMembers,
  };
}

/** 高级维护：批量认领与价格币种校准。日常查看不需要，收在折叠块里。 */
function PoolAdvancedBar({
  busyId, modelTypes, bulkModelType, priceCurrencyDraft,
  onBulkModelTypeChange, onPriceCurrencyDraftChange, onBulkClaim, onCalibratePriceCurrency,
}: {
  busyId: string | null;
  modelTypes: string[];
  bulkModelType: string;
  priceCurrencyDraft: PriceCurrencyCalibrationDraft;
  onBulkModelTypeChange: (value: string) => void;
  onPriceCurrencyDraftChange: (draft: PriceCurrencyCalibrationDraft) => void;
  onBulkClaim: () => void;
  onCalibratePriceCurrency: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.normal, marginTop: GAP.normal }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP.normal, alignItems: 'center' }}>
        <select value={bulkModelType} onChange={(e) => onBulkModelTypeChange(e.target.value)} style={{ ...selectStyle, width: 180 }} aria-label="批量接管模型类型">
          <option value="">全部类型</option>
          {modelTypes.map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
        <Button size="sm" variant="ghost" disabled={busyId === 'bulk-claim-pools'} onClick={onBulkClaim}>
          {busyId === 'bulk-claim-pools' ? '处理中…' : '批量接管历史模型池'}
        </Button>
        <span style={HINT_TEXT}>默认跳过已存在的平台模型池，不覆盖已有调整。</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP.normal, alignItems: 'center' }}>
        <select value={priceCurrencyDraft.modelType} onChange={(e) => onPriceCurrencyDraftChange({ ...priceCurrencyDraft, modelType: e.target.value })} style={{ ...selectStyle, width: 180 }} aria-label="价格币种校准模型类型">
          <option value="">全部类型</option>
          {modelTypes.map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
        <select value={priceCurrencyDraft.targetCurrency} onChange={(e) => onPriceCurrencyDraftChange({ ...priceCurrencyDraft, targetCurrency: e.target.value })} style={{ ...selectStyle, width: 86 }} aria-label="价格币种校准目标币种">
          <option value="CNY">CNY</option>
          <option value="USD">USD</option>
        </select>
        <label style={inlineCheckStyle}>
          <input type="checkbox" checked={priceCurrencyDraft.onlyMissing} onChange={(e) => onPriceCurrencyDraftChange({ ...priceCurrencyDraft, onlyMissing: e.target.checked })} />
          只补空币种
        </label>
        <label style={inlineCheckStyle}>
          <input type="checkbox" checked={priceCurrencyDraft.includeMembersWithoutPrice} onChange={(e) => onPriceCurrencyDraftChange({ ...priceCurrencyDraft, includeMembersWithoutPrice: e.target.checked })} />
          包含无价格成员
        </label>
        <Button size="sm" variant="ghost" disabled={busyId === 'bulk-calibrate-price-currency'} onClick={onCalibratePriceCurrency}>
          {busyId === 'bulk-calibrate-price-currency' ? '处理中…' : '校准价格币种'}
        </Button>
        <span style={HINT_TEXT}>只校准平台配置中已有价格字段的历史成员。</span>
      </div>
    </div>
  );
}

type CreateDraft = { name: string; code: string; modelType: string; priority: string; isDefaultForType: boolean; strategyType: string; description: string };

/**
 * 新建向导。此前是一行内联表单，调度策略与「设为默认池」被硬编码吞掉（恒 0 / 恒 false），
 * 而这两个决定恰恰决定这个池会不会承接流量。最后一步先给影响清单再提交：
 * 「设为默认池」会立刻从现默认池手里接走该类型的全部未指定流量，这事必须在点之前说。
 */
function PoolCreateWizard({
  draft, step, modelTypes, pools, busy, onDraftChange, onStep, onCreate, onCancel,
}: {
  draft: CreateDraft;
  step: number;
  modelTypes: string[];
  pools: ModelPool[];
  busy: boolean;
  onDraftChange: (draft: CreateDraft) => void;
  onStep: (step: number) => void;
  onCreate: () => void;
  onCancel: () => void;
}) {
  const steps = ['名称与类型', '路由与默认池', '业务说明', '确认影响'];
  const currentDefault = pools.find((p) => (p.modelType || 'chat') === draft.modelType.trim() && p.isDefaultForType);
  const canNext = step !== 1 || (draft.name.trim() !== '' && draft.modelType.trim() !== '');
  return (
    <section style={{ ...CARD_BODY, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column', gap: GAP.section }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: 'var(--fs-metric)' }}>新建模型池</h2>
        {steps.map((label, index) => (
          <span key={label} style={{ padding: '3px 8px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--fs-caption)', border: `1px solid ${step === index + 1 ? 'var(--accent)' : 'var(--border-subtle)'}`, color: step === index + 1 ? 'var(--accent)' : 'var(--text-muted)' }}>
            {index + 1} {label}
          </span>
        ))}
      </div>

      {step === 1 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP.normal, alignItems: 'center' }}>
          <input value={draft.name} onChange={(e) => onDraftChange({ ...draft, name: e.target.value })} placeholder="模型池名称，例如客服对话" style={{ ...inputStyle, flex: '1 1 200px' }} aria-label="新模型池名称" />
          <input value={draft.code} onChange={(e) => onDraftChange({ ...draft, code: e.target.value })} placeholder="Code 可选" style={{ ...inputStyle, width: 150 }} aria-label="模型池 Code" />
          <input value={draft.modelType} onChange={(e) => onDraftChange({ ...draft, modelType: e.target.value })} placeholder="chat" style={{ ...inputStyle, width: 120 }} aria-label="模型类型" list="gw-pool-model-types" />
          <datalist id="gw-pool-model-types">{modelTypes.map((type) => <option key={type} value={type} />)}</datalist>
          <label style={inlineCheckStyle}>池优先级<input value={draft.priority} onChange={(e) => onDraftChange({ ...draft, priority: e.target.value })} placeholder="50" inputMode="numeric" style={smallInputStyle(64)} aria-label="模型池优先级" /></label>
        </div>
      ) : null}

      {step === 2 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.normal }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.tight, flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-secondary)' }}>调度策略</span>
            <StrategyHelp />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: GAP.tight }}>
            {STRATEGY_DETAIL.map((item) => {
              const active = String(item.value) === draft.strategyType;
              return (
                <button key={item.value} type="button" onClick={() => onDraftChange({ ...draft, strategyType: String(item.value) })}
                  style={{ textAlign: 'left', cursor: 'pointer', padding: INSET_PADDING, borderRadius: 'var(--radius-sm)', border: `1px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`, background: active ? 'var(--accent-soft)' : 'var(--bg-elevated)' }}>
                  <span style={{ display: 'block', color: 'var(--text-primary)', fontSize: 'var(--fs-secondary)', fontWeight: 600 }}>
                    {STRATEGY_LABEL[item.value]}{item.value === 0 ? ' · 推荐' : ''}
                  </span>
                  <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 'var(--fs-micro)', marginTop: 2 }}>{item.detail}</span>
                </button>
              );
            })}
          </div>
          <label style={inlineCheckStyle}>
            <input type="checkbox" checked={draft.isDefaultForType} onChange={(e) => onDraftChange({ ...draft, isDefaultForType: e.target.checked })} />
            设为默认池
          </label>
          {draft.isDefaultForType ? (
            <span style={{ color: '#d29922', fontSize: 'var(--fs-caption)' }}>
              创建后立刻承接「{draft.modelType.trim() || 'chat'}」类型全部未指定调用{currentDefault ? `，现默认池「${currentDefault.name}」让出这部分流量` : ''}。
            </span>
          ) : null}
        </div>
      ) : null}

      {step === 3 ? (
        <input value={draft.description} onChange={(e) => onDraftChange({ ...draft, description: e.target.value })} placeholder="业务说明，会显示在池详情里给同事看" style={{ ...inputStyle, width: '100%' }} aria-label="模型池业务说明" />
      ) : null}

      {step === 4 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.tight }}>
          <ReviewRow label="新池" value={`${draft.modelType.trim() || 'chat'} 类型的「${draft.name.trim() || '未命名'}」`} />
          <ReviewRow label="调度" value={`${STRATEGY_LABEL[Number(draft.strategyType)] || draft.strategyType} — ${STRATEGY_DETAIL.find((s) => String(s.value) === draft.strategyType)?.detail || ''}`} />
          <ReviewRow
            label="流量"
            tone={draft.isDefaultForType ? '#d29922' : undefined}
            value={draft.isDefaultForType
              ? `设为默认池：创建后立即承接该类型全部未指定调用${currentDefault ? `，现默认池「${currentDefault.name}」让出流量` : ''}`
              : '不设为默认池：只有显式绑定的 appCaller 会用它，创建后不影响线上流量'}
          />
          <ReviewRow label="成员" value="创建时不带成员；建完在详情里添加，添加前这个池接不了调用" />
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: GAP.normal, flexWrap: 'wrap' }}>
        {step > 1 ? <Button size="sm" variant="ghost" onClick={() => onStep(step - 1)}>上一步</Button> : null}
        {step < 4
          ? <Button size="sm" variant="primary" disabled={!canNext} onClick={() => onStep(step + 1)}>下一步</Button>
          : <Button size="sm" variant="primary" disabled={busy} onClick={onCreate}>{busy ? '处理中…' : '创建并打开池详情'}</Button>}
        <Button size="sm" variant="ghost" onClick={onCancel}>取消</Button>
      </div>
    </section>
  );
}

function ReviewRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{ display: 'flex', gap: GAP.normal, padding: INSET_PADDING, borderRadius: 'var(--radius-sm)', border: `1px solid ${tone || 'var(--border-subtle)'}`, background: 'var(--bg-elevated)' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-caption)', width: 48, flexShrink: 0 }}>{label}</span>
      <span style={{ color: tone || 'var(--text-primary)', fontSize: 'var(--fs-secondary)' }}>{value}</span>
    </div>
  );
}

/**
 * 池详情。此前是 680px 抽屉，容不下「结论 → 证据 → 成员 → 编辑」这条链，
 * 而且盖住列表后没法比较两个池。改成整页分栏（左侧导航在 render 里），
 * 顺序固定为 结论 → 证据 → 指标 → 策略 → 成员与顺位 → 添加成员 → 折叠的高级维护：
 * **控件永远排在它依赖的信息后面**，不再出现「先让你选加哪个模型、往下才看到现在有谁」。
 */
function PoolDetail({
  pool, windowText, canWrite, busyId, editDraft, models, parameterMeta, platformIds,
  addDraft, addPosition, bulkDraft, memberPriorities, memberParameterCaps, verifying,
  onStartEdit, onCancelEdit, onEditDraftChange, onSavePool, onClaim, onMakeDefault, onRemovePool,
  onAddDraftChange, onAddPositionChange, onAddMember, onBulkDraftChange, onBulkImport,
  onPriorityChange, onParameterChange, onCurrencyChange, onSaveMember, onRecoverMember, onDeleteMember,
}: {
  pool: ModelPool;
  windowText: string;
  canWrite: boolean;
  busyId: string | null;
  editDraft?: PoolEditDraft;
  models: ModelItem[];
  parameterMeta: ParameterCapabilityMetaItem[];
  platformIds: string[];
  addDraft: PoolMemberDraft;
  addPosition: 'tail' | 'pick';
  bulkDraft: PoolBulkImportDraft;
  memberPriorities: Record<string, string>;
  memberParameterCaps: Record<string, string>;
  verifying: Set<string>;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onEditDraftChange: (draft: PoolEditDraft) => void;
  onSavePool: () => void;
  onClaim: () => void;
  onMakeDefault: () => void;
  onRemovePool: () => void;
  onAddDraftChange: (draft: PoolMemberDraft) => void;
  onAddPositionChange: (mode: 'tail' | 'pick') => void;
  onAddMember: () => void;
  onBulkDraftChange: (draft: PoolBulkImportDraft) => void;
  onBulkImport: () => void;
  onPriorityChange: (key: string, value: string) => void;
  onParameterChange: (key: string, value: string) => void;
  onCurrencyChange: (poolId: string, member: PoolModelInfo, value: string) => void;
  onSaveMember: (pool: ModelPool, member: PoolModelInfo) => Promise<void>;
  onRecoverMember: (pool: ModelPool, member: PoolModelInfo) => Promise<void>;
  onDeleteMember: (pool: ModelPool, member: PoolModelInfo) => Promise<void>;
}) {
  const status = POOL_STATUS[pool.health] || POOL_STATUS.healthy;
  const isExternal = pool.authority !== 'llm_gateway';
  const locked = pool.appendOnly;
  const members = pool.models.slice().sort((a, b) => a.priority - b.priority);
  const lead = members[0];
  const description = publicPoolDescription(pool.description);
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: GAP.section, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 240, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.tight, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: 'var(--fs-metric)' }}>{pool.name}</h2>
            <Chip label={status.label} color={status.color} bg={status.bg} />
            {pool.isDefaultForType ? <Chip label="默认池" color="var(--accent)" bg="var(--accent-soft)" /> : null}
            {poolSourceBadge(pool)}
          </div>
          <div style={{ ...BODY_TEXT, marginTop: 4 }}>
            {pool.modelType || 'chat'} · 服务 {pool.boundAppCallerCount} 个 appCaller{description ? ` · 描述：${description}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: GAP.normal, flexWrap: 'wrap' }}>
          {canWrite && !isExternal ? <Button size="sm" variant="secondary" onClick={() => (editDraft ? onCancelEdit() : onStartEdit())}>{editDraft ? '取消编辑' : '编辑属性'}</Button> : null}
          {canWrite && isExternal ? <Button size="sm" variant="secondary" disabled={busyId === pool.id} onClick={onClaim}>接管配置…</Button> : null}
          {canWrite && !pool.isDefaultForType ? <Button size="sm" variant="ghost" disabled={busyId === pool.id} onClick={onMakeDefault}>设为默认池</Button> : null}
          {canWrite && !isExternal ? <Button size="sm" variant="ghost" disabled={busyId === pool.id} onClick={onRemovePool}>删除</Button> : null}
          <Link to={`/app-callers?modelPoolId=${encodeURIComponent(pool.id)}`} style={{ alignSelf: 'center', color: 'var(--accent)', fontSize: 'var(--fs-secondary)', textDecoration: 'none' }}>查看 appCaller</Link>
          <Link to={`/logs?modelPoolId=${encodeURIComponent(pool.id)}`} style={{ alignSelf: 'center', color: 'var(--accent)', fontSize: 'var(--fs-secondary)', textDecoration: 'none' }}>请求记录</Link>
        </div>
      </div>

      {/* 结论先行：先说「还接不接得住」，证据紧随其后。 */}
      <section style={{ ...CARD_BODY, border: `1px solid ${status.color}`, borderRadius: 'var(--radius)', background: 'var(--bg-elevated)', display: 'flex', flexDirection: 'column', gap: GAP.normal }}>
        <span style={{ color: 'var(--text-primary)', fontSize: 'var(--fs-heading)' }}>{poolVerdict(pool)}</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: GAP.normal }}>
          <CardStat label="第1顺位连续失败" value={lead ? `${lead.consecutiveFailures} 次` : '—'} />
          <CardStat label="最近失败" value={lead ? relativeTime(lead.lastFailedAt) : '—'} />
          <CardStat label="最近成功" value={lead ? relativeTime(lead.lastSuccessAt) : '—'} />
          <CardStat label="最近调用" value={relativeTime(pool.lastRequestAt)} />
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: GAP.normal }}>
        <MetricStat label="成功率" value={pool.recentSuccessRatePercent == null ? '无流量' : `${pool.recentSuccessRatePercent}%`} window={`窗口：${windowText}`} tone={pool.recentSuccessRatePercent != null && pool.recentSuccessRatePercent < 90 ? '#d29922' : undefined} />
        <MetricStat label="成功率" value={pool.recentTenSuccessRatePercent == null ? '无流量' : `${pool.recentTenSuccessRatePercent}%`} window="窗口：近 10 次调用" tone={pool.recentTenSuccessRatePercent != null && pool.recentTenSuccessRatePercent < 90 ? '#d29922' : undefined} />
        <MetricStat label="平均耗时" value={pool.averageDurationMs == null ? '无流量' : `${(pool.averageDurationMs / 1000).toFixed(1)} 秒`} window={`窗口：${windowText}`} />
        <MetricStat label="请求量" value={`${pool.recentRequests} 次`} window={`窗口：${windowText}`} />
        <MetricStat label="绑定 appCaller" value={`${pool.boundAppCallerCount} 个`} window="当前生效" />
      </div>

      <section style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, flexWrap: 'wrap', ...INSET_BLOCK, border: '1px solid var(--border-subtle)' }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-micro)' }}>调度策略</span>
        <strong style={{ color: 'var(--text-primary)', fontSize: 'var(--fs-secondary)' }}>{STRATEGY_LABEL[pool.strategyType] || `策略 ${pool.strategyType}`}</strong>
        <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-caption)' }}>{STRATEGY_DETAIL.find((s) => s.value === pool.strategyType)?.detail}</span>
        <StrategyHelp />
        {locked ? <span style={{ marginLeft: 'auto', ...HINT_TEXT }}>平台托管，策略由平台维护</span> : null}
      </section>

      {canWrite && editDraft ? (
        <PoolEditBar draft={editDraft} managed={pool.appendOnly} busy={busyId === `pool-edit:${pool.id}`} onDraftChange={onEditDraftChange} onSave={onSavePool} onCancel={onCancelEdit} />
      ) : null}

      <div style={{ display: 'flex', alignItems: 'baseline', gap: GAP.normal, flexWrap: 'wrap' }}>
        <h3 style={{ ...SECTION_TITLE, margin: 0 }}>成员与顺位</h3>
        <span style={{ ...HINT_TEXT }}>从第 1 顺位开始试，序号越小越先承接。</span>
      </div>

      {/* 「为什么这里改不了」贴在受限区域旁边，不再藏进默认收起的折叠块。 */}
      {locked || isExternal ? (
        <div style={{ ...INSET_BLOCK, border: '1px solid var(--border-subtle)', ...BODY_TEXT }}>
          {locked
            ? '平台托管池：可以追加成员，但顺位、币种、字段能力由平台维护，也不能移除成员。'
            : '外部来源池：配置由上游系统同步，接管配置后才能编辑成员。'}
        </div>
      ) : null}

      {members.length === 0 ? (
        <div style={{ padding: CARD_PADDING, border: '1px dashed var(--border-subtle)', borderRadius: 'var(--radius-sm)', ...BODY_TEXT }}>暂无模型成员。添加成员后才能承接请求。</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.tight }}>
          {members.map((member) => {
            const key = memberKey(pool.id, member);
            const isVerifying = verifying.has(key);
            const chip = MEMBER_STATUS[isVerifying ? 'verify' : String(member.healthStatus)] || MEMBER_STATUS['0'];
            const editable = canWrite && !isExternal && !locked;
            return (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, flexWrap: 'wrap', ...INSET_BLOCK, fontSize: 'var(--fs-secondary)' }}>
                <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-caption)', flexShrink: 0 }}>第{member.priority}顺位</span>
                <Chip label={chip.label} color={chip.color} bg={chip.bg} />
                <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}>{member.modelId}</span>
                {member.protocol ? <span style={{ color: 'var(--text-muted)' }}>{member.protocol}</span> : null}
                <span style={{ flexBasis: '100%', color: 'var(--text-muted)', fontSize: 'var(--fs-micro)' }}>
                  {isVerifying
                    ? '已恢复接单，等下一条真实业务请求验证（不发探测请求）'
                    : `连续失败 ${member.consecutiveFailures} 次 · 最近失败 ${relativeTime(member.lastFailedAt)} · 最近成功 ${relativeTime(member.lastSuccessAt)}`}
                </span>
                <CapabilityTags labels={capabilityLabelsForMember(member)} />
                {editable ? (
                  <>
                    <label style={inlineCheckStyle}>顺位<input value={memberPriorities[key] ?? String(member.priority)} onChange={(event) => onPriorityChange(key, event.target.value)} style={smallInputStyle(58)} inputMode="numeric" /></label>
                    <select value={(member.priceCurrency || 'CNY').toUpperCase()} onChange={(event) => onCurrencyChange(pool.id, member, event.target.value)} style={smallSelectStyle(74)} aria-label="价格币种"><option value="CNY">CNY</option><option value="USD">USD</option></select>
                    <input value={memberParameterCaps[key] ?? parameterCapabilityText(member.capabilities)} onChange={(event) => onParameterChange(key, event.target.value)} placeholder="字段能力，例如 seed" list="gw-parameter-capability-options" style={{ ...inputStyle, flex: '1 1 160px' }} aria-label="字段级参数能力" />
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: GAP.tight }}>
                      {member.healthStatus === 2 && !isVerifying ? <Button size="sm" variant="secondary" disabled={busyId === key} onClick={() => void onRecoverMember(pool, member)}>恢复接单</Button> : null}
                      <Button size="sm" variant="ghost" disabled={busyId === key} onClick={() => void onSaveMember(pool, member)}>保存</Button>
                      <Button size="sm" variant="ghost" disabled={busyId === key} onClick={() => void onDeleteMember(pool, member)}>移除</Button>
                    </span>
                  </>
                ) : (
                  <span style={{ marginLeft: 'auto', ...HINT_TEXT }}>{locked ? '顺位与字段由平台维护' : isExternal ? '接管配置后可编辑' : ''}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {canWrite && !isExternal ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-secondary)', fontWeight: 600 }}>添加成员</span>
            {/* 顺位默认末位：不改现有流量。要插到前面必须显式选，且提交前二次确认。 */}
            <button type="button" onClick={() => onAddPositionChange('tail')} style={positionButtonStyle(addPosition === 'tail')}>末位（第{pool.models.length + 1}顺位）· 不改现有流量</button>
            <button type="button" onClick={() => onAddPositionChange('pick')} style={positionButtonStyle(addPosition === 'pick')}>指定顺位</button>
            {addPosition === 'pick' ? (
              <input value={addDraft.priority} onChange={(e) => onAddDraftChange({ ...addDraft, priority: e.target.value })} placeholder="1" inputMode="numeric" style={smallInputStyle(64)} aria-label="指定顺位" />
            ) : null}
          </div>
          {addPosition === 'pick' && lead ? (
            <span style={{ color: '#d29922', fontSize: 'var(--fs-caption)' }}>插入第 1 顺位会立刻抢占全部流量，原第 1 顺位「{lead.modelId}」顺延为后备；提交前会再确认一次。</span>
          ) : null}
          <PoolMemberEditor pool={pool} models={models} parameterMeta={parameterMeta} draft={addDraft} busyId={busyId} onDraftChange={onAddDraftChange} onAdd={onAddMember} />
          <details style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: INSET_PADDING }}>
            <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 'var(--fs-secondary)' }}>批量添加成员</summary>
            <div style={{ marginTop: INSET_PADDING }}>
              <PoolBulkImportBar pool={pool} platformIds={platformIds} draft={bulkDraft} busyId={busyId} onDraftChange={onBulkDraftChange} onImport={onBulkImport} />
            </div>
          </details>
        </>
      ) : null}
    </>
  );
}

function positionButtonStyle(active: boolean) {
  return {
    cursor: 'pointer',
    padding: '5px 10px',
    borderRadius: 'var(--radius-sm)',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`,
    background: active ? 'var(--accent-soft)' : 'var(--bg-elevated)',
    color: active ? 'var(--accent)' : 'var(--text-secondary)',
    fontSize: 'var(--fs-caption)',
  } as const;
}

function PoolEditBar({
  draft,
  managed,
  busy,
  onDraftChange,
  onSave,
  onCancel,
}: {
  draft: PoolEditDraft;
  managed: boolean;
  busy: boolean;
  onDraftChange: (draft: PoolEditDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: GAP.normal,
        alignItems: 'center',
        marginBottom: INSET_PADDING,
        ...INSET_BLOCK,
        border: '1px solid var(--border-subtle)',
      }}
    >
      <input
        value={draft.name}
        onChange={(e) => onDraftChange({ ...draft, name: e.target.value })}
        placeholder="模型池名称"
        style={{ ...inputStyle, flex: '1 1 180px' }}
        aria-label="模型池名称"
      />
      <input
        value={draft.code}
        onChange={(e) => onDraftChange({ ...draft, code: e.target.value })}
        placeholder="Code"
        style={{ ...inputStyle, width: 150 }}
        aria-label="模型池 Code"
        disabled={managed}
      />
      <input
        value={draft.modelType}
        onChange={(e) => onDraftChange({ ...draft, modelType: e.target.value })}
        placeholder="模型类型"
        style={{ ...inputStyle, width: 110 }}
        aria-label="模型类型"
        disabled={managed}
      />
      <input
        value={draft.priority}
        onChange={(e) => onDraftChange({ ...draft, priority: e.target.value })}
        placeholder="池优先级"
        inputMode="numeric"
        style={{ ...inputStyle, width: 92 }}
        aria-label="池优先级"
      />
      {/* 六种策略的差别收在这个 ? 里：常驻写出来会把这一页的文字预算撑爆，
          不写又等于让人对着六个裸标签猜。 */}
      <span style={strategyFieldStyle}>调度策略<StrategyHelp /></span>
      <select
        value={draft.strategyType}
        onChange={(e) => onDraftChange({ ...draft, strategyType: e.target.value })}
        style={{ ...selectStyle, width: 120 }}
        aria-label="策略类型"
      >
        {Object.entries(STRATEGY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <input
        value={draft.description}
        onChange={(e) => onDraftChange({ ...draft, description: e.target.value })}
        placeholder="描述"
        style={{ ...inputStyle, flex: '1 1 220px' }}
        aria-label="模型池描述"
      />
      <Button size="sm" variant="secondary" disabled={busy} onClick={onSave}>
        {busy ? '处理中…' : '保存属性'}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
        取消
      </Button>
    </div>
  );
}

function PoolBulkImportBar({
  pool,
  platformIds,
  draft,
  busyId,
  onDraftChange,
  onImport,
}: {
  pool: ModelPool;
  platformIds: string[];
  draft: PoolBulkImportDraft;
  busyId: string | null;
  onDraftChange: (draft: PoolBulkImportDraft) => void;
  onImport: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: GAP.normal,
        alignItems: 'center',
        marginBottom: INSET_PADDING,
        ...INSET_BLOCK,
        border: '1px solid var(--border-subtle)',
      }}
    >
      <span style={{ fontSize: 'var(--fs-secondary)', fontWeight: 600, color: 'var(--text-secondary)' }}>批量导入成员</span>
      <select
        value={draft.platformId}
        onChange={(e) => onDraftChange({ ...draft, platformId: e.target.value })}
        style={{ ...selectStyle, width: 180 }}
        aria-label="批量导入平台"
      >
        <option value="">全部平台</option>
        {platformIds.map((platformId) => <option key={platformId} value={platformId}>{platformId}</option>)}
      </select>
      <select
        value={pool.appendOnly ? 'compatible' : draft.capabilityFilter}
        onChange={(e) => onDraftChange({ ...draft, capabilityFilter: e.target.value })}
        style={{ ...selectStyle, width: 160 }}
        aria-label="批量导入能力过滤"
        disabled={pool.appendOnly}
      >
        <option value="compatible">匹配当前池</option>
        <option value="all">全部模型</option>
        <option value="vision">Vision</option>
        <option value="image">Image</option>
        <option value="function_calling">Tool calls</option>
        <option value="parallel_tool_calls">Parallel tools</option>
        <option value="parameter_capabilities">Parameters</option>
        <option value="thinking">Thinking</option>
        <option value="structured_output">Structured output</option>
        <option value="logprobs">Logprobs</option>
        <option value="prompt_cache">Prompt cache</option>
      </select>
      <input
        value={draft.maxCount}
        onChange={(e) => onDraftChange({ ...draft, maxCount: e.target.value })}
        placeholder="200"
        inputMode="numeric"
        style={{ ...inputStyle, width: 76 }}
        aria-label="批量导入最大数量"
      />
      <label style={inlineCheckStyle}>
        <input
          type="checkbox"
          checked={pool.appendOnly || draft.enabledOnly}
          onChange={(e) => onDraftChange({ ...draft, enabledOnly: e.target.checked })}
          disabled={pool.appendOnly}
        />
        仅启用
      </label>
      <label style={inlineCheckStyle}>
        <input
          type="checkbox"
          checked={!pool.appendOnly && draft.overwriteExisting}
          onChange={(e) => onDraftChange({ ...draft, overwriteExisting: e.target.checked })}
          disabled={pool.appendOnly}
        />
        覆盖已有
      </label>
      <Button size="sm" variant="ghost" disabled={busyId === `pool-bulk-import:${pool.id}`} onClick={onImport}>
        {busyId === `pool-bulk-import:${pool.id}` ? '处理中…' : '批量导入'}
      </Button>
      <span style={HINT_TEXT}>{pool.appendOnly ? '平台托管池固定只导入已启用、同类型且未存在的模型。' : '只更新平台配置中的模型池，默认跳过已有成员。'}</span>
    </div>
  );
}

function PoolMemberEditor({
  pool,
  models,
  parameterMeta,
  draft,
  busyId,
  onDraftChange,
  onAdd,
}: {
  pool: ModelPool;
  models: ModelItem[];
  parameterMeta: ParameterCapabilityMetaItem[];
  draft: PoolMemberDraft;
  busyId: string | null;
  onDraftChange: (draft: PoolMemberDraft) => void;
  onAdd: () => void;
}) {
  const [filterMode, setFilterMode] = useState('compatible');
  const effectiveFilterMode = pool.appendOnly ? 'compatible' : filterMode;
  const existingMembers = new Set(pool.models.map((member) => `${member.platformId || ''}::${member.modelId}`));
  const filteredModels = models.filter((model) => {
    const modelId = model.modelName || model.name || model.id;
    return model.enabled
      && !existingMembers.has(`${model.platformId || ''}::${modelId}`)
      && matchesModelFilter(model, pool.modelType, effectiveFilterMode);
  });
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: GAP.normal,
        alignItems: 'center',
        marginBottom: INSET_PADDING,
        ...INSET_BLOCK,
        border: '1px solid var(--border-subtle)',
      }}
    >
      <select
        value={effectiveFilterMode}
        onChange={(e) => setFilterMode(e.target.value)}
        disabled={pool.appendOnly}
        style={{ ...selectStyle, width: 150 }}
        aria-label="能力过滤"
      >
        <option value="compatible">匹配当前池</option>
        <option value="all">全部模型</option>
        <option value="vision">Vision</option>
        <option value="image">Image</option>
        <option value="function_calling">Tool calls</option>
        <option value="parallel_tool_calls">Parallel tools</option>
        <option value="parameter_capabilities">Parameters</option>
        <option value="thinking">Thinking</option>
        <option value="structured_output">Structured output</option>
        <option value="logprobs">Logprobs</option>
        <option value="prompt_cache">Prompt cache</option>
      </select>
      <select
        value={draft.modelKey}
        onChange={(e) => onDraftChange({ ...draft, modelKey: e.target.value })}
        style={{ ...selectStyle, flex: '1 1 260px' }}
        aria-label="选择模型"
      >
        <option value="">{filteredModels.length ? '选择要加入的模型' : '当前过滤无可用模型'}</option>
        {filteredModels.map((m) => (
          <option key={modelOptionKey(m)} value={modelOptionKey(m)}>
            {m.sourceCollection === 'llmgw_model_exchanges' ? 'Exchange · ' : ''}{(m.name || m.modelName || m.id)} · {capabilityLabelsForModel(m).slice(0, 4).join('/')}
          </option>
        ))}
      </select>
      {/* 顺位不在这里填：它由上方的「末位 / 指定顺位」二选一决定（默认末位，不改现有流量）。
          此前这里是一个占位符写着 P{末位} 的输入框，留空却会被解析成 1、也就是抢占第 1 顺位——
          控件暗示的和实际发生的正好相反。同一件事只保留一处控件。 */}
      {!pool.appendOnly ? (
        <>
          <input
            value={draft.protocol}
            onChange={(e) => onDraftChange({ ...draft, protocol: e.target.value })}
            placeholder="协议覆盖"
            style={{ ...inputStyle, width: 130 }}
            aria-label="协议覆盖"
          />
          <input
            value={draft.parameterCapabilities}
            onChange={(e) => onDraftChange({ ...draft, parameterCapabilities: e.target.value })}
            placeholder="seed, stop=false"
            list="gw-parameter-capability-options"
            style={{ ...inputStyle, flex: '1 1 180px' }}
            aria-label="字段级参数能力"
            title="字段级参数能力，例：seed, stop=false；保存为 parameter:<name>"
          />
        </>
      ) : null}
      <Button size="sm" variant="secondary" disabled={busyId === pool.id} onClick={onAdd}>
        {busyId === pool.id ? '处理中…' : pool.appendOnly ? '追加模型' : '添加/更新'}
      </Button>
      <span style={HINT_TEXT}>
        {filteredModels.length} 个可追加候选{pool.appendOnly ? '，已过滤已有成员与不匹配模型' : ''}
      </span>
      {parameterMeta.length ? (
        <span style={HINT_TEXT}>
          参数能力 {parameterMeta.length} 项
        </span>
      ) : null}
    </div>
  );
}

function ParameterCapabilityOptions({ parameterMeta }: { parameterMeta: ParameterCapabilityMetaItem[] }) {
  if (parameterMeta.length === 0) return null;
  return (
    <datalist id="gw-parameter-capability-options">
      {parameterMeta.map((item) => (
        <option key={item.capabilityType} value={item.name}>
          {item.label} · {item.category}
        </option>
      ))}
      {parameterMeta.map((item) => (
        <option key={`${item.capabilityType}:false`} value={`${item.name}=false`}>
          {item.label} 不支持
        </option>
      ))}
    </datalist>
  );
}

function CapabilityTags({ labels }: { labels: string[] }) {
  const visible = labels.slice(0, 5);
  if (visible.length === 0) return null;
  return (
    <span style={{ display: 'inline-flex', gap: GAP.tight, flexWrap: 'wrap' }}>
      {visible.map((label) => (
        <Chip key={label} label={label} color="var(--text-secondary)" bg="var(--bg-surface)" />
      ))}
    </span>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 'var(--fs-secondary)' }}>
      {text}
    </div>
  );
}

function matchesModelFilter(model: ModelItem, poolModelType: string, filterMode: string) {
  if (filterMode === 'all') return true;
  if (filterMode === 'compatible') return isModelCompatibleWithPool(model, poolModelType);
  if (filterMode === 'vision') return hasModelCapability(model, 'vision', 'image_input', 'multimodal') || model.isVision;
  if (filterMode === 'image') return hasModelCapability(model, 'image_generation', 'text_to_image', 'image') || model.isImageGen;
  if (filterMode === 'function_calling') return hasModelCapability(model, 'function_calling', 'tool_calling', 'tools');
  if (filterMode === 'parallel_tool_calls') return hasParallelToolCallsCapability(model);
  if (filterMode === 'parameter_capabilities') return hasParameterCapabilities(model.capabilities);
  if (filterMode === 'thinking') return hasModelCapability(model, 'thinking', 'reasoning');
  if (filterMode === 'structured_output') return hasStructuredOutputCapability(model);
  if (filterMode === 'logprobs') return hasLogprobsCapability(model);
  if (filterMode === 'prompt_cache') return model.enablePromptCache === true || hasModelCapability(model, 'prompt_cache', 'prompt_caching');
  return true;
}

function isModelCompatibleWithPool(model: ModelItem, poolModelType: string) {
  const type = poolModelType.toLowerCase();
  if (type === 'vision') return model.isVision || hasModelCapability(model, 'vision', 'image_input', 'multimodal');
  if (type === 'generation') return model.isImageGen || hasModelCapability(model, 'image_generation', 'text_to_image', 'image');
  if (type === 'intent') return model.isIntent || model.isMain;
  if (type === 'chat') return model.isMain || model.isIntent || hasModelCapability(model, 'chat', 'text_generation', 'reasoning');
  if (type === 'code') return hasModelCapability(model, 'code', 'code_generation', 'code_completion');
  if (type === 'long-context') return model.isMain || hasModelCapability(model, 'long_context', 'long-context');
  if (type === 'embedding') return hasModelCapability(model, 'embedding', 'embeddings', 'vector');
  if (type === 'rerank') return hasModelCapability(model, 'rerank', 'reranking');
  if (type === 'asr') return hasModelCapability(model, 'asr', 'speech_to_text', 'audio_input');
  if (type === 'tts') return hasModelCapability(model, 'tts', 'text_to_speech', 'audio_output');
  if (type === 'video-gen') return hasModelCapability(model, 'video_generation', 'text_to_video', 'image_to_video', 'video');
  if (type === 'audio-gen') return hasModelCapability(model, 'audio_generation', 'music_generation', 'audio');
  if (type === 'moderation') return hasModelCapability(model, 'moderation', 'safety', 'content_filter');
  return false;
}

function hasModelCapability(model: ModelItem, ...types: string[]) {
  const wanted = new Set(types.map((x) => x.toLowerCase()));
  return model.capabilities.some((c) => c.value && wanted.has(c.type.toLowerCase()));
}

function hasMemberCapability(member: PoolModelInfo, ...types: string[]) {
  const wanted = new Set(types.map((x) => x.toLowerCase()));
  return member.capabilities.some((c) => c.value && wanted.has(c.type.toLowerCase()));
}

function hasStructuredOutputCapability(model: ModelItem) {
  return hasModelCapability(model, 'structured_output', 'json_schema', 'json_mode', 'response_format');
}

function hasMemberStructuredOutputCapability(member: PoolModelInfo) {
  return hasMemberCapability(member, 'structured_output', 'json_schema', 'json_mode', 'response_format');
}

function hasLogprobsCapability(model: ModelItem) {
  return hasModelCapability(model, 'logprobs', 'top_logprobs', 'token_logprobs');
}

function hasMemberLogprobsCapability(member: PoolModelInfo) {
  return hasMemberCapability(member, 'logprobs', 'top_logprobs', 'token_logprobs');
}

function hasParallelToolCallsCapability(model: ModelItem) {
  return hasModelCapability(model, 'parallel_tool_calls', 'parallel_tools', 'parallel_function_calling');
}

function hasMemberParallelToolCallsCapability(member: PoolModelInfo) {
  return hasMemberCapability(member, 'parallel_tool_calls', 'parallel_tools', 'parallel_function_calling');
}

function hasParameterCapabilities(capabilities: ModelCapability[]) {
  return capabilities.some((c) => parameterCapabilityName(c.type) !== null);
}

function capabilityLabelsForModel(model: ModelItem) {
  return uniqueLabels([
    model.isMain ? 'chat' : '',
    model.isIntent ? 'intent' : '',
    model.isVision ? 'vision' : '',
    model.isImageGen ? 'image' : '',
    model.enablePromptCache ? 'prompt-cache' : '',
    hasStructuredOutputCapability(model) ? 'structured-output' : '',
    hasLogprobsCapability(model) ? 'logprobs' : '',
    hasParallelToolCallsCapability(model) ? 'parallel-tools' : '',
    hasParameterCapabilities(model.capabilities) ? 'parameters' : '',
    ...model.capabilities.filter((c) => c.value).map((c) => c.type),
  ]);
}

function toExchangeModelCandidates(exchanges: ExchangeItem[]): ModelItem[] {
  return exchanges
    .filter((exchange) => exchange.authority === 'llm_gateway' && exchange.enabled)
    .flatMap((exchange) => exchange.models.filter((model) => model.enabled).map((model) => {
      const capabilityType = model.modelType === 'generation'
        ? 'image_generation'
        : model.modelType === 'long-context'
          ? 'long_context'
          : model.modelType === 'video-gen'
            ? 'video_generation'
            : model.modelType === 'audio-gen'
              ? 'audio_generation'
              : model.modelType;
      return {
        id: `exchange:${exchange.id}:${model.modelId}`,
        name: `${exchange.name} / ${model.displayName || model.modelId}`,
        modelName: model.modelId,
        platformId: exchange.id,
        timeout: 0,
        maxRetries: 0,
        maxConcurrency: 0,
        enabled: true,
        priority: 100,
        isMain: model.modelType === 'chat',
        isIntent: model.modelType === 'intent',
        isVision: model.modelType === 'vision',
        isImageGen: model.modelType === 'generation',
        hasKey: exchange.hasKey,
        sourceCollection: 'llmgw_model_exchanges',
        authority: 'llm_gateway',
        callCount: 0,
        successCount: 0,
        failCount: 0,
        totalDuration: 0,
        capabilities: [{ type: capabilityType, source: 'exchange', value: true }],
      } satisfies ModelItem;
    }));
}

function capabilityLabelsForMember(member: PoolModelInfo) {
  return uniqueLabels([
    member.isMain ? 'chat' : '',
    member.isIntent ? 'intent' : '',
    member.isVision ? 'vision' : '',
    member.isImageGen ? 'image' : '',
    member.enablePromptCache ? 'prompt-cache' : '',
    hasMemberCapability(member, 'function_calling', 'tool_calling', 'tools') ? 'tools' : '',
    hasMemberParallelToolCallsCapability(member) ? 'parallel-tools' : '',
    hasMemberCapability(member, 'thinking', 'reasoning') ? 'thinking' : '',
    hasMemberStructuredOutputCapability(member) ? 'structured-output' : '',
    hasMemberLogprobsCapability(member) ? 'logprobs' : '',
    hasParameterCapabilities(member.capabilities) ? 'parameters' : '',
    ...member.capabilities.filter((c) => c.value).map((c) => c.type),
  ]);
}

function uniqueLabels(labels: string[]) {
  return Array.from(new Set(labels.map((x) => x.trim()).filter(Boolean)));
}

function emptyMemberDraft(): PoolMemberDraft {
  return { modelKey: '', priority: '', protocol: '', parameterCapabilities: '' };
}

function emptyBulkImportDraft(): PoolBulkImportDraft {
  return { platformId: '', capabilityFilter: 'compatible', maxCount: '200', enabledOnly: true, overwriteExisting: false };
}

function mergeParameterCapabilities(base: ModelCapability[], text: string): ModelCapability[] {
  const parsed = parseParameterCapabilities(text).filter((capability) =>
    !isImageSizeControlParameter(capability.type));
  const next = base.filter((cap) => parameterCapabilityName(cap.type) === null);
  const byName = new Map<string, ModelCapability>();
  for (const capability of base) {
    const name = parameterCapabilityName(capability.type);
    if (name && !isImageSizeControlParameter(capability.type)) {
      byName.set(name.toLowerCase(), capability);
    }
  }
  for (const capability of parsed) {
    const name = parameterCapabilityName(capability.type);
    if (name) byName.set(name.toLowerCase(), capability);
  }
  return [...next, ...Array.from(byName.values()).sort((a, b) => a.type.localeCompare(b.type))];
}

function parseParameterCapabilities(text: string): ModelCapability[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [rawName, rawValue] = part.split('=');
      const name = parameterCapabilityName(rawName) || normalizeParameterName(rawName);
      if (!name) return null;
      return {
        type: `parameter:${name}`,
        source: 'user',
        value: rawValue === undefined ? true : parseCapabilityBool(rawValue),
      };
    })
    .filter((x): x is ModelCapability => x !== null);
}

function parameterCapabilityText(capabilities: ModelCapability[]) {
  return capabilities
    .map((capability) => {
      const name = parameterCapabilityName(capability.type);
      if (!name || isImageSizeControlParameter(capability.type)) return null;
      return capability.value ? name : `${name}=false`;
    })
    .filter((x): x is string => x !== null)
    .sort((a, b) => a.localeCompare(b))
    .join(', ');
}

function parameterCapabilityName(type: string) {
  const normalized = type.trim();
  for (const prefix of ['parameter:', 'parameter.', 'param:', 'param.']) {
    if (normalized.toLowerCase().startsWith(prefix)) {
      return normalizeParameterName(normalized.slice(prefix.length));
    }
  }
  return null;
}

function isImageSizeControlParameter(type: string) {
  return parameterCapabilityName(type)?.toLowerCase().startsWith('image_size.') === true;
}

function containsImageSizeControlParameter(text: string) {
  return parseParameterCapabilities(text).some((capability) =>
    isImageSizeControlParameter(capability.type));
}

function normalizeParameterName(value: string) {
  const normalized = value.trim().replace(/\s+/g, '_');
  return /^[a-zA-Z0-9_.-]+$/.test(normalized) ? normalized : null;
}

function parseCapabilityBool(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== 'false' && normalized !== '0' && normalized !== 'no' && normalized !== 'off';
}

function modelOptionKey(model: ModelItem) {
  return `${model.platformId || ''}::${model.modelName || model.name || model.id}::${model.id}`;
}

function memberKey(poolId: string, member: PoolModelInfo) {
  return `${poolId}::${member.platformId}::${member.modelId}`;
}

function toPositiveInt(value: string | undefined) {
  const normalized = (value || '').trim();
  if (normalized.length === 0) return 1;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

function toStrategyType(value: string | undefined) {
  const normalized = (value || '').trim();
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 5) return null;
  return parsed;
}

const inputStyle = { ...FIELD_INPUT };

const selectStyle = {
  ...inputStyle,
};

const inlineCheckStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: GAP.tight,
  color: 'var(--text-muted)',
  fontSize: 'var(--fs-secondary)',
};

/** 策略字段名 + 出口一的 ?。字段名走 --fs-secondary（角色表里的「字段名」档）。 */
const strategyFieldStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: GAP.tight,
  color: 'var(--text-secondary)',
  fontSize: 'var(--fs-secondary)',
};

function smallInputStyle(width: number) {
  return {
    ...inputStyle,
    width,
    height: 34,
    padding: '0 8px',
  };
}

function smallSelectStyle(width: number) {
  return {
    ...smallInputStyle(width),
    padding: '0 4px',
  };
}
