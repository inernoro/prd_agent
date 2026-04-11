import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ScanSearch,
  ArrowLeft,
  Plus,
  RefreshCw,
  Trash2,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  Clock3,
  HelpCircle,
  Loader2,
  Search,
  CircleDot,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  createPrReviewPrismSubmission,
  deletePrReviewPrismSubmission,
  downloadPrReviewPrismRepoBootstrapSkill,
  getPrReviewPrismStatus,
  getPrReviewPrismSetupStatus,
  getPrReviewPrismTokenConfigStatus,
  listPrReviewPrismSubmissions,
  batchRefreshPrReviewPrismSubmissions,
  refreshPrReviewPrismSubmission,
  updatePrReviewPrismTokenConfig,
  type PrReviewPrismGateStatus,
  type PrReviewPrismSubmission,
  type PrReviewPrismBatchRefreshFailure,
  type PrReviewPrismSetupStatus,
  type PrReviewPrismTokenConfigStatus,
} from '@/services';

const bootstrapInitCommand = 'bash scripts/bootstrap-pr-prism.sh';
const prismRepoWorkspaceStorageKey = 'prReviewPrism.workspaceRepo';
const prismRepoWorkspaceParamsStorageKey = 'prReviewPrism.workspaceRepoParams';
const prismRecentReposStorageKey = 'prReviewPrism.recentRepos';
const defaultRepoOwner = 'your-github-id';
const defaultRepoContext = 'engineering-governance';
const defaultRepoAnchorId = 'ANCHOR-CORE-01';

type RepoWorkspaceParams = {
  owner: string;
  context: string;
  anchorId: string;
  updatedAt: number;
};

function normalizeRepoKey(raw: string): string {
  const parsed = parseRepoFromPrUrl(raw);
  return (parsed ?? raw).trim().toLowerCase();
}

function isValidRepoKey(repo: string): boolean {
  return /^[^/\s]+\/[^/\s]+$/.test(repo);
}

function readStorageJson<T>(storageKey: string, fallback: T): T {
  if (typeof window === 'undefined') {
    return fallback;
  }
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function sanitizeRecentRepos(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((item): item is string => typeof item === 'string')
    .map(normalizeRepoKey)
    .filter(isValidRepoKey);
}

function sanitizeRepoWorkspaceParams(raw: unknown): Record<string, RepoWorkspaceParams> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const result: Record<string, RepoWorkspaceParams> = {};
  for (const [repo, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedRepo = normalizeRepoKey(repo);
    if (!isValidRepoKey(normalizedRepo) || !value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }

    const owner = typeof (value as { owner?: unknown }).owner === 'string'
      ? ((value as { owner: string }).owner.trim() || defaultRepoOwner)
      : defaultRepoOwner;
    const context = typeof (value as { context?: unknown }).context === 'string'
      ? ((value as { context: string }).context.trim() || defaultRepoContext)
      : defaultRepoContext;
    const anchorId = typeof (value as { anchorId?: unknown }).anchorId === 'string'
      ? ((value as { anchorId: string }).anchorId.trim() || defaultRepoAnchorId)
      : defaultRepoAnchorId;
    const updatedAt = typeof (value as { updatedAt?: unknown }).updatedAt === 'number'
      ? (value as { updatedAt: number }).updatedAt
      : Date.now();

    result[normalizedRepo] = {
      owner,
      context,
      anchorId,
      updatedAt,
    };
  }

  return result;
}

function parseRepoFromPrUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }
  // Accept malformed copies like "https:/github.com/owner/repo/pull/1".
  const normalized = text.replace(/^https?:\/(?!\/)/i, match => `${match}/`);
  const match = normalized.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/\d+/i);
  if (!match) {
    return null;
  }
  return `${match[1]}/${match[2]}`;
}

