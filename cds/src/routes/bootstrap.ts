/**
 * 项目初始化（Project Bootstrap）路由。
 *
 * 解决的问题：帮别人从零建项目时，对方接不进 MAP，但所有人都要上 CDS。
 * CDS 天然是那个中介 —— 这里提供「一条命令」，真的把 CDS 技能包 + 方法论
 * 套装装进对方项目，而不是给一段让 AI 自己想办法的提示词。
 *
 * 全部端点匿名可访问：客户在拿到任何凭据之前就要能装技能。真正需要授权的
 * 是 CDS 项目绑定，那一步仍走页面批准，不因为这里匿名而放宽。
 *
 * 详见 doc/design.cds.project-bootstrap.md。
 */
import { Router } from 'express';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { SkillProxy, SkillProxyError, isSafeSkillKey } from '../services/skill-proxy.js';

const execFileAsync = promisify(execFile);

/** CDS 自己的技能：操作 CDS 必需，缺一个就等于装了个半成品。 */
const CDS_SKILL_KEYS = ['cds', 'cds-project-scan', 'cds-deploy-pipeline', 'cds-release', 'preview-url'] as const;

export interface BootstrapPreset {
  key: string;
  label: string;
  audience: string;
  summary: string;
  /** 走 MAP 代理安装的技能或套装 key（按顺序装）。 */
  marketplaceKeys: string[];
  /** 是否安装 CDS 自己的 5 个技能。 */
  includeCdsSkills: boolean;
  /** 装完之后用户该对 AI 说的第一句话。 */
  nextStep: string;
}

export const BOOTSTRAP_PRESETS: readonly BootstrapPreset[] = [
  {
    key: 'pm-project',
    label: '产品经理项目底座',
    audience: '产品经理、老板或非技术团队主导的新项目',
    summary: '装齐方法论套装与 CDS 技能，随后由 sdd-init 生成协作规则、文档骨架和新人引导路线图。',
    marketplaceKeys: ['pm-starter'],
    includeCdsSkills: true,
    nextStep: '/sdd-init',
  },
  {
    key: 'cds-only',
    label: '仅接入 CDS',
    audience: '已有自己工作方法、只想要云端预览的团队',
    summary: '只装 CDS 的五个技能，不带任何方法论约定。',
    marketplaceKeys: [],
    includeCdsSkills: true,
    nextStep: '让 AI 运行 cdscli connect 完成项目授权',
  },
] as const;

export function findPreset(key: string): BootstrapPreset | undefined {
  return BOOTSTRAP_PRESETS.find((p) => p.key === key);
}

export interface BootstrapRouterDeps {
  skillProxy: SkillProxy;
  /** 上游公共 CDS，供自托管实例在本地技能目录缺失时兜底取 CDS 技能包。 */
  cdsUpstream: string;
  /** CDS 仓库根，用于定位 `.claude/skills`。 */
  repoRoot: string;
}

