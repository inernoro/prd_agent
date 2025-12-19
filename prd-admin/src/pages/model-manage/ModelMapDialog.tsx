import { Dialog } from '@/components/ui/Dialog';
import type { Model, Platform } from '@/types/admin';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/cn';

type NodeKey = 'main' | 'intent' | 'vision' | 'imageGen' | 'embedding' | 'rerank';

type NodeInfo = {
  key: NodeKey;
  label: string; // 展示：主/意图/识图/生图/嵌入/重排
  modelText: string; // 展示：模型名（单行，可横向滚动）
  title: string; // hover 全量
  tone: 'gold' | 'green' | 'blue' | 'purple' | 'cyan' | 'amber' | 'muted';
};

function pickMainModel(models: Model[], platforms: Platform[], selectedPlatformId?: string | null) {
  const byPlatform = (pid: string) => models.filter((m) => m.platformId === pid);
  if (selectedPlatformId && selectedPlatformId !== '__all__') {
    const ms = byPlatform(selectedPlatformId);
    return ms.find((m) => m.isMain) ?? ms.find((m) => m.enabled) ?? ms[0] ?? null;
  }
  const p0 = platforms.find((p) => p.enabled) ?? platforms[0] ?? null;
  if (p0) {
    const ms = byPlatform(p0.id);
    return ms.find((m) => m.isMain) ?? ms.find((m) => m.enabled) ?? ms[0] ?? null;
  }
  return models.find((m) => m.isMain) ?? models.find((m) => m.enabled) ?? models[0] ?? null;
}

function pickByFlag(models: Model[], flag: 'isIntent' | 'isVision' | 'isImageGen') {
  if (flag === 'isIntent') return models.find((m) => Boolean(m.isIntent)) ?? null;
  if (flag === 'isVision') return models.find((m) => Boolean(m.isVision)) ?? null;
  return models.find((m) => Boolean(m.isImageGen)) ?? null;
}

function pickByRegex(models: Model[], re: RegExp) {
  const enabled = models.filter((m) => m.enabled);
  return enabled.find((m) => re.test((m.modelName || '').toLowerCase()))
    ?? enabled.find((m) => re.test((m.name || '').toLowerCase()))
    ?? null;
}

function getPlatformName(platforms: Platform[], platformId?: string | null) {
  if (!platformId || platformId === '__all__') return '全部';
  return platforms.find((p) => p.id === platformId)?.name ?? '平台';
}

