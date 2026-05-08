/**
 * SkillDownloadDialog — CDS 技能包下载弹窗（3 Tab + 完整接入引导）
 *
 * 把 ProjectListPage 右上角「下载技能包」从直链改成弹窗，给三种取技能的方式：
 *   1. 技能口令（推荐）—— 给 AI 的提示词，含三步：下载 → 单版本去重 → 接入 CDS
 *   2. 海鲜市场 —— 跳转到 PrdAgent 海鲜市场，让用户从市场找带 CDS 标签的技能包
 *   3. 技能压缩包 —— 保留原有 tar.gz 直接下载（`/api/export-skill`）
 *
 * 设计要点：
 *  - 主题：所有颜色走 `hsl(var(--*))` token，禁止暗色字面量（`.claude/rules/cds-theme-tokens.md`）
 *  - 模态：基于 shadcn `Dialog`（Radix 自动满足 portal + min-h:0 + ESC 三硬约束）
 *  - 默认 Tab："技能口令"，因为它是零摩擦最顺的路径（AI 帮你装）
 *  - AI 提示词把「下载 + 去重 + 接入」三步串起来，避免用户装完不知道下一步
 *  - 单版本去重原则：同名技能 SKILL.md frontmatter 里读 version，新>旧才覆盖，
 *    新==旧跳过，新<旧拒绝降级（保持本地永远只有一份当前版本，不允许多版本共存）
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

  // 组装 AI 口令（带当前 CDS 域名 + 版本去重指令 + 接入引导）
  const cdsOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://<your-cds-host>';
  const aiPrompt = useMemo(
    () =>
      [
        '帮我装一下 CDS 技能包(cds + cds-deploy-pipeline + cds-project-scan)。按下面三步走。',
        '',
        '【步骤 1 - 下载】',
        `从 ${cdsOrigin}/api/export-skill 下载 tar.gz。`,
        '',
        '【步骤 2 - 单版本去重安装】',
        '解压前对每个同名技能(cds / cds-deploy-pipeline / cds-project-scan)做版本检查:',
        '  - 读 ~/.claude/skills/<name>/SKILL.md 的 frontmatter `version: X.Y.Z`(如果文件存在)',
        '  - 跟新包里同路径的 SKILL.md version 比较(语义化版本):',
        '      新版本 > 旧版本: 备份旧的到 ~/.claude/skills/<name>.bak.<timestamp>/, 然后覆盖',
        '      新版本 == 旧版本: 跳过(已是最新)',
        '      新版本 < 旧版本: 不要覆盖, 提示我"本地版本更新, 是否强制降级?"',
        '本机每个技能名只能有一份当前版本, 禁止多版本共存。',
        '',
        '【步骤 3 - 接入 CDS】',
        '装好后告诉我:',
        '  "技能已装好。请去 CDS 项目卡上点钥匙图标签发项目级 Agent Key,',
        '   把 CDS_HOST / CDS_PROJECT_ID / CDS_PROJECT_KEY 三行粘给我, 我跑 cdscli init 接入。"',
        '',
        '【这个技能能干啥】',
        '让你能扫描我的项目结构、生成 CDS docker-compose YAML、推送部署到 CDS 灰度环境、',
        '等待容器就绪、跑分层冒烟测试、容器报错时自动诊断根因。',
      ].join('\n'),
    [cdsOrigin],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>装上 CDS 技能包</DialogTitle>
          <DialogDescription>
            CDS 技能让 AI 能扫描项目、自动部署、跑冒烟测试。三种方式按你顺手挑一个,
            技能口令最省事——把一段话粘给 AI,它会自己下载、解压、装好,还会告诉你下一步去哪拿密钥。
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

        <div className="min-h-[260px]">
          {active === 'token' ? <TokenTab prompt={aiPrompt} /> : null}
          {active === 'marketplace' ? <MarketplaceTab /> : null}
          {active === 'zip' ? <ZipTab /> : null}
        </div>

        {/* 跨 Tab 共享:下一步引导(永远显示,因为三种装法都需要拿 Agent Key 才能让 AI 真用上) */}
        <NextStepGuidance />
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
      // 浏览器禁用了 clipboard 时就什么都不做(用户还能手动选中复制)
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        把下面这段话粘到你的 AI 助手(Claude Code、Cursor、Codex 都行)的对话框里。
        AI 会按三步走:下载 → 版本对齐(单版本去重)→ 提示你去取 Agent Key 接入。
      </p>

      <div className="cds-surface-raised cds-hairline relative rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3">
        <pre
          className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words pr-12 font-mono text-xs leading-relaxed text-foreground"
          style={{ overscrollBehavior: 'contain' }}
        >
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
        <div className="font-semibold text-foreground">为什么要做版本去重</div>
        <div className="mt-1 leading-relaxed">
          你可能从 CDS、海鲜市场、压缩包多个渠道装过同名技能。如果不去重,本机就会留下多个版本,
          AI 调用时不知道用哪个。这条口令让 AI 比较 SKILL.md 里的版本号,只保留当前最新一份。
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
        海鲜市场是 PrdAgent 的技能集市,可以搜更多别人发布的技能(不止 CDS)。点下面按钮跳转,搜索关键词已经预填为「cds」。
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
          海鲜市场每个技能带版本号(语义化 X.Y.Z),同名技能默认只保留最新一份。
          如果你已经从 CDS 装过同名技能,海鲜市场覆盖前先用「技能口令」Tab 的提示词让 AI 比对版本——
          新就装、旧就跳过,本机永远只有一份。
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
        直接下载当前 CDS 实例打包好的技能 tar.gz,里面含 cds、cds-deploy-pipeline、cds-project-scan 三个技能。
      </p>

      <Button asChild>
        <a href="/api/export-skill" download>
          <Download className="h-4 w-4" />
          下载 tar.gz
        </a>
      </Button>

      <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground">
        <div className="text-foreground"># 1. 解压</div>
        <div>tar -xzf cds-skills-*.tar.gz --strip-components=1</div>
        <div className="mt-1 text-foreground"># 2. 拷贝到 ~/.claude/skills/(覆盖前请先比对版本号)</div>
        <div>cp -rn .claude/skills/* ~/.claude/skills/</div>
      </div>

      <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] px-3 py-2 text-xs text-muted-foreground">
        <div className="font-semibold text-foreground">同名覆盖提示(单版本原则)</div>
        <div className="mt-1 leading-relaxed">
          手动覆盖前先看 ~/.claude/skills/&lt;name&gt;/SKILL.md 的 version 字段——比新包里的版本旧才覆盖,
          否则会把更新的版本盖掉。担心丢自定义改动可先备份:
          <code className="ml-1 rounded bg-[hsl(var(--surface-sunken))] px-1.5 py-0.5 font-mono">
            cp -r ~/.claude/skills/cds ~/.claude/skills/cds.bak
          </code>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// 跨 Tab 共享:下一步引导(下载只是第一步,要让 AI 真用上 CDS 还需要 Agent Key)
// ----------------------------------------------------------------------------

function NextStepGuidance(): JSX.Element {
  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 px-4 py-3">
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="space-y-1.5 text-xs leading-relaxed text-muted-foreground">
          <div className="text-sm font-semibold text-foreground">下一步:让 AI 接入到 CDS</div>
          <div>
            技能装好后 AI 还需要凭据才能调 CDS。回到项目卡片
            → 点钥匙图标签发<span className="font-medium text-foreground">「项目级 Agent Key」</span>
            → 复制 CDS_HOST / CDS_PROJECT_ID / CDS_PROJECT_KEY 三行 → 粘给 AI 让它跑
            <code className="mx-1 rounded bg-[hsl(var(--surface-sunken))] px-1.5 py-0.5 font-mono text-foreground">
              cdscli init
            </code>
            。之后 AI 就能自动部署/扫描/冒烟。
          </div>
          <div className="text-[11px] opacity-80">
            提示:跨项目自动化(创建项目、批量操作)需要走右上角「全局 Agent Key」,权限更高。
          </div>
        </div>
      </div>
    </div>
  );
}