/** 定位 CDS 技能源目录；CDS 部署为子目录时回退到父级。 */
function resolveSkillsRoot(repoRoot: string): string | null {
  for (const candidate of [
    path.join(repoRoot, '.claude', 'skills'),
    path.join(repoRoot, '..', '.claude', 'skills'),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 打包 CDS 自己的 5 个技能为 tar.gz。
 *
 * 为什么需要这个而不是复用已有的 `/api/export-skill`：那个端点要登录。
 * 客户在拿到任何 CDS 凭据之前就得装上 cdscli 和 preview-url，否则连
 * 「运行 connect 申请授权」这一步都做不了 —— 鸡生蛋问题。
 * 内容是技能说明与 CLI 源码（同款内容早已在海鲜市场公开），不含任何凭据。
 */
async function packCdsSkills(skillsRoot: string): Promise<Buffer | null> {
  const present = CDS_SKILL_KEYS.filter((k) => fs.existsSync(path.join(skillsRoot, k)));
  if (present.length === 0) return null;

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cds-skill-pack-'));
  try {
    const stageDir = path.join(tmpDir, 'skills');
    await fs.promises.mkdir(stageDir, { recursive: true });
    for (const key of present) {
      await fs.promises.cp(path.join(skillsRoot, key), path.join(stageDir, key), { recursive: true });
    }
    const outFile = path.join(tmpDir, 'cds-skills.tar.gz');
    await execFileAsync('tar', ['-czf', outFile, '-C', tmpDir, 'skills']);
    return await fs.promises.readFile(outFile);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** shell 单引号转义：把 `'` 换成 `'\''`，杜绝生成脚本被注入。 */
function shq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * 生成引导脚本。
 *
 * 纪律（.claude/rules/quickstart-zero-friction.md）：依赖自检要一次扫完并给
 * 平台特定命令，不能报一个错退出让用户自己搜。
 *
 * 硬约束：不含任何密钥；不改 shell profile、PATH 或用户主目录；重复执行幂等
 * （覆盖技能目录，不碰 AGENTS.md 等用户文件 —— 那是 sdd-init 的职责）。
 */
export function buildBootstrapScript(preset: BootstrapPreset, cdsOrigin: string, cdsUpstream: string): string {
  const origin = cdsOrigin.replace(/\/+$/, '');
  const upstream = cdsUpstream.replace(/\/+$/, '');
  const marketplaceList = preset.marketplaceKeys.join(' ');

  return `#!/bin/sh
# CDS 项目初始化脚本 — 预设: ${preset.key}
# 由 ${origin} 生成。本脚本不含任何密钥，也不会修改你的 shell 配置、PATH 或用户主目录。
# 它只往当前项目目录写入技能文件。重复执行是安全的。
set -eu

CDS_ORIGIN=${shq(origin)}
CDS_UPSTREAM=${shq(upstream)}
PRESET=${shq(preset.key)}
MARKETPLACE_KEYS=${shq(marketplaceList)}
INCLUDE_CDS_SKILLS=${preset.includeCdsSkills ? '1' : '0'}
SKILLS_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --skills-dir) SKILLS_DIR="\${2:-}"; shift 2 ;;
    --skills-dir=*) SKILLS_DIR="\${1#*=}"; shift ;;
    -h|--help)
      echo "用法: sh bootstrap.sh [--skills-dir <目录>]"
      echo "不指定时自动识别当前项目的 Agent 技能目录。"
      exit 0 ;;
    *) echo "未知参数: $1"; exit 2 ;;
  esac
done

say() { echo "[初始化] $1"; }
fail() { echo "[初始化] 失败: $1" >&2; exit 1; }

# ── 1. 依赖自检（一次扫完，缺什么就给对应平台的安装命令）──────────────
missing=""
for cmd in curl unzip tar; do
  command -v "$cmd" >/dev/null 2>&1 || missing="$missing $cmd"
done
if [ -n "$missing" ]; then
  echo "[初始化] 缺少这些命令:$missing" >&2
  echo "" >&2
  echo "  Ubuntu / Debian:  sudo apt-get install -y$missing" >&2
  echo "  CentOS / RHEL:    sudo yum install -y$missing" >&2
  echo "  macOS:            brew install$missing" >&2
  echo "" >&2
  fail "请先安装上面缺少的命令，然后重新运行本脚本。"
fi

# ── 2. 探测技能目录（默认项目级）─────────────────────────────────────
# 装到项目级而不是用户级：技能跟着对方的 git 走，全队 clone 下来都有。
# 装到用户主目录的话，人一走团队什么都不剩。
if [ -z "$SKILLS_DIR" ]; then
  if [ -d ".claude" ]; then SKILLS_DIR=".claude/skills"
  elif [ -d ".cursor" ]; then SKILLS_DIR=".cursor/skills"
  else SKILLS_DIR=".agents/skills"
  fi
fi
mkdir -p "$SKILLS_DIR"
say "技能目录: $SKILLS_DIR"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

installed=""
skipped=""

# ── 3. CDS 技能包（本实例优先，取不到时回退到上游公共 CDS）───────────
if [ "$INCLUDE_CDS_SKILLS" = "1" ]; then
  cds_pack="$TMP_DIR/cds-skills.tar.gz"
  got=""
  for base in "$CDS_ORIGIN" "$CDS_UPSTREAM"; do
    [ -n "$base" ] || continue
    # 走匿名的 cds-pack 端点：客户在拿到任何 CDS 凭据之前就得装上 cdscli，
    # 否则连「运行 connect 申请授权」都做不了。/api/export-skill 需要登录，用不了。
    if curl -fsSL --max-time 120 -o "$cds_pack" "$base/api/skills/cds-pack/download" 2>/dev/null; then
      got="$base"; break
    fi
  done
  if [ -n "$got" ]; then
    tar -xzf "$cds_pack" -C "$TMP_DIR"
    pack_skills=$(find "$TMP_DIR" -type d -name skills -maxdepth 3 | head -n 1)
    if [ -n "$pack_skills" ]; then
      for d in "$pack_skills"/*/; do
        [ -d "$d" ] || continue
        name=$(basename "$d")
        rm -rf "$SKILLS_DIR/$name"
        cp -R "$d" "$SKILLS_DIR/$name"
        installed="$installed $name"
      done
      say "已安装 CDS 技能包 (来源 $got)"
    else
      skipped="$skipped cds-skills(技能包结构异常)"
    fi
  else
    skipped="$skipped cds-skills(下载失败)"
  fi
fi

# ── 4. 方法论套装（走 CDS 代理，内容事实源在 MAP）─────────────────────
for key in $MARKETPLACE_KEYS; do
  zip_path="$TMP_DIR/$key.zip"
  if ! curl -fsSL --max-time 180 -o "$zip_path" "$CDS_ORIGIN/api/skills/$key/download"; then
    skipped="$skipped $key(下载失败)"
    continue
  fi
  extract_dir="$TMP_DIR/x-$key"
  mkdir -p "$extract_dir"
  unzip -qo "$zip_path" -d "$extract_dir"
  for d in "$extract_dir"/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    rm -rf "$SKILLS_DIR/$name"
    cp -R "$d" "$SKILLS_DIR/$name"
    installed="$installed $name"
  done
  say "已安装套装 $key"
done

# ── 5. 记录种子（sdd-init 读它判断预设与上下文）─────────────────────
mkdir -p .cds
cat > .cds/bootstrap.json <<JSON
{
  "preset": "$PRESET",
  "cdsHost": "$CDS_ORIGIN",
  "skillsDir": "$SKILLS_DIR",
  "installedSkills": "$installed",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

# ── 6. 告诉用户下一步（不是「安装完成」四个字了事）──────────────────
echo ""
say "安装完成。技能目录: $SKILLS_DIR"
[ -n "$installed" ] && echo "  已安装:$installed"
if [ -n "$skipped" ]; then
  echo "  未安装:$skipped" >&2
  echo "  上面这些没装上，功能会不完整。检查网络后重新运行本脚本即可补齐。" >&2
fi
echo ""
echo "下一步: 在当前目录打开你的 AI 编程工具，输入"
echo ""
echo "    ${preset.nextStep}"
echo ""
`;
}

export function createBootstrapRouter(deps: BootstrapRouterDeps): Router {
  const router = Router();

  /** 解析对外可见的 CDS 地址，供脚本内嵌；优先反代头，兜底请求 host。 */
  const resolveOrigin = (req: import('express').Request): string => {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || req.protocol || 'https';
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return host ? `${proto}://${host}` : deps.cdsUpstream;
  };

  router.get('/bootstrap/presets', (_req, res) => {
    res.json({
      presets: BOOTSTRAP_PRESETS.map((p) => ({
        key: p.key,
        label: p.label,
        audience: p.audience,
        summary: p.summary,
        marketplaceKeys: p.marketplaceKeys,
        includeCdsSkills: p.includeCdsSkills,
        nextStep: p.nextStep,
      })),
    });
  });

  router.get('/bootstrap/:preset', (req, res) => {
    const preset = findPreset(String(req.params.preset || ''));
    if (!preset) {
      res.status(404).type('text/plain; charset=utf-8')
        .send(`# 未知预设: ${req.params.preset}\n# 可用预设见 ${resolveOrigin(req)}/api/bootstrap/presets\n`);
      return;
    }
    const script = buildBootstrapScript(preset, resolveOrigin(req), deps.cdsUpstream);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `inline; filename="cds-bootstrap-${preset.key}.sh"`);
    res.type('text/x-shellscript; charset=utf-8').send(script);
  });

  /**
   * CDS 技能包（匿名）。本地技能目录缺失时（自托管实例不带 CDS 源码）
   * 回源到上游公共 CDS 的同名端点。
   */
  router.get('/skills/cds-pack/download', async (_req, res) => {
    const skillsRoot = resolveSkillsRoot(deps.repoRoot);
    if (skillsRoot) {
      try {
        const body = await packCdsSkills(skillsRoot);
        if (body) {
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Content-Disposition', 'attachment; filename="cds-skills.tar.gz"');
          res.setHeader('X-Skill-Cache', 'local');
          res.type('application/gzip').send(body);
          return;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[bootstrap] 本地打包 CDS 技能失败，尝试回源上游', { error: String(err) });
      }
    }

    const upstream = `${deps.cdsUpstream.replace(/\/+$/, '')}/api/skills/cds-pack/download`;
    try {
      const upstreamRes = await fetch(upstream, { method: 'GET' });
      if (!upstreamRes.ok) throw new Error(`HTTP ${upstreamRes.status}`);
      const body = Buffer.from(await upstreamRes.arrayBuffer());
      if (body.byteLength === 0) throw new Error('上游返回空内容');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition', 'attachment; filename="cds-skills.tar.gz"');
      res.setHeader('X-Skill-Cache', 'upstream');
      res.type('application/gzip').send(body);
    } catch (err) {
      res.status(502).json({
        error: '无法获取 CDS 技能包',
        hint: '本实例没有本地技能目录，上游 CDS 也不可达。方法论技能仍可安装，但操作 CDS 的命令行技能会缺失。',
      });
    }
  });

  router.get('/skills/bundles', async (_req, res) => {
    try {
      res.json(await deps.skillProxy.fetchBundles());
    } catch (err) {
      const e = err as SkillProxyError;
      res.status(e.status || 502).json({ error: e.message, hint: e.hint });
    }
  });

  router.get('/skills/:key/download', async (req, res) => {
    const key = String(req.params.key || '');
    if (!isSafeSkillKey(key)) {
      res.status(400).json({ error: '技能名不合法', hint: '技能名只能是小写字母、数字和连字符。' });
      return;
    }
    try {
      const result = await deps.skillProxy.fetchSkill(key);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition', `attachment; filename="${key}.zip"`);
      // 陈旧标记必须透出：调用方要能如实告诉用户「用的是本地缓存版本」
      res.setHeader('X-Skill-Cache', result.stale ? 'stale' : result.source);
      res.type(result.contentType).send(result.body);
    } catch (err) {
      const e = err as SkillProxyError;
      res.status(e.status || 502).json({ error: e.message, hint: e.hint });
    }
  });

  return router;
}
