/**
 * SkillDownloadDialog — CDS 技能包下载弹窗（3 Tab）
 *
 * 把 ProjectListPage 右上角「下载技能包」从直链改成弹窗，给三种取技能的方式：
 *   1. 技能口令（推荐）—— 给 AI 的提示词，让 AI 自己 fetch 当前 CDS 域名的
 *      `/api/export-skill` 解压到 `~/.claude/skills/`。
 *   2. 海鲜市场 —— 跳转到 PrdAgent 海鲜市场，让用户从市场找带 CDS 标签的技能包。
 *   3. 技能压缩包 —— 保留原有 tar.gz 直接下载（`/api/export-skill`）。
 *
 * 设计要点：
 *  - 主题：所有颜色走 `hsl(var(--*))` token，禁止暗色字面量（`.claude/rules/cds-theme-tokens.md`）
 *  - 模态：基于 shadcn `Dialog`（Radix 自动满足 portal + min-h:0 + ESC 三硬约束）
 *  - 默认 Tab："技能口令"，因为它是零摩擦最顺的路径（AI 帮你装）
 */
import { useMemo, useState } from 'react';
import { Check, Copy, Download, ExternalLink, KeyRound, Package, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const MARKETPLACE_URL = 'https://miduo.org/marketplace?type=skill&keyword=cds';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type TabKey = 'token' | 'marketplace' | 'zip';

const TABS: Array<{ key: TabKey; label: string; icon: typeof KeyRound; recommended?: boolean }> = [
  { key: 'token', label: '技能口令', icon: KeyRound, recommended: true },
  { key: 'marketplace', label: '海鲜市场', icon: Sparkles },
  { key: 'zip', label: '技能压缩包', icon: Package },
];

export function SkillDownloadDialog({ open, onOpenChange }: Props): JSX.Element {
  const [active, setActive] = useState<TabKey>('token');

  // 组装 AI 口令（带当前 CDS 域名，AI 收到就能直接下）
  const cdsOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://<your-cds-host>';
  const aiPrompt = useMemo(
    () =>
      [
        '帮我装一下 CDS 技能包（cds + cds-deploy-pipeline + cds-project-scan）。',
        '',
        `下载地址：${cdsOrigin}/api/export-skill`,
        '装法：下载到本地 → 解压 tar.gz → 把里面的 .claude/skills/* 全部放到我项目根目录的 .claude/skills/ 下。',
        '',
        '装好后我会用这些技能让你扫项目、推 CDS 部署、跑分层冒烟测试。',
      ].join('\n'),
    [cdsOrigin],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>装上 CDS 技能包</DialogTitle>
          <DialogDescription>
            CDS 技能让 AI 能扫描项目、自动部署、跑冒烟测试。三种方式按你顺手挑一个，**技能口令最省事**
            ——把一段话粘给 AI，它会自己下载、解压、装好。
          </DialogDescription>
        </DialogHeader>

        {/* 横向 Tab 条 */}
        <nav className="flex gap-1 border-b border-[hsl(var(--hairline))]">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = active === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActive(tab.key)}
                className={`relative inline-flex h-10 shrink-0 items-center gap-2 px-3 text-sm transition-colors ${
                  isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className="h-4 w-4" />
                <span>{tab.label}</span>
                {tab.recommended ? (
                  <span className="rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    推荐
                  </span>
                ) : null}
                {isActive ? <span className="absolute inset-x-2 bottom-0 h-px bg-primary" /> : null}
              </button>
            );
          })}
        </nav>

        <div className="min-h-[220px]">
          {active === 'token' ? <TokenTab prompt={aiPrompt} /> : null}
          {active === 'marketplace' ? <MarketplaceTab /> : null}
          {active === 'zip' ? <ZipTab /> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ----------------------------------------------------------------------------
// Tab 1: 技能口令
// ----------------------------------------------------------------------------

function TokenTab({ prompt }: { prompt: string }): JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // 浏览器禁用了 clipboard 时就什么都不做（用户还能手动选中复制）
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        把下面这段话粘到你的 AI 助手（Claude Code、Cursor、Codex 都行）的对话框里。AI 会按提示自己下载并装好。
      </p>

      <div className="cds-surface-raised cds-hairline relative rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3">
        <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words pr-12 font-mono text-xs leading-relaxed text-foreground" style={{ overscrollBehavior: 'contain' }}>
{prompt}
        </pre>
        <Button
          size="sm"
          variant={copied ? 'default' : 'outline'}
          className="absolute right-2 top-2"
          onClick={() => void handleCopy()}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? '已复制' : '复制'}
        </Button>
      </div>

      <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] px-3 py-2 text-xs text-muted-foreground">
        <div className="font-semibold text-foreground">这是什么</div>
        <div className="mt-1">
          口令里写明了下载地址（你当前的 CDS 域名）和解压目标路径。AI 拿到后会用 curl/wget 抓 tar.gz、解到
          `~/.claude/skills/`。这条路径下次升级还能直接覆盖（不影响你的 ~/.cdsrc）。
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Tab 2: 海鲜市场
// ----------------------------------------------------------------------------

function MarketplaceTab(): JSX.Element {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        海鲜市场是 PrdAgent 的技能集市，可以搜更多别人发布的技能（不止 CDS）。点下面按钮跳转，搜索关键词已经预填为「cds」。
      </p>

      <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] px-4 py-3">
        <div className="text-xs text-muted-foreground">跳转地址</div>
        <div className="mt-1 break-all font-mono text-xs text-foreground">{MARKETPLACE_URL}</div>
      </div>

      <Button asChild>
        <a href={MARKETPLACE_URL} target="_blank" rel="noreferrer">
          <ExternalLink className="h-4 w-4" />
          打开海鲜市场
        </a>
      </Button>

      <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] px-3 py-2 text-xs text-muted-foreground">
        <div className="font-semibold text-foreground">市场版本说明</div>
        <div className="mt-1 leading-relaxed">
          海鲜市场上每个技能有版本号（语义化 X.Y.Z），同名技能默认只保留最新一份。如果你已经从 CDS 装过同名技能，
          海鲜市场覆盖时建议先看一眼版本号——更新就装、更旧就跳过，避免本地多份不一致。
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Tab 3: 技能压缩包
// ----------------------------------------------------------------------------

function ZipTab(): JSX.Element {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        直接下载当前 CDS 实例打包好的技能 tar.gz，里面含 `cds`、`cds-deploy-pipeline`、`cds-project-scan` 三个技能。
      </p>

      <Button asChild>
        <a href="/api/export-skill" download>
          <Download className="h-4 w-4" />
          下载 tar.gz
        </a>
      </Button>

      <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground">
        <div className="text-foreground"># 解压并安装到项目根</div>
        <div>tar -xzf cds-skills-*.tar.gz --strip-components=1</div>
        <div className="mt-1">{'# 解出来的 .claude/skills/* 会落到当前目录的 .claude/skills/'}</div>
      </div>

      <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] px-3 py-2 text-xs text-muted-foreground">
        <div className="font-semibold text-foreground">同名覆盖提示</div>
        <div className="mt-1 leading-relaxed">
          解压会覆盖 `.claude/skills/` 下同名技能目录。如果担心丢自定义改动，先备份：
          <code className="ml-1 rounded bg-[hsl(var(--surface-sunken))] px-1.5 py-0.5 font-mono">
            cp -r .claude/skills/cds .claude/skills/cds.bak
          </code>
        </div>
      </div>
    </div>
  );
}