export function PrReviewPrismPage() {
  const navigate = useNavigate();
  const [hint, setHint] = useState<string>('正在连接服务...');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [batchRefreshing, setBatchRefreshing] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{
    total: number;
    done: number;
    success: number;
    failed: number;
  } | null>(null);
  const [items, setItems] = useState<PrReviewPrismSubmission[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState('');
  const [activeGateFilter, setActiveGateFilter] = useState<'all' | PrReviewPrismGateStatus>('all');
  const [prUrl, setPrUrl] = useState('');
  const [note, setNote] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [setupStatus, setSetupStatus] = useState<PrReviewPrismSetupStatus | null>(null);
  const [tokenConfig, setTokenConfig] = useState<PrReviewPrismTokenConfigStatus | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [savingToken, setSavingToken] = useState(false);
  const [setupActionMessage, setSetupActionMessage] = useState<string | null>(null);
  const [bindingRepoInput, setBindingRepoInput] = useState('');
  const [selectedRepo, setSelectedRepo] = useState(() => {
    if (typeof window === 'undefined') {
      return '';
    }
    return window.localStorage.getItem(prismRepoWorkspaceStorageKey) ?? '';
  });
  const [bootstrapDownloading, setBootstrapDownloading] = useState(false);
  const [downloadFallbackUrl, setDownloadFallbackUrl] = useState<string | null>(null);
  const hydratedRepoRef = useRef<string>('');
  const [showDesignBasisPanel] = useState(false);
  const [showOnboardingWizard, setShowOnboardingWizard] = useState(false);
  const [ownerInput, setOwnerInput] = useState(defaultRepoOwner);
  const [contextInput, setContextInput] = useState(defaultRepoContext);
  const [anchorInput, setAnchorInput] = useState(defaultRepoAnchorId);
  const [repoWorkspaceParamsMap, setRepoWorkspaceParamsMap] = useState<Record<string, RepoWorkspaceParams>>(() =>
    sanitizeRepoWorkspaceParams(readStorageJson<unknown>(prismRepoWorkspaceParamsStorageKey, {}))
  );
  const [recentRepos, setRecentRepos] = useState<string[]>(() =>
    sanitizeRecentRepos(readStorageJson<unknown>(prismRecentReposStorageKey, []))
  );
  const [gateStatusCounts, setGateStatusCounts] = useState<{
    all: number;
    completed: number;
    pending: number;
    missing: number;
    error: number;
  }>({
    all: 0,
    completed: 0,
    pending: 0,
    missing: 0,
    error: 0,
  });
  const [repoSetupStatusMap, setRepoSetupStatusMap] = useState<Record<string, PrReviewPrismSetupStatus>>({});

  const filteredItems = useMemo(() => items, [items]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const batchProgressPercent = useMemo(() => {
    if (!batchProgress || batchProgress.total <= 0) {
      return 0;
    }
    return Math.min(100, Math.round((batchProgress.done / batchProgress.total) * 100));
  }, [batchProgress]);

  const selected = useMemo(
    () => filteredItems.find(x => x.id === selectedId) ?? null,
    [filteredItems, selectedId]
  );
  const normalizedBindingRepo = useMemo(() => {
    const raw = bindingRepoInput.trim();
    if (!raw) {
      return '';
    }
    const parsed = parseRepoFromPrUrl(raw);
    return parsed ?? raw;
  }, [bindingRepoInput]);
  const normalizedSelectedRepo = useMemo(() => {
    const raw = selectedRepo.trim();
    if (!raw) {
      return '';
    }
    const parsed = parseRepoFromPrUrl(raw);
    return (parsed ?? raw).toLowerCase();
  }, [selectedRepo]);
  const isBindingRepoValid = useMemo(() => isValidRepoKey(normalizedBindingRepo), [normalizedBindingRepo]);
  const normalizedOwner = useMemo(() => ownerInput.trim() || defaultRepoOwner, [ownerInput]);
  const normalizedContext = useMemo(() => contextInput.trim() || defaultRepoContext, [contextInput]);
  const normalizedAnchor = useMemo(() => anchorInput.trim() || defaultRepoAnchorId, [anchorInput]);
  const observedRepos = useMemo(
    () => Array.from(new Set(items.map(x => `${x.repoOwner}/${x.repoName}`.toLowerCase()))),
    [items]
  );
  const visibleRepoCandidates = useMemo(() => {
    const ordered = [
      ...(normalizedSelectedRepo ? [normalizedSelectedRepo] : []),
      ...recentRepos.map(x => x.toLowerCase()),
      ...observedRepos,
    ];
    const set = new Set<string>();
    const list: string[] = [];
    for (const repo of ordered) {
      if (!repo || set.has(repo)) {
        continue;
      }
      set.add(repo);
      list.push(repo);
    }
    return list;
  }, [normalizedSelectedRepo, observedRepos, recentRepos]);
  const recentRepoList = useMemo(() => recentRepos.filter(isValidRepoKey).slice(0, 6), [recentRepos]);
  const currentRepoParamsPreview = useMemo(() => {
    if (!normalizedSelectedRepo) {
      return null;
    }
    const params = repoWorkspaceParamsMap[normalizedSelectedRepo];
    if (!params) {
      return null;
    }
    return params;
  }, [normalizedSelectedRepo, repoWorkspaceParamsMap]);
  const repoScopedBootstrapCommand = useMemo(() => {
    if (!isBindingRepoValid) {
      return bootstrapInitCommand;
    }
    return `bash scripts/bootstrap-pr-prism.sh --repo "${normalizedBindingRepo}" --owner "${normalizedOwner}" --context "${normalizedContext}"`;
  }, [isBindingRepoValid, normalizedBindingRepo, normalizedOwner, normalizedContext]);
  const repoBindingSnippet = useMemo(() => {
    if (!isBindingRepoValid) {
      return '';
    }
    return `- repo: "${normalizedBindingRepo}"
  enabled: true
  design_source_id: "local-ddd-anchor"
  design_source_version: "v1.0.0"
  default_owner: "${normalizedOwner}"
  default_context: "${normalizedContext}"
  default_anchor_refs:
    - "${normalizedAnchor}"
  required_checks:
    - "PR审查棱镜 L1 Gate"
    - "PR审查棱镜 Advisory"`;
  }, [isBindingRepoValid, normalizedBindingRepo, normalizedOwner, normalizedContext, normalizedAnchor]);
  const topDesignBasisTemplateText = useMemo(
    () => `# doc/top-design/main.md
# Top Design Baseline

## Bounded Context
- ${normalizedContext}

## Core Anchor
- ${normalizedAnchor}

# doc/top-design/anchors.yml
version: 1
anchors:
  - id: "${normalizedAnchor}"
    title: "Core governance anchor"
    description: "Keep PR review metadata, boundary and evidence consistent."

# doc/top-design/contexts.yml
version: 1
contexts:
  - id: "${normalizedContext}"
    name: "${normalizedContext}"
    description: "Primary governance bounded context for this repository."

# doc/top-design/slices.yml
version: 1
slices:
  - id: "slice-governance-core"
    owner: "${normalizedOwner}"
    context: "${normalizedContext}"
    description: "Initial slice for governance baseline."
`,
    [normalizedAnchor, normalizedContext, normalizedOwner]
  );
  const canSubmitPr = Boolean(setupStatus?.readyForFullRefresh);
  const onboardingSteps = useMemo(
    () => [
      {
        key: 'token',
        title: '配置 GitHub Token',
        required: true,
        done: Boolean(setupStatus?.githubTokenConfigured),
      },
      {
        key: 'repo',
        title: '绑定目标仓库',
        required: true,
        done: isBindingRepoValid,
      },
      {
        key: 'topDesign',
        title: '可选：落地顶层设计依据',
        required: false,
        done: Boolean(setupStatus?.topDesign.ready),
      },
      {
        key: 'verify',
        title: '验证后开始审查',
        required: true,
        done: Boolean(setupStatus?.githubTokenConfigured) && isBindingRepoValid,
      },
    ],
    [isBindingRepoValid, setupStatus]
  );
  const requiredOnboardingSteps = useMemo(
    () => onboardingSteps.filter(x => x.required),
    [onboardingSteps]
  );
  const onboardingDoneCount = useMemo(
    () => requiredOnboardingSteps.filter(x => x.done).length,
    [requiredOnboardingSteps]
  );
  const onboardingProgressPercent = useMemo(
    () => Math.round((onboardingDoneCount / Math.max(1, requiredOnboardingSteps.length)) * 100),
    [onboardingDoneCount, requiredOnboardingSteps.length]
  );
  const canQuickOnboard = Boolean(tokenConfig?.tokenConfigured) && isBindingRepoValid;
  const canStartReviewNow = canQuickOnboard;
  const smartOnboardingActionLabel = canSubmitPr
    ? '完成接入并开始审查（含顶设）'
    : '完成接入并开始审查';
  const smartOnboardingActionHint = canSubmitPr
    ? '已包含顶层设计基线状态'
    : '将按快速接入（Step1+Step2）继续，顶设可后续完善';
  const submissionBlockReason = useMemo(() => {
    if (canStartReviewNow) {
      return '';
    }
    if (!setupStatus) {
      return '配置状态加载失败，请先点击“重新检测配置”';
    }
    if (setupStatus.guidance.length > 0) {
      return setupStatus.guidance[0];
    }
    return '请先完成新仓库接入向导后再提交 PR';
  }, [canStartReviewNow, setupStatus]);
  const touchRecentRepo = useCallback((repo: string) => {
    const normalized = repo.trim().toLowerCase();
    if (!normalized) {
      return;
    }
    setRecentRepos(prev => [normalized, ...prev.filter(x => x !== normalized)].slice(0, 12));
  }, [setRecentRepos]);
  const syncRepoWorkspaceParams = useCallback((repo: string, owner: string, context: string, anchorId: string) => {
    const normalizedRepo = repo.trim().toLowerCase();
    if (!normalizedRepo) {
      return;
    }
    setRepoWorkspaceParamsMap(prev => ({
      ...prev,
      [normalizedRepo]: {
        owner,
        context,
        anchorId,
        updatedAt: Date.now(),
      },
    }));
  }, [setRepoWorkspaceParamsMap]);

  const copyToClipboard = useCallback(async (text: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setSetupActionMessage(successMessage);
    } catch {
      setSetupActionMessage('复制失败，请手动复制下方代码块内容');
    }
  }, []);
  const downloadRepoSkillPackage = useCallback(async () => {
    if (!isBindingRepoValid) {
      setSetupActionMessage('请先填写有效仓库（owner/repo）后再导出仓库专属 Skill 包');
      return;
    }
    if (downloadFallbackUrl) {
      URL.revokeObjectURL(downloadFallbackUrl);
      setDownloadFallbackUrl(null);
    }
    setBootstrapDownloading(true);
    try {
      const res = await downloadPrReviewPrismRepoBootstrapSkill({
        repo: normalizedBindingRepo,
        owner: normalizedOwner,
        context: normalizedContext,
        anchorId: normalizedAnchor,
      });
      if (!res.success || !res.data) {
        setSetupActionMessage(res.error?.message ?? '导出 Skill 包失败');
        setBootstrapDownloading(false);
        return;
      }

      const bytes = Uint8Array.from(atob(res.data.contentBase64), c => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      setDownloadFallbackUrl(url);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.data.fileName || `pr-prism-bootstrap-skill-${normalizedBindingRepo.replace('/', '-')}.zip`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setSetupActionMessage('已触发 Skill 包下载；若浏览器拦截，请点击下方“手动下载 Skill 包”');
    } catch {
      setSetupActionMessage('导出 Skill 包失败，请稍后重试');
    } finally {
      setBootstrapDownloading(false);
    }
  }, [downloadFallbackUrl, isBindingRepoValid, normalizedAnchor, normalizedBindingRepo, normalizedContext, normalizedOwner]);

  const loadStatus = useCallback(async () => {
    const res = await getPrReviewPrismStatus();
    if (res.success && res.data?.message) {
      setHint(res.data.message);
    }
  }, []);

  const loadTokenConfigStatus = useCallback(async () => {
    const res = await getPrReviewPrismTokenConfigStatus();
    if (res.success && res.data) {
      setTokenConfig(res.data);
      return;
    }
    setTokenConfig(null);
  }, []);

  const loadSetupStatus = useCallback(async () => {
    const res = await getPrReviewPrismSetupStatus(isBindingRepoValid ? normalizedBindingRepo : undefined);
    if (res.success && res.data) {
      setSetupStatus(res.data);
      const key = normalizeRepoKey(normalizedBindingRepo || normalizedSelectedRepo);
      if (isValidRepoKey(key)) {
        setRepoSetupStatusMap(prev => ({ ...prev, [key]: res.data! }));
      }
    } else {
      setSetupStatus(null);
    }
  }, [isBindingRepoValid, normalizedBindingRepo, normalizedSelectedRepo]);

  const loadList = useCallback(
    async (
      targetPage = page,
      keyword?: string,
      targetPageSize = pageSize,
      gateStatus = activeGateFilter,
      repoFilter?: string
    ) => {
      setLoading(true);
      setListError(null);
      const res = await listPrReviewPrismSubmissions(
        targetPage,
        targetPageSize,
        keyword,
        gateStatus === 'all' ? undefined : gateStatus,
        repoFilter
      );
      if (res.success && res.data) {
        setItems(res.data.items);
        setTotal(res.data.total);
        setPage(res.data.page);
        setPageSize(res.data.pageSize);
        setGateStatusCounts({
          all:
            res.data.gateStatusCounts.completed +
            res.data.gateStatusCounts.pending +
            res.data.gateStatusCounts.missing +
            res.data.gateStatusCounts.error,
          completed: res.data.gateStatusCounts.completed,
          pending: res.data.gateStatusCounts.pending,
          missing: res.data.gateStatusCounts.missing,
          error: res.data.gateStatusCounts.error,
        });
        setSelectedId(prev => {
          if (prev && res.data.items.some(x => x.id === prev)) {
            return prev;
          }
          return res.data.items[0]?.id ?? null;
        });
      } else {
        setItems([]);
        setTotal(0);
        setGateStatusCounts({
          all: 0,
          completed: 0,
          pending: 0,
          missing: 0,
          error: 0,
        });
        setSelectedId(null);
        setListError(res.error?.message ?? '加载提交记录失败');
      }
      setLoading(false);
    },
    [activeGateFilter, page, pageSize]
  );

  useEffect(() => {
    void loadStatus();
    void loadTokenConfigStatus();
    void loadSetupStatus();
    void loadList(1, search.trim() || undefined, pageSize, activeGateFilter, normalizedSelectedRepo || undefined);
  }, [activeGateFilter, loadList, loadSetupStatus, loadStatus, loadTokenConfigStatus, normalizedSelectedRepo, pageSize, search]);

  useEffect(() => {
    setSelectedId(prev => {
      if (prev && filteredItems.some(x => x.id === prev)) {
        return prev;
      }
      return filteredItems[0]?.id ?? null;
    });
  }, [filteredItems]);
  useEffect(() => {
    const parsed = parseRepoFromPrUrl(prUrl);
    if (parsed) {
      setBindingRepoInput(parsed);
    }
  }, [prUrl]);
  useEffect(() => {
    if (isBindingRepoValid) {
      const normalized = normalizedBindingRepo.toLowerCase();
      setSelectedRepo(normalized);
      touchRecentRepo(normalized);
    }
  }, [isBindingRepoValid, normalizedBindingRepo, touchRecentRepo]);
  useEffect(() => {
    if (bindingRepoInput.trim() || normalizedSelectedRepo) {
      return;
    }
    if (selected?.repoOwner && selected.repoName) {
      const initialRepo = `${selected.repoOwner}/${selected.repoName}`.toLowerCase();
      setBindingRepoInput(initialRepo);
      setSelectedRepo(initialRepo);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(prismRepoWorkspaceStorageKey, initialRepo);
      }
    }
  }, [bindingRepoInput, normalizedSelectedRepo, selected]);
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    if (normalizedSelectedRepo) {
      window.localStorage.setItem(prismRepoWorkspaceStorageKey, normalizedSelectedRepo);
      return;
    }
    window.localStorage.removeItem(prismRepoWorkspaceStorageKey);
  }, [normalizedSelectedRepo]);
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(prismRecentReposStorageKey, JSON.stringify(recentRepos));
  }, [recentRepos]);
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(prismRepoWorkspaceParamsStorageKey, JSON.stringify(repoWorkspaceParamsMap));
  }, [repoWorkspaceParamsMap]);
  useEffect(() => {
    if (!normalizedSelectedRepo) {
      hydratedRepoRef.current = '';
      return;
    }
    if (hydratedRepoRef.current === normalizedSelectedRepo) {
      return;
    }
    const params = repoWorkspaceParamsMap[normalizedSelectedRepo];
    if (!params) {
      hydratedRepoRef.current = normalizedSelectedRepo;
      return;
    }
    hydratedRepoRef.current = normalizedSelectedRepo;
    setOwnerInput(params.owner || defaultRepoOwner);
    setContextInput(params.context || defaultRepoContext);
    setAnchorInput(params.anchorId || defaultRepoAnchorId);
  }, [normalizedSelectedRepo, repoWorkspaceParamsMap]);
  useEffect(() => {
    return () => {
      if (downloadFallbackUrl) {
        URL.revokeObjectURL(downloadFallbackUrl);
      }
    };
  }, [downloadFallbackUrl]);
  useEffect(() => {
    const activeRepo = normalizedSelectedRepo || (isBindingRepoValid ? normalizedBindingRepo.toLowerCase() : '');
    if (!activeRepo) {
      return;
    }
    syncRepoWorkspaceParams(activeRepo, normalizedOwner, normalizedContext, normalizedAnchor);
  }, [isBindingRepoValid, normalizedAnchor, normalizedBindingRepo, normalizedContext, normalizedOwner, normalizedSelectedRepo, syncRepoWorkspaceParams]);
  useEffect(() => {
    if (isBindingRepoValid) {
      setShowOnboardingWizard(true);
    }
  }, [isBindingRepoValid]);

  async function handleSearch() {
    await loadList(1, search.trim() || undefined, pageSize, activeGateFilter, normalizedSelectedRepo || undefined);
  }

  async function handleSaveToken() {
    if (savingToken) {
      return;
    }
    if (!tokenConfig?.canWrite) {
      setSetupActionMessage('当前账号缺少 settings.write 权限，无法保存 Token');
      return;
    }
    setSavingToken(true);
    const normalizedToken = tokenInput.trim();
    if (!normalizedToken && tokenConfig?.tokenConfigured && tokenConfig.source === 'environment') {
      setSetupActionMessage('当前生效的是环境变量 Token，无需在页面重复保存');
      setSavingToken(false);
      return;
    }
    const res = await updatePrReviewPrismTokenConfig(normalizedToken);
    if (!res.success || !res.data) {
      setSetupActionMessage(res.error?.message ?? '保存 Token 失败');
      setSavingToken(false);
      return;
    }
    setTokenConfig(res.data);
    setTokenInput('');
    if (!normalizedToken && tokenConfig?.tokenConfigured) {
      setSetupActionMessage('已清空页面保存的 Token（如有环境变量，系统会自动回退使用）');
    } else {
      setSetupActionMessage(res.data.tokenConfigured ? 'GitHub Token 保存成功' : '当前未检测到可用 Token');
    }
    await loadSetupStatus();
    setSavingToken(false);
  }

  async function handleSubmit() {
    const normalizedUrl = prUrl.trim();
    if (!normalizedUrl) {
      setFormError('请输入 GitHub PR 链接');
      return;
    }
    if (!/^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(normalizedUrl)) {
      setFormError('PR 链接格式错误，应为 https://github.com/{owner}/{repo}/pull/{number}');
      return;
    }

    setSubmitting(true);
    setFormError(null);
    const res = await createPrReviewPrismSubmission(normalizedUrl, note.trim() || undefined);
    if (!res.success || !res.data?.submission) {
      setFormError(res.error?.message ?? '提交失败');
      setSubmitting(false);
      return;
    }

    setPrUrl('');
    setNote('');
    const parsedRepo = parseRepoFromPrUrl(normalizedUrl);
    if (parsedRepo) {
      const nextRepo = parsedRepo.toLowerCase();
      setSelectedRepo(nextRepo);
      setBindingRepoInput(nextRepo);
      touchRecentRepo(nextRepo);
      syncRepoWorkspaceParams(nextRepo, normalizedOwner, normalizedContext, normalizedAnchor);
      setShowOnboardingWizard(false);
    }
    const submitRepoFilter = (parsedRepo ?? normalizedSelectedRepo ?? '').toLowerCase() || undefined;
    await loadList(
      1,
      search.trim() || undefined,
      pageSize,
      activeGateFilter,
      submitRepoFilter
    );
    await loadSetupStatus();
    setSelectedId(res.data.submission.id);
    setSubmitting(false);
  }

  async function handleRefresh(id: string) {
    if (batchRefreshing) {
      return;
    }
    setRefreshingId(id);
    const res = await refreshPrReviewPrismSubmission(id);
    if (res.success && res.data?.submission) {
      setItems(prev => prev.map(x => (x.id === id ? res.data!.submission : x)));
    } else {
      setListError(res.error?.message ?? '刷新失败');
    }
    setRefreshingId(null);
  }

  async function handleBatchRefreshCurrentFiltered() {
    if (batchRefreshing || loading) {
      return;
    }

    const targetIds = filteredItems.map(x => x.id);
    if (targetIds.length === 0) {
      return;
    }

    setBatchRefreshing(true);
    setListError(null);
    setBatchProgress({
      total: targetIds.length,
      done: 0,
      success: 0,
      failed: 0,
    });

    let success = 0;
    let failed = 0;
    let done = 0;
    const updateBatchProgress = () => {
      setBatchProgress({
        total: targetIds.length,
        done,
        success,
        failed,
      });
    };
    const appendBatchError = (id: string, message: string) => {
      setListError(prev => {
        if (!prev) {
          return `${id}: ${message}`;
        }
        if (prev.length > 800) {
          return `${prev.slice(0, 800)}...`;
        }
        return `${prev}; ${id}: ${message}`;
      });
    };

    const batchRes = await batchRefreshPrReviewPrismSubmissions(targetIds);
    if (batchRes.success && batchRes.data) {
      const refreshed = new Map(batchRes.data.submissions.map(x => [x.id, x]));
      setItems(prev => prev.map(x => refreshed.get(x.id) ?? x));
      success = batchRes.data.successCount;
      failed = batchRes.data.failureCount;
      done = batchRes.data.total;
      updateBatchProgress();
      if (failed > 0 && batchRes.data.failures.length > 0) {
        const topFailures = batchRes.data.failures
          .slice(0, 5)
          .map((x: PrReviewPrismBatchRefreshFailure) => `${x.id}: ${x.message}`)
          .join('; ');
        setListError(`批量刷新部分失败（${failed} 条）：${topFailures}`);
      }
      setBatchRefreshing(false);
      return;
    }

    // 兜底：如果批量接口不可用或失败，降级为逐条刷新，避免功能不可用
    for (const id of targetIds) {
      const res = await refreshPrReviewPrismSubmission(id);
      if (res.success && res.data?.submission) {
        success += 1;
        setItems(prev => prev.map(x => (x.id === id ? res.data!.submission : x)));
      } else {
        failed += 1;
        appendBatchError(id, res.error?.message ?? '刷新失败');
      }
      done += 1;
      updateBatchProgress();
    }

    if (failed > 0 && !batchRes.success) {
      setListError(prev => {
        const prefix = `批量接口失败（已降级逐条刷新）：${batchRes.error?.message ?? '未知错误'}`;
        return prev ? `${prefix}; ${prev}` : prefix;
      });
    } else if (failed > 0) {
      setListError(`批量刷新完成：成功 ${success}，失败 ${failed}`);
    }

    setBatchRefreshing(false);
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    const res = await deletePrReviewPrismSubmission(id);
    if (!res.success) {
      setListError(res.error?.message ?? '删除失败');
      setDeletingId(null);
      return;
    }
    const next = items.filter(x => x.id !== id);
    setItems(next);
    setTotal(Math.max(0, total - 1));
    if (selectedId === id) {
      setSelectedId(next[0]?.id ?? null);
    }
    if (next.length === 0 && page > 1) {
      await loadList(page - 1, search.trim() || undefined, pageSize, activeGateFilter, normalizedSelectedRepo || undefined);
    }
    setDeletingId(null);
  }

  function formatDateTime(value?: string | null) {
    if (!value) {
      return '-';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '-';
    }
    return date.toLocaleString('zh-CN', { hour12: false });
  }

  function gateBadge(item: PrReviewPrismSubmission) {
    if (item.gateStatus === 'completed') {
      if (item.gateConclusion === 'success') {
        return (
          <span className="inline-flex items-center gap-1 text-emerald-300 text-xs">
            <CheckCircle2 className="w-3.5 h-3.5" />
            L1 通过
          </span>
        );
      }
      return (
        <span className="inline-flex items-center gap-1 text-orange-300 text-xs">
          <AlertTriangle className="w-3.5 h-3.5" />
          L1 未通过
        </span>
      );
    }
    if (item.gateStatus === 'pending') {
      return (
        <span className="inline-flex items-center gap-1 text-amber-300 text-xs">
          <Clock3 className="w-3.5 h-3.5" />
          L1 进行中
        </span>
      );
    }
    if (item.gateStatus === 'missing') {
      return (
        <span className="inline-flex items-center gap-1 text-slate-300 text-xs">
          <HelpCircle className="w-3.5 h-3.5" />
          L1 缺失
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 text-red-300 text-xs">
        <AlertTriangle className="w-3.5 h-3.5" />
        刷新异常
      </span>
    );
  }

  function applyWorkspaceRepo(repo: string) {
    const normalizedRepo = normalizeRepoKey(repo);
    if (!isValidRepoKey(normalizedRepo)) {
      return;
    }
    setSelectedRepo(normalizedRepo);
    setBindingRepoInput(normalizedRepo);
    setShowOnboardingWizard(false);
    touchRecentRepo(normalizedRepo);
    const params = repoWorkspaceParamsMap[normalizedRepo];
    if (params) {
      setOwnerInput(params.owner || defaultRepoOwner);
      setContextInput(params.context || defaultRepoContext);
      setAnchorInput(params.anchorId || defaultRepoAnchorId);
      setSetupActionMessage(
        `已切换到 ${normalizedRepo}，并恢复 owner/context/anchor 参数`
      );
    } else {
      setSetupActionMessage(`已切换到 ${normalizedRepo}，该仓库暂无已保存参数`);
    }
    void loadList(1, search.trim() || undefined, pageSize, activeGateFilter, normalizedRepo);
    void loadSetupStatus();
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <button
        type="button"
        onClick={() => navigate('/')}
        className="flex items-center gap-1.5 text-sm text-white/50 hover:text-white/80 mb-6 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        返回首页
      </button>

      <div className="flex items-center gap-3 mb-4">
        <div className="w-12 h-12 rounded-xl bg-violet-500/15 flex items-center justify-center border border-violet-500/20">
          <ScanSearch className="w-6 h-6 text-violet-300" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-white">PR审查棱镜</h1>
          <p className="text-sm text-white/45 mt-0.5">PR / MR 变更专项审查（独立于产品评审员）</p>
        </div>
      </div>

      <div className="rounded-xl p-4 border border-white/10 bg-white/[0.03] text-sm text-white/60 mb-5">
        {hint}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4 mb-5">
        <div className="rounded-xl p-4 border border-white/10 bg-white/[0.03]">
          <div className="flex items-center justify-between gap-2 mb-3">
            <p className="text-sm font-medium text-white">我的仓库（可切换）</p>
            <button
              type="button"
              onClick={() => {
                setShowOnboardingWizard(true);
                setSetupActionMessage(null);
                if (normalizedSelectedRepo) {
                  setBindingRepoInput(normalizedSelectedRepo);
                }
              }}
              className="inline-flex items-center gap-1 rounded border border-violet-300/40 bg-violet-500/20 px-2 py-1 text-[11px] text-violet-100 hover:bg-violet-500/25 whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              新增仓库接入
            </button>
          </div>
          {recentRepoList.length > 0 && (
            <div className="mb-3 rounded-lg border border-white/10 bg-white/5 p-2">
              <p className="text-[11px] text-white/60 mb-1">最近仓库（快速恢复参数）</p>
              <div className="flex flex-wrap gap-1.5">
                {recentRepoList.map(repo => (
                  <button
                    key={`recent-${repo}`}
                    type="button"
                    onClick={() => applyWorkspaceRepo(repo)}
                    className={`rounded border px-2 py-1 text-[11px] whitespace-nowrap ${
                      normalizedSelectedRepo === repo
                        ? 'border-violet-400/50 bg-violet-500/15 text-violet-200'
                        : 'border-white/15 bg-white/10 text-white/80 hover:bg-white/15'
                    }`}
                    title="切换并恢复该仓库参数"
                  >
                    {repo}
                  </button>
                ))}
              </div>
            </div>
          )}
          {normalizedSelectedRepo && (
            <p className="text-[11px] text-violet-200/80 mb-2 break-all">当前仓库：{normalizedSelectedRepo}</p>
          )}
          {currentRepoParamsPreview && (
            <div className="mb-2 rounded border border-violet-400/20 bg-violet-500/10 px-2 py-1 text-[11px] text-violet-100">
              参数：owner={currentRepoParamsPreview.owner || defaultRepoOwner} / context=
              {currentRepoParamsPreview.context || defaultRepoContext} / anchor=
              {currentRepoParamsPreview.anchorId || defaultRepoAnchorId}
            </div>
          )}
          {normalizedSelectedRepo && (
            <div className="mb-2">
              <button
                type="button"
                onClick={() => {
                  setSelectedRepo('');
                  setSetupActionMessage(null);
                  void loadList(1, search.trim() || undefined, pageSize, activeGateFilter, undefined);
                  void loadSetupStatus();
                }}
                className="inline-flex items-center gap-1 rounded border border-white/20 bg-white/10 px-2 py-1 text-[11px] text-white/80 hover:bg-white/15 whitespace-nowrap"
              >
                清除仓库过滤
              </button>
            </div>
          )}
          <div className="space-y-2 max-h-72 overflow-auto pr-1">
            {visibleRepoCandidates.map(repo => (
              <button
                key={repo}
                type="button"
                onClick={() => applyWorkspaceRepo(repo)}
                className={`w-full text-left rounded-lg border px-2.5 py-2 text-xs whitespace-nowrap ${
                  (normalizedSelectedRepo || normalizedBindingRepo.toLowerCase()) === repo.toLowerCase()
                    ? 'border-violet-400/50 bg-violet-500/15 text-violet-200'
                    : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{repo}</span>
                  {(() => {
                    const repoStatus = repoSetupStatusMap[repo];
                    if (!repoStatus) {
                      return <span className="text-[10px] text-white/35 shrink-0">未检测</span>;
                    }
                    const ok = repoStatus.githubTokenConfigured && isValidRepoKey(repo);
                    return (
                      <span className={`text-[10px] shrink-0 ${ok ? 'text-emerald-200' : 'text-amber-200'}`}>
                        {ok ? '可审查' : '待接入'}
                      </span>
                    );
                  })()}
                </div>
              </button>
            ))}
            {visibleRepoCandidates.length === 0 && (
              <p className="text-xs text-white/40">暂无仓库，先提交一个 PR 链接即可加入列表。</p>
            )}
          </div>
        </div>
        <div className="rounded-xl p-4 border border-white/10 bg-white/[0.03]">
        {!showOnboardingWizard ? (
          <div className="rounded-lg border border-white/10 bg-white/5 p-4">
            <p className="text-sm font-medium text-white mb-1">新仓库接入向导</p>
            <p className="text-xs text-white/60 mb-3">
              该向导仅在新增仓库时使用。你可以在“我的仓库”中点击“新增仓库接入”打开。
            </p>
            <button
              type="button"
              onClick={() => setShowOnboardingWizard(true)}
              className="inline-flex items-center gap-1 rounded border border-violet-300/40 bg-violet-500/20 px-3 py-1.5 text-xs text-violet-100 hover:bg-violet-500/25 whitespace-nowrap"
            >
              <Plus className="w-4 h-4" />
              打开新增仓库接入向导
            </button>
          </div>
        ) : (
          <>
        <div className="flex items-center justify-between gap-3 mb-3">
          <p className="text-sm font-medium text-white">新仓库接入向导</p>
          <div className="flex items-center gap-2">
            <span className="text-xs text-white/55 whitespace-nowrap">
              {onboardingDoneCount}/{onboardingSteps.length} 已完成
            </span>
            <button
              type="button"
              onClick={() => setShowOnboardingWizard(false)}
              className="text-[11px] text-white/60 hover:text-white/90 whitespace-nowrap"
            >
              收起
            </button>
          </div>
        </div>
        <div className="mb-3 rounded-lg border border-white/10 bg-white/5 p-2">
          <div className="flex items-center justify-between text-[11px] text-white/55 px-1 mb-1">
            <span>接入进度</span>
            <span>{onboardingProgressPercent}%</span>
          </div>
          <div className="h-1.5 rounded bg-white/10 overflow-hidden">
            <div className="h-full bg-violet-400/80 transition-all" style={{ width: `${onboardingProgressPercent}%` }} />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2 mb-3">
          {onboardingSteps.map((step, idx) => (
            <div
              key={step.key}
              className={`rounded-lg border px-3 py-2 ${
                step.done
                  ? 'border-emerald-400/30 bg-emerald-500/10'
                  : 'border-amber-400/25 bg-amber-500/10'
              }`}
            >
              <p className="text-[11px] text-white/55">步骤 {idx + 1}</p>
              <p className={`text-xs mt-0.5 ${step.done ? 'text-emerald-200' : 'text-amber-100'}`}>{step.title}</p>
            </div>
          ))}
        </div>
        {setupStatus ? (
          <div className="space-y-2 text-xs">
            <div className="flex flex-wrap gap-2">
              <span
                className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${
                  setupStatus.githubTokenConfigured
                    ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
                    : 'border-red-400/30 bg-red-500/10 text-red-200'
                }`}
              >
                GitHub Token：{setupStatus.githubTokenConfigured ? '已配置' : '未配置'}
              </span>
              <span
                className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${
                  setupStatus.topDesign.ready
                    ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
                    : 'border-amber-400/30 bg-amber-500/10 text-amber-200'
                }`}
              >
                顶层设计基线：{setupStatus.topDesign.ready ? '已就绪' : '待初始化'}
              </span>
              <span
                className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${
                  canStartReviewNow
                    ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
                    : 'border-slate-400/30 bg-slate-500/10 text-slate-200'
                }`}
              >
                审查执行：{canStartReviewNow ? '可提交 PR' : '需先完成接入'}
              </span>
            </div>

            <div className="rounded-lg border border-amber-400/20 bg-amber-500/10 p-3 text-amber-100">
              <p className="font-medium mb-1">Step 1 / 4：配置 GitHub Token（仅首次需要）</p>
              <input
                type="password"
                value={tokenInput}
                onChange={e => setTokenInput(e.target.value)}
                placeholder="粘贴 GitHub Personal Access Token（ghp_xxx）"
                className="w-full mt-1 bg-black/20 border border-white/15 rounded px-2 py-1.5 text-[11px] text-amber-50 placeholder-amber-100/40 focus:outline-none focus:border-amber-300/40"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={savingToken || !tokenConfig?.canWrite}
                  onClick={() => void handleSaveToken()}
                  className="inline-flex items-center gap-1 rounded border border-violet-300/40 bg-violet-500/20 px-2.5 py-1 text-[11px] text-violet-100 hover:bg-violet-500/25 whitespace-nowrap disabled:opacity-50"
                >
                  {savingToken ? '保存中...' : '保存 Token'}
                </button>
                {tokenConfig?.canWrite && (
                  <button
                    type="button"
                    disabled={savingToken}
                    onClick={() => setTokenInput('')}
                    className="inline-flex items-center gap-1 rounded border border-white/20 bg-white/10 px-2.5 py-1 text-[11px] text-white hover:bg-white/15 whitespace-nowrap disabled:opacity-50"
                    title="清空输入框；如需清空已保存 Token，请点击保存"
                  >
                    清空输入
                  </button>
                )}
              </div>
              <p className="mt-1 text-[11px] text-amber-200/80">
                当前状态：
                {tokenConfig?.tokenConfigured ? '已配置' : '未配置'}
                {tokenConfig?.tokenMasked ? `（${tokenConfig.tokenMasked}）` : ''}
                {tokenConfig?.source
                  ? `，来源：${
                      tokenConfig.source === 'appSettings'
                        ? '页面配置'
                        : tokenConfig.source === 'environment'
                          ? '环境变量'
                          : '未配置'
                    }`
                  : ''}
              </p>
              {!!tokenConfig?.guidance?.length && (
                <ul className="list-disc ml-4 mt-1 space-y-1 text-[11px] text-amber-100">
                  {tokenConfig.guidance.map((x, idx) => (
                    <li key={`token-guidance-${idx}`}>{x}</li>
                  ))}
                </ul>
              )}

              <p className="font-medium mt-3 mb-1">Step 2 / 4：绑定目标仓库（每个新仓库都要配置）</p>
              <input
                type="text"
                value={bindingRepoInput}
                onChange={e => setBindingRepoInput(e.target.value)}
                placeholder="owner/repo 或 https://github.com/owner/repo/pull/123"
                className="w-full mt-1 bg-black/20 border border-white/15 rounded px-2 py-1.5 text-[11px] text-amber-50 placeholder-amber-100/40 focus:outline-none focus:border-amber-300/40"
              />
              {!isBindingRepoValid && (
                <p className="mt-1 text-[11px] text-amber-200/80">
                  请输入目标仓库（owner/repo）或粘贴该仓库 PR 链接，系统自动识别。
                </p>
              )}
              {isBindingRepoValid && (
                <p className="mt-1 text-[11px] text-amber-200/80">
                  当前仓库参数会自动保存，下次切回该仓库时自动恢复 owner/context/anchor。
                </p>
              )}
              <p className="mt-2 font-medium">Step 3 / 4（可选增强）：落地顶层设计依据（不阻塞接入）</p>
              <p className="mt-1 text-[11px] text-amber-200/80">
                这一步不是新仓库接入的必要条件。你可以先完成接入并开始审查，后续再持续调整该仓库的顶层设计依据。
              </p>
              <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2">
                <div>
                  <p className="text-[11px] text-amber-100/80 mb-1">仓库 owner</p>
                  <input
                    type="text"
                    value={ownerInput}
                    onChange={e => setOwnerInput(e.target.value)}
                    placeholder="your-github-id"
                    className="w-full bg-black/20 border border-white/15 rounded px-2 py-1.5 text-[11px] text-amber-50 placeholder-amber-100/40 focus:outline-none focus:border-amber-300/40"
                  />
                </div>
                <div>
                  <p className="text-[11px] text-amber-100/80 mb-1">bounded context</p>
                  <input
                    type="text"
                    value={contextInput}
                    onChange={e => setContextInput(e.target.value)}
                    placeholder="engineering-governance"
                    className="w-full bg-black/20 border border-white/15 rounded px-2 py-1.5 text-[11px] text-amber-50 placeholder-amber-100/40 focus:outline-none focus:border-amber-300/40"
                  />
                </div>
                <div>
                  <p className="text-[11px] text-amber-100/80 mb-1">anchor id</p>
                  <input
                    type="text"
                    value={anchorInput}
                    onChange={e => setAnchorInput(e.target.value)}
                    placeholder="ANCHOR-CORE-01"
                    className="w-full bg-black/20 border border-white/15 rounded px-2 py-1.5 text-[11px] text-amber-50 placeholder-amber-100/40 focus:outline-none focus:border-amber-300/40"
                  />
                </div>
              </div>
              <code className="block mt-1 rounded bg-black/25 px-2 py-1 whitespace-pre-wrap break-all">
                {repoScopedBootstrapCommand}
              </code>
              <p className="mt-2 font-medium">可选：将仓库条目写入 repo-bindings.yml（后续可随时调整）</p>
              <code className="block mt-1 rounded bg-black/25 px-2 py-1 whitespace-pre-wrap break-all">
                {repoBindingSnippet || '# 先填写 owner/repo 后生成'}
              </code>
              <p className="mt-2 font-medium">Step 4 / 4：完成接入校验并开始审查</p>
              <p className="mt-1 text-[11px] text-amber-200/80">
                说明：PR“拉取异常”与是否安装 Skill 包无直接关系；常见原因是 Token 无该仓库权限或 PR 链接不正确。
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={bootstrapDownloading}
                  onClick={() => void downloadRepoSkillPackage()}
                  className="inline-flex items-center gap-1 rounded border border-violet-300/40 bg-violet-500/20 px-2.5 py-1 text-[11px] text-violet-100 hover:bg-violet-500/25 whitespace-nowrap disabled:opacity-50"
                >
                  {bootstrapDownloading ? '导出中...' : '导出仓库专属 Skill 包'}
                </button>
                <button
                  type="button"
                  onClick={() => void loadSetupStatus()}
                  className="inline-flex items-center gap-1 rounded border border-white/20 bg-white/10 px-2.5 py-1 text-[11px] text-white hover:bg-white/15 whitespace-nowrap"
                >
                  重新检测接入状态
                </button>
                <button
                  type="button"
                  disabled={!canQuickOnboard}
                  onClick={() => {
                    if (!canQuickOnboard) {
                      setSetupActionMessage('请先完成 Step1（Token）和 Step2（仓库绑定）');
                      return;
                    }
                    setShowOnboardingWizard(false);
                    setSetupActionMessage(
                      canSubmitPr
                        ? '接入已完成（含顶设基线），可以提交 PR 审查了'
                        : '接入已完成（快速模式：Step1+Step2），可以立即提交 PR 审查'
                    );
                  }}
                  className="inline-flex items-center gap-1 rounded border border-emerald-300/40 bg-emerald-500/20 px-2.5 py-1 text-[11px] text-emerald-100 hover:bg-emerald-500/25 whitespace-nowrap disabled:opacity-50"
                >
                  {smartOnboardingActionLabel}
                </button>
                {downloadFallbackUrl && (
                  <a
                    href={downloadFallbackUrl}
                    download={`pr-prism-bootstrap-skill-${normalizedBindingRepo.replace('/', '-')}.zip`}
                    className="inline-flex items-center gap-1 rounded border border-white/20 bg-white/10 px-2.5 py-1 text-[11px] text-white hover:bg-white/15 whitespace-nowrap"
                  >
                    手动下载 Skill 包
                  </a>
                )}
              </div>
              <p className="mt-1 text-[11px] text-emerald-200/85">{smartOnboardingActionHint}</p>
              {setupActionMessage && <p className="mt-2 text-[11px] text-emerald-200">{setupActionMessage}</p>}
              {!canStartReviewNow && setupStatus.guidance.length > 0 && (
                <ul className="list-disc ml-4 mt-2 space-y-1 text-[11px] text-amber-100">
                  {setupStatus.guidance.map((x, idx) => (
                    <li key={`${idx}-${x}`}>{x}</li>
                  ))}
                </ul>
              )}
              {showDesignBasisPanel && (
                <div className="mt-3 rounded-lg border border-white/15 bg-black/20 p-3">
                  <p className="text-xs font-medium text-white mb-1">仓库级顶层设计依据（独立可调整）</p>
                  <p className="text-[11px] text-white/70 mb-2">
                    该内容与“接入向导”解耦，支持审批期间持续打磨；当前展示为该仓库的初始化版本。
                  </p>
                  <code className="block rounded bg-black/25 px-2 py-1 whitespace-pre-wrap break-all text-[11px]">
                    {topDesignBasisTemplateText}
                  </code>
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => void copyToClipboard(topDesignBasisTemplateText, '已复制顶层设计依据模板')}
                      className="inline-flex items-center gap-1 rounded border border-white/20 bg-white/10 px-2.5 py-1 text-[11px] text-white hover:bg-white/15 whitespace-nowrap"
                    >
                      复制顶层设计依据模板
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <p className="text-xs text-white/40">配置状态加载失败，请稍后重试。</p>
        )}
      </>
        )}
      </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[360px_1fr] gap-5">
        <div className="space-y-4">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-sm font-medium text-white mb-3">提交 GitHub PR</p>
            <div className="space-y-3">
              <input
                type="text"
                value={prUrl}
                onChange={e => setPrUrl(e.target.value)}
                placeholder="https://github.com/org/repo/pull/123"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-violet-500/50"
                disabled={submitting}
              />
              <input
                type="text"
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="备注（可选）"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-violet-500/50"
                disabled={submitting}
              />
              {formError && <p className="text-xs text-red-300">{formError}</p>}
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!canStartReviewNow || submitting}
                className={`w-full inline-flex items-center justify-center gap-2 rounded-lg text-white text-sm font-medium py-2.5 transition-colors disabled:opacity-60 ${
                  canStartReviewNow
                    ? 'bg-violet-600 hover:bg-violet-500'
                    : 'bg-slate-600 cursor-not-allowed'
                }`}
                title={canStartReviewNow ? '提交并拉取审查结果' : '请先完成新仓库接入向导'}
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {submitting ? '提交中...' : canStartReviewNow ? '提交并拉取' : '先完成接入向导'}
              </button>
              {!canStartReviewNow && <p className="text-[11px] text-amber-200/85">{submissionBlockReason}</p>}
            </div>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-medium text-white">提交列表</p>
              <div className="flex items-center gap-2">
                <span className="text-xs text-white/45 whitespace-nowrap">
                  总 {total} 条 / 当前页筛选 {filteredItems.length} 条
                </span>
                <button
                  type="button"
                  onClick={() => void handleBatchRefreshCurrentFiltered()}
                  disabled={loading || batchRefreshing || filteredItems.length === 0}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-white/10 bg-white/5 hover:bg-white/10 text-white/70 disabled:opacity-50 whitespace-nowrap"
                  title="按当前筛选结果批量刷新"
                >
                  {batchRefreshing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  {batchRefreshing
                    ? `批量刷新 ${batchProgress?.done ?? 0}/${batchProgress?.total ?? 0}`
                    : '批量刷新'}
                </button>
              </div>
            </div>
            <div className="flex gap-2 mb-3">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/35" />
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      void handleSearch();
                    }
                  }}
                  placeholder="搜索 repo / 标题 / 备注"
                  className="w-full bg-white/5 border border-white/10 rounded-lg pl-8 pr-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-violet-500/50"
                />
              </div>
              <button
                type="button"
                onClick={() => void handleSearch()}
                className="px-3 py-2 text-xs rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white/70"
              >
                搜索
              </button>
            </div>
            <div className="flex flex-wrap gap-2 mb-3">
              <button
                type="button"
                onClick={() => {
                  setActiveGateFilter('all');
                  void loadList(1, search.trim() || undefined, pageSize, 'all', normalizedSelectedRepo || undefined);
                }}
                className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                  activeGateFilter === 'all'
                    ? 'border-violet-400/50 bg-violet-500/15 text-violet-200'
                    : 'border-white/10 bg-white/5 text-white/65 hover:bg-white/10'
                }`}
              >
                全部 ({gateStatusCounts.all})
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveGateFilter('completed');
                  void loadList(1, search.trim() || undefined, pageSize, 'completed', normalizedSelectedRepo || undefined);
                }}
                className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                  activeGateFilter === 'completed'
                    ? 'border-violet-400/50 bg-violet-500/15 text-violet-200'
                    : 'border-white/10 bg-white/5 text-white/65 hover:bg-white/10'
                }`}
              >
                completed ({gateStatusCounts.completed})
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveGateFilter('pending');
                  void loadList(1, search.trim() || undefined, pageSize, 'pending', normalizedSelectedRepo || undefined);
                }}
                className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                  activeGateFilter === 'pending'
                    ? 'border-violet-400/50 bg-violet-500/15 text-violet-200'
                    : 'border-white/10 bg-white/5 text-white/65 hover:bg-white/10'
                }`}
              >
                pending ({gateStatusCounts.pending})
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveGateFilter('missing');
                  void loadList(1, search.trim() || undefined, pageSize, 'missing', normalizedSelectedRepo || undefined);
                }}
                className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                  activeGateFilter === 'missing'
                    ? 'border-violet-400/50 bg-violet-500/15 text-violet-200'
                    : 'border-white/10 bg-white/5 text-white/65 hover:bg-white/10'
                }`}
              >
                missing ({gateStatusCounts.missing})
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveGateFilter('error');
                  void loadList(1, search.trim() || undefined, pageSize, 'error', normalizedSelectedRepo || undefined);
                }}
                className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                  activeGateFilter === 'error'
                    ? 'border-violet-400/50 bg-violet-500/15 text-violet-200'
                    : 'border-white/10 bg-white/5 text-white/65 hover:bg-white/10'
                }`}
              >
                error ({gateStatusCounts.error})
              </button>
            </div>
            {batchProgress && (
              <div className="mb-3 rounded-md border border-white/10 bg-white/5 px-3 py-2">
                <div className="flex items-center justify-between text-[11px] text-white/60">
                  <span>
                    刷新进度 {batchProgress.done}/{batchProgress.total}
                  </span>
                  <span>
                    成功 {batchProgress.success} / 失败 {batchProgress.failed}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 rounded bg-white/10 overflow-hidden">
                  <div
                    className="h-full bg-violet-400/80 transition-all"
                    style={{ width: `${batchProgressPercent}%` }}
                  />
                </div>
              </div>
            )}
            {listError && <p className="text-xs text-red-300 mb-2">{listError}</p>}
            {loading ? (
              <div className="h-28 flex items-center justify-center">
                <Loader2 className="w-5 h-5 text-violet-300 animate-spin" />
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="h-28 flex items-center justify-center text-sm text-white/35">暂无提交记录</div>
            ) : (
              <div className="space-y-2 max-h-[520px] overflow-auto pr-1">
                {filteredItems.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedId(item.id)}
                    className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
                      selectedId === item.id
                        ? 'border-violet-400/40 bg-violet-500/10'
                        : 'border-white/10 bg-white/5 hover:bg-white/10'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm text-white truncate">
                        {item.repoOwner}/{item.repoName}#{item.pullRequestNumber}
                      </p>
                      {selectedId === item.id && <CircleDot className="w-3.5 h-3.5 text-violet-300 shrink-0" />}
                    </div>
                    <p className="text-xs text-white/40 truncate mt-1">
                      {item.pullRequestTitle || '尚未拉取标题'}
                    </p>
                    <p className="text-[11px] text-white/35 mt-1">
                      更新时间：{formatDateTime(item.updatedAt)}
                    </p>
                    <div className="mt-2">{gateBadge(item)}</div>
                  </button>
                ))}
              </div>
            )}
            <div className="mt-3 pt-3 border-t border-white/10 flex items-center justify-between gap-2">
              <div className="text-xs text-white/45">
                第 {page} / {totalPages} 页
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={pageSize}
                  onChange={e => {
                    const nextPageSize = Number(e.target.value) || 20;
                    void loadList(1, search.trim() || undefined, nextPageSize, activeGateFilter, normalizedSelectedRepo || undefined);
                  }}
                  className="bg-white/5 border border-white/10 rounded-md px-2 py-1 text-xs text-white"
                >
                  <option value={10}>10 / 页</option>
                  <option value={20}>20 / 页</option>
                  <option value={50}>50 / 页</option>
                </select>
                <button
                  type="button"
                  disabled={page <= 1 || loading}
                  onClick={() =>
                    void loadList(page - 1, search.trim() || undefined, pageSize, activeGateFilter, normalizedSelectedRepo || undefined)
                  }
                  className="px-2.5 py-1 text-xs rounded-md border border-white/10 bg-white/5 hover:bg-white/10 text-white/70 disabled:opacity-50"
                >
                  上一页
                </button>
                <button
                  type="button"
                  disabled={page >= totalPages || loading}
                  onClick={() =>
                    void loadList(page + 1, search.trim() || undefined, pageSize, activeGateFilter, normalizedSelectedRepo || undefined)
                  }
                  className="px-2.5 py-1 text-xs rounded-md border border-white/10 bg-white/5 hover:bg-white/10 text-white/70 disabled:opacity-50"
                >
                  下一页
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 min-h-[560px]">
          {!selected ? (
            <div className="h-full min-h-[420px] flex items-center justify-center text-sm text-white/35">
              请选择一条提交记录查看详情
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-white">
                    {selected.repoOwner}/{selected.repoName}#{selected.pullRequestNumber}
                  </h2>
                  <p className="text-sm text-white/55 mt-1">
                    {selected.pullRequestTitle || '暂无标题'}
                  </p>
                  <div className="mt-2">{gateBadge(selected)}</div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleRefresh(selected.id)}
                    disabled={refreshingId === selected.id || batchRefreshing}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white/75 disabled:opacity-60"
                  >
                    {refreshingId === selected.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    刷新
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(selected.id)}
                    disabled={deletingId === selected.id}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-red-400/30 bg-red-500/10 hover:bg-red-500/15 text-red-200 disabled:opacity-60"
                  >
                    {deletingId === selected.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                    删除
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="text-xs text-white/40">PR 状态</p>
                  <p className="text-sm text-white mt-1">{selected.pullRequestState}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="text-xs text-white/40">PR 作者</p>
                  <p className="text-sm text-white mt-1">{selected.pullRequestAuthor || '-'}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="text-xs text-white/40">风险分</p>
                  <p className="text-sm text-white mt-1">{selected.riskScore ?? '-'}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="text-xs text-white/40">置信度</p>
                  <p className="text-sm text-white mt-1">
                    {selected.confidencePercent != null ? `${selected.confidencePercent}%` : '-'}
                  </p>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="text-xs text-white/40">创建时间</p>
                  <p className="text-sm text-white mt-1">{formatDateTime(selected.createdAt)}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="text-xs text-white/40">最近刷新</p>
                  <p className="text-sm text-white mt-1">{formatDateTime(selected.lastRefreshedAt)}</p>
                </div>
              </div>

              <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                <p className="text-xs text-white/40 mb-1">决策建议</p>
                <p className="text-sm text-white/85">{selected.decisionSuggestion || '暂无'}</p>
              </div>

              {selected.note && (
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="text-xs text-white/40 mb-1">备注</p>
                  <p className="text-sm text-white/85">{selected.note}</p>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="text-xs text-white/40 mb-2">阻断项</p>
                  {selected.blockers.length === 0 ? (
                    <p className="text-sm text-white/55">无</p>
                  ) : (
                    <ul className="list-disc ml-4 space-y-1 text-sm text-white/85">
                      {selected.blockers.map((x, idx) => (
                        <li key={`${idx}-${x}`}>{x}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="text-xs text-white/40 mb-2">风险建议</p>
                  {selected.advisories.length === 0 ? (
                    <p className="text-sm text-white/55">无</p>
                  ) : (
                    <ul className="list-disc ml-4 space-y-1 text-sm text-white/85">
                      {selected.advisories.map((x, idx) => (
                        <li key={`${idx}-${x}`}>{x}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="text-xs text-white/40 mb-2">架构师关注问题</p>
                  {selected.focusQuestions.length === 0 ? (
                    <p className="text-sm text-white/55">无</p>
                  ) : (
                    <ol className="list-decimal ml-4 space-y-1 text-sm text-white/85">
                      {selected.focusQuestions.map((x, idx) => (
                        <li key={`${idx}-${x}`}>{x}</li>
                      ))}
                    </ol>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <a
                  href={selected.pullRequestUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white/75"
                >
                  PR 链接
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
                {selected.gateDetailsUrl && (
                  <a
                    href={selected.gateDetailsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white/75"
                  >
                    L1 Gate 详情
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
                {selected.decisionCardCommentUrl && (
                  <a
                    href={selected.decisionCardCommentUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white/75"
                  >
                    决策卡评论
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>

              {selected.lastRefreshError && (
                <div className="rounded-lg border border-red-400/25 bg-red-500/10 p-3 text-sm text-red-200">
                  最近刷新错误：{selected.lastRefreshError}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