export function ModelMapDialog({
  open,
  onOpenChange,
  models,
  platforms,
  selectedPlatformId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: Model[];
  platforms: Platform[];
  selectedPlatformId: string;
}) {
  // 让 CSS 动画每次打开都能重播
  const [playSeed, setPlaySeed] = useState(0);
  useEffect(() => {
    if (open) setPlaySeed((s) => s + 1);
  }, [open]);

  const nodes = useMemo<NodeInfo[]>(() => {
    const scopeModels =
      selectedPlatformId && selectedPlatformId !== '__all__'
        ? models.filter((m) => m.platformId === selectedPlatformId)
        : models;

    const main = pickMainModel(models, platforms, selectedPlatformId);
    const intent = pickByFlag(models, 'isIntent');
    const vision = pickByFlag(models, 'isVision');
    const imageGen = pickByFlag(models, 'isImageGen');
    const embedding = pickByRegex(scopeModels, /(embed|embedding)/);
    const rerank = pickByRegex(scopeModels, /(rerank|re-rank)/);

    const pName = getPlatformName(platforms, selectedPlatformId);

    const nameOf = (m: Model | null) => (m ? (m.name || m.modelName || '未命名') : '未配置');
    const titleOf = (m: Model | null) => (m ? `${m.name} (${m.modelName})` : '未配置');

    const mainText = main ? `${pName}:${nameOf(main)}` : `${pName}:未配置`;
    const mainTitle = main ? `${pName} · ${titleOf(main)}` : `${pName} · 未配置`;

    const intentText = intent ? nameOf(intent) : (main ? `回退:${nameOf(main)}` : '未配置');
    const intentTitle = intent ? titleOf(intent) : (main ? `未设置意图模型，回退到主模型：${titleOf(main)}` : '未配置');

    return [
      { key: 'main', label: '主', modelText: mainText, title: mainTitle, tone: 'gold' },
      { key: 'intent', label: '意图', modelText: intentText, title: intentTitle, tone: intent ? 'green' : (main ? 'muted' : 'muted') },
      { key: 'vision', label: '识图', modelText: nameOf(vision), title: titleOf(vision), tone: vision ? 'blue' : 'muted' },
      { key: 'imageGen', label: '生图', modelText: nameOf(imageGen), title: titleOf(imageGen), tone: imageGen ? 'purple' : 'muted' },
      { key: 'embedding', label: '嵌入', modelText: nameOf(embedding), title: titleOf(embedding), tone: embedding ? 'cyan' : 'muted' },
      { key: 'rerank', label: '重排', modelText: nameOf(rerank), title: titleOf(rerank), tone: rerank ? 'amber' : 'muted' },
    ];
  }, [models, platforms, selectedPlatformId]);

  const nodeByKey = useMemo(() => {
    const map = new Map<NodeKey, NodeInfo>();
    for (const n of nodes) map.set(n.key, n);
    return map;
  }, [nodes]);

  const TypeIcon = ({ k }: { k: NodeKey }) => {
    // 轻量内联 SVG：避免依赖/避免五角星审美问题
    if (k === 'main') {
      return (
        <svg className="model-map-icon" viewBox="0 0 100 100" aria-hidden="true">
          <path d="M50 10 L88 78 L12 78 Z" fill="none" stroke="currentColor" strokeWidth="10" strokeLinejoin="round" strokeLinecap="round" />
          <path d="M50 90 L12 22 L88 22 Z" fill="none" stroke="currentColor" strokeWidth="10" strokeLinejoin="round" strokeLinecap="round" opacity="0.8" />
        </svg>
      );
    }
    if (k === 'intent') {
      return (
        <svg className="model-map-icon" viewBox="0 0 100 100" aria-hidden="true">
          <path d="M50 8 L60 40 L92 50 L60 60 L50 92 L40 60 L8 50 L40 40 Z" fill="currentColor" opacity="0.92" />
        </svg>
      );
    }
    if (k === 'vision') {
      return (
        <svg className="model-map-icon" viewBox="0 0 100 100" aria-hidden="true">
          <path d="M8 52 C18 28, 36 18, 50 18 C64 18, 82 28, 92 52 C82 76, 64 86, 50 86 C36 86, 18 76, 8 52 Z" fill="none" stroke="currentColor" strokeWidth="10" />
          <circle cx="50" cy="52" r="12" fill="currentColor" opacity="0.9" />
        </svg>
      );
    }
    if (k === 'imageGen') {
      return (
        <svg className="model-map-icon" viewBox="0 0 100 100" aria-hidden="true">
          <rect x="14" y="22" width="72" height="56" rx="10" fill="none" stroke="currentColor" strokeWidth="10" />
          <path d="M26 66 L44 48 L58 60 L70 50 L82 66" fill="none" stroke="currentColor" strokeWidth="10" strokeLinejoin="round" strokeLinecap="round" opacity="0.9" />
        </svg>
      );
    }
    if (k === 'embedding') {
      return (
        <svg className="model-map-icon" viewBox="0 0 100 100" aria-hidden="true">
          <path d="M22 34 H78" stroke="currentColor" strokeWidth="10" strokeLinecap="round" />
          <path d="M22 52 H78" stroke="currentColor" strokeWidth="10" strokeLinecap="round" opacity="0.9" />
          <path d="M22 70 H78" stroke="currentColor" strokeWidth="10" strokeLinecap="round" opacity="0.8" />
          <circle cx="30" cy="34" r="6" fill="currentColor" />
          <circle cx="46" cy="52" r="6" fill="currentColor" opacity="0.92" />
          <circle cx="70" cy="70" r="6" fill="currentColor" opacity="0.86" />
        </svg>
      );
    }
    // rerank
    return (
      <svg className="model-map-icon" viewBox="0 0 100 100" aria-hidden="true">
        <path d="M32 18 V82" stroke="currentColor" strokeWidth="10" strokeLinecap="round" opacity="0.9" />
        <path d="M68 18 V82" stroke="currentColor" strokeWidth="10" strokeLinecap="round" opacity="0.9" />
        <path d="M32 18 L18 34" stroke="currentColor" strokeWidth="10" strokeLinecap="round" />
        <path d="M32 18 L46 34" stroke="currentColor" strokeWidth="10" strokeLinecap="round" />
        <path d="M68 82 L54 66" stroke="currentColor" strokeWidth="10" strokeLinecap="round" />
        <path d="M68 82 L82 66" stroke="currentColor" strokeWidth="10" strokeLinecap="round" />
      </svg>
    );
  };

  const Node = ({ k, pos, delayMs }: { k: NodeKey; pos: string; delayMs: number }) => {
    const n = nodeByKey.get(k)!;
    return (
      <div
        className={cn('model-map-node', `tone-${n.tone}`, pos)}
        style={{ ['--mm-delay' as any]: `${delayMs}ms` }}
        title={n.title}
      >
        <div className="model-map-anchor">
          <div className="model-map-dot" aria-hidden="true" />
          <div className="model-map-chip" aria-label={`${n.label}：${n.modelText}`}>
            <TypeIcon k={k} />
            <span className="model-map-type">{n.label}</span>
            <span className="model-map-sep">·</span>
            <div
              className="model-map-name"
              title={n.modelText}
              onWheel={(e) => {
                const el = e.currentTarget;
                if (el.scrollWidth <= el.clientWidth) return;
                // 鼠标滚轮通常只有纵向：把 deltaY 映射为横向滚动（更符合用户直觉）
                if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                  e.preventDefault();
                  el.scrollLeft += e.deltaY;
                }
              }}
            >
              {n.modelText}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="模型地图"
      description="六芒星视图：各能力位点当前选择的模型（名称超长可横向滚动）"
      maxWidth={920}
      contentStyle={{ height: 'min(82vh, 720px)' }}
      contentClassName="model-map-dialog"
      content={
        <div key={playSeed} className="h-full min-h-0 flex flex-col">
          <div className="model-map-stage flex-1 min-h-0">
            <div className="model-map-frame">
              {/* 六芒星：几何描边（避免五角星） */}
              <svg
                className="model-map-svg"
                viewBox="0 0 100 100"
                role="img"
                aria-label="模型六芒星地图"
              >
                {/* 上三角 */}
                <path className="model-map-line line-a" d="M50 8 L90 78 L10 78 Z" />
                {/* 下三角 */}
                <path className="model-map-line line-b" d="M50 92 L10 22 L90 22 Z" />
              </svg>

              {/* 六个角位 */}
              <Node k="main" delayMs={820} pos="pos-top" />
              <Node k="intent" delayMs={900} pos="pos-top-right" />
              <Node k="vision" delayMs={980} pos="pos-bottom-right" />
              <Node k="imageGen" delayMs={1060} pos="pos-bottom" />
              <Node k="embedding" delayMs={1140} pos="pos-bottom-left" />
              <Node k="rerank" delayMs={1220} pos="pos-top-left" />
            </div>
          </div>

          <div className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
            提示：模型名超长时可在节点内左右滚动查看（保持单行不换行）。
          </div>
        </div>
      }
    />
  );
}

