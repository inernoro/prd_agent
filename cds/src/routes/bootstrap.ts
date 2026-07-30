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
import { SkillProxy, SkillProxyError, isSafeSkillKey, readCappedBody } from '../services/skill-proxy.js';

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
    audience: '产品经理、业务专家、需求专家或非技术团队主导的新项目',
    summary: '装齐方法论套装与 CDS 技能，随后由 sdd-init 生成协作规则、文档骨架和新人引导路线图。',
    marketplaceKeys: ['skill-validation', 'risk-matrix'],
    includeCdsSkills: true,
    nextStep: '/sdd-init',
  },
  {
    key: 'dev-project',
    label: '开发项目底座',
    audience: '开发主导的新项目',
    summary: '装齐开发方法论套装与 CDS 技能，随后由 sdd-init 生成协作规则与文档骨架。',
    marketplaceKeys: ['skill-validation', 'risk-matrix'],
    includeCdsSkills: true,
    nextStep: '/sdd-init',
  },
  {
    key: 'qa-project',
    label: '测试与验收底座',
    audience: '测试或验收主导的项目',
    summary: '装齐验收设计、场景编排、真人清单与浏览器取证归档，随后由 sdd-init 落地骨架。',
    marketplaceKeys: [
      'acceptance-test-design',
      'acceptance-scenario-orchestrator',
      'acceptance-checklist',
      'create-visual-test-to-kb',
    ],
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
async function buildCdsSkillPack(skillsRoot: string): Promise<Buffer | null> {
  // 必须五个齐全才认本地包：少一个就是半成品，客户装完会缺部署或预览命令，
  // 而且脚本看到合法的 skills/ 目录就认为装好了，不会再回源上游。宁可回源。
  const present = CDS_SKILL_KEYS.filter((k) => fs.existsSync(path.join(skillsRoot, k)));
  if (present.length !== CDS_SKILL_KEYS.length) return null;

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

/**
 * 技能内容签名：五个技能目录里所有文件的数量与最新 mtime。
 * 只 stat 不读内容，够便宜；技能一改签名就变，缓存自然失效。
 */
async function skillPackSignature(skillsRoot: string): Promise<string> {
  let files = 0;
  let newest = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      files += 1;
      const st = await fs.promises.stat(p);
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
  };
  for (const key of CDS_SKILL_KEYS) {
    const dir = path.join(skillsRoot, key);
    if (fs.existsSync(dir)) await walk(dir);
  }
  return `${files}:${Math.round(newest)}`;
}

/**
 * 带缓存与单飞的 CDS 技能包。
 *
 * 为什么必须缓存：这个端点是匿名的（客户拿到凭据之前就要能装），CDS 全局没有
 * 限流中间件。每次请求都递归 cp 一遍技能树再 spawn 一个 tar，匿名并发就能把
 * CPU、进程槽和临时盘吃干净。缓存 + 单飞把「每请求一次构建」变成「内容变了才
 * 构建一次」，并发请求共享同一次构建，天然封住这条放大路径。
 */
export class CdsSkillPackCache {
  private cached: { signature: string; body: Buffer } | null = null;
  private inflight: Promise<Buffer | null> | null = null;

  async get(skillsRoot: string): Promise<{ body: Buffer; cached: boolean } | null> {
    const signature = await skillPackSignature(skillsRoot);
    if (this.cached && this.cached.signature === signature) {
      return { body: this.cached.body, cached: true };
    }
    if (!this.inflight) {
      this.inflight = buildCdsSkillPack(skillsRoot)
        .then((body) => {
          if (body) this.cached = { signature, body };
          return body;
        })
        .finally(() => { this.inflight = null; });
    }
    const body = await this.inflight;
    return body ? { body, cached: false } : null;
  }
}

export const cdsSkillPackCache = new CdsSkillPackCache();

/** CDS 技能包的体积上限：本体只有几百 KB，10 MB 已经是三个数量级的余量。 */
const UPSTREAM_PACK_MAX_BYTES = 10 * 1024 * 1024;
/** 上游回源超时：客户在等一条命令跑完，不能无限期挂着。 */
const UPSTREAM_PACK_TIMEOUT_MS = 60_000;
/** 上游副本的缓存时长。上游技能包变动很慢，短缓存足以吸收突发。 */
const UPSTREAM_PACK_TTL_MS = 10 * 60_000;


/**
 * 上游 CDS 技能包的缓存 + 单飞。
 *
 * 自托管实例没有本地技能树时，**每个**匿名请求都会走这条回源分支。此前它既无
 * 超时也无体积上限、更没有缓存或单飞：上游一旦卡住或返回超大响应，并发调用方
 * 就能把连接和堆一起吃干净。本地分支的 CdsSkillPackCache 保护不到这里。
 */
/**
 * 上游返回的字节是不是 gzip（技能包是 .tar.gz）。
 *
 * 与 skill-proxy 的 looksLikeZip 同一件事、同一个理由：不校验的话，网关故障期
 * 常见的「200 + HTML 错误页」会被当成技能包缓存住，客户侧 tar 解不开，且上游
 * 恢复后仍要等缓存过期才自愈。魔数只挡「根本不是 gzip」，完整性由 tar 兜底。
 */
export function looksLikeGzip(buf: Buffer): boolean {
  return buf.byteLength >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

class UpstreamSkillPackCache {
  private cached: { body: Buffer; at: number } | null = null;
  private inflight: Promise<Buffer> | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  async get(url: string): Promise<{ body: Buffer; cached: boolean }> {
    const age = this.cached ? this.now() - this.cached.at : Number.POSITIVE_INFINITY;
    // age >= 0 守时钟回拨：负龄期不能当成「新鲜」，否则缓存永不失效
    if (this.cached && age >= 0 && age < UPSTREAM_PACK_TTL_MS) {
      return { body: this.cached.body, cached: true };
    }
    if (!this.inflight) {
      this.inflight = (async () => {
        const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(UPSTREAM_PACK_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await readCappedBody(res, UPSTREAM_PACK_MAX_BYTES);
        if (body.byteLength === 0) throw new Error('上游返回空内容');
        // 入缓存前认一下，避免把错误页缓存成技能包（见 looksLikeGzip 注释）
        if (!looksLikeGzip(body)) throw new Error('上游返回的不是 tar.gz（可能是错误页）');
        this.cached = { body, at: this.now() };
        return body;
      })().finally(() => { this.inflight = null; });
    }
    return { body: await this.inflight, cached: false };
  }
}

export const upstreamSkillPackCache = new UpstreamSkillPackCache();
export const __upstreamPackLimitsForTest = {
  maxBytes: UPSTREAM_PACK_MAX_BYTES,
  timeoutMs: UPSTREAM_PACK_TIMEOUT_MS,
  ttlMs: UPSTREAM_PACK_TTL_MS,
};
export { UpstreamSkillPackCache };

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
SKILLS_DIRS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --skills-dir) SKILLS_DIRS="\${2:-}"; shift 2 ;;
    --skills-dir=*) SKILLS_DIRS="\${1#*=}"; shift ;;
    -h|--help)
      echo "用法: sh bootstrap.sh [--skills-dir \"<目录> [目录...]\"]"
      echo "不指定时装到当前项目所有存在的 Agent 技能目录（.claude / .cursor / .agents）。"
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

# ── 2. 探测技能目录（项目级，存在几个宿主就装几个）───────────────────
# 装到项目级而不是用户级：技能跟着对方的 git 走，全队 clone 下来都有。
# 装到用户主目录的话，人一走团队什么都不剩。
#
# 为什么装到「所有存在的宿主」而不是「第一个命中的」：一个仓库可能同时装了
# 多个 Agent（本仓库就同时有 .claude 和 .agents）。取第一个命中的话，从 Codex
# 跑这个脚本会装进 .claude/skills，而 Codex 只读 .agents/skills —— 装完了一个
# 技能都看不见。多装一份的代价是几百 KB 重复文件，比装了看不见小得多。
# 想只装一个目录用 --skills-dir 显式指定。
if [ -z "$SKILLS_DIRS" ]; then
  for h in .claude .cursor .agents; do
    [ -d "$h" ] && SKILLS_DIRS="$SKILLS_DIRS $h/skills"
  done
  [ -n "$SKILLS_DIRS" ] || SKILLS_DIRS=".agents/skills"
fi
for d in $SKILLS_DIRS; do mkdir -p "$d"; done
say "技能目录:$SKILLS_DIRS"

# 把一个已解压的技能目录复制到全部宿主目录。
install_skill() {
  _src="$1"; _name="$2"
  for _d in $SKILLS_DIRS; do
    rm -rf "$_d/$_name"
    cp -R "$_src" "$_d/$_name"
  done
  installed="$installed $_name"
}

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

installed=""
skipped=""

# ── 3. CDS 技能包（本实例优先，取不到时回退到上游公共 CDS）───────────
if [ "$INCLUDE_CDS_SKILLS" = "1" ]; then
  cds_pack="$TMP_DIR/cds-skills.tar.gz"
  got=""
  # 「下到了」不等于「下对了」：本实例可能 200 回一个 HTML 代理错误页或半截包。
  # 所以校验放在循环内 —— 校验不过就换下一个源，而不是认定它成功、到循环外
  # 才被 tar 失败 + set -e 打死，白白放着健康的上游不用。
  for base in "$CDS_ORIGIN" "$CDS_UPSTREAM"; do
    [ -n "$base" ] || continue
    # 走匿名的 cds-pack 端点：客户在拿到任何 CDS 凭据之前就得装上 cdscli，
    # 否则连「运行 connect 申请授权」都做不了。/api/export-skill 需要登录，用不了。
    curl -fsSL --max-time 120 -o "$cds_pack" "$base/api/skills/cds-pack/download" 2>/dev/null || continue
    # 先只列表不解压：能列出来才是合法 tar.gz
    tar -tzf "$cds_pack" >/dev/null 2>&1 || continue
    rm -rf "$TMP_DIR/skills"
    tar -xzf "$cds_pack" -C "$TMP_DIR" 2>/dev/null || continue
    # 直接用固定布局，不要 find -maxdepth：那是 GNU 扩展，macOS 的 BSD find 上
    # 行为不一致，配合 set -e 会让脚本在解压成功后当场退出、一个技能都没装。
    # 这个包的结构由 CDS 自己产出，恒为 skills/<key>/。
    [ -d "$TMP_DIR/skills" ] || continue
    got="$base"; break
  done
  if [ -n "$got" ]; then
    for d in "$TMP_DIR/skills"/*/; do
      [ -d "$d" ] || continue
      install_skill "$d" "$(basename "$d")"
    done
    say "已安装 CDS 技能包 (来源 $got)"
  else
    skipped="$skipped cds-skills(所有来源都取不到可用技能包)"
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
  if ! unzip -qo "$zip_path" -d "$extract_dir"; then
    skipped="$skipped $key(解压失败)"
    continue
  fi
  for d in "$extract_dir"/*/; do
    [ -d "$d" ] || continue
    install_skill "$d" "$(basename "$d")"
  done
  say "已安装套装 $key"
done

# ── 5. 记录种子（sdd-init 读它判断预设与上下文）─────────────────────
mkdir -p .cds
cat > .cds/bootstrap.json <<JSON
{
  "preset": "$PRESET",
  "cdsHost": "$CDS_ORIGIN",
  "skillsDirs": "$SKILLS_DIRS",
  "installedSkills": "$installed",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

# ── 6. 告诉用户下一步（不是「安装完成」四个字了事）──────────────────
# 只要有必需包没装上就以非零码退出：半装的项目不能被当成装好了继续往下走，
# 否则 CI / 一键脚本会静默带着残缺技能集跑下去。
echo ""
if [ -n "$skipped" ]; then
  echo "[初始化] 安装未完成。技能目录:$SKILLS_DIRS" >&2
  [ -n "$installed" ] && echo "  已安装:$installed" >&2
  echo "  未安装:$skipped" >&2
  echo "" >&2
  echo "  上面这些是本预设的必需包，缺了功能不完整。" >&2
  echo "  检查网络（能否访问 \${CDS_ORIGIN}）后重新运行本脚本即可补齐，已装的会跳过重复下载之外的副作用。" >&2
  exit 1
fi

say "安装完成。技能目录:$SKILLS_DIRS"
[ -n "$installed" ] && echo "  已安装:$installed"
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
        const hit = await cdsSkillPackCache.get(skillsRoot);
        if (hit) {
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Content-Disposition', 'attachment; filename="cds-skills.tar.gz"');
          res.setHeader('X-Skill-Cache', hit.cached ? 'local-cached' : 'local');
          res.type('application/gzip').send(hit.body);
          return;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[bootstrap] 本地打包 CDS 技能失败，尝试回源上游', { error: String(err) });
      }
    }

    const upstream = `${deps.cdsUpstream.replace(/\/+$/, '')}/api/skills/cds-pack/download`;
    try {
      const hit = await upstreamSkillPackCache.get(upstream);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition', 'attachment; filename="cds-skills.tar.gz"');
      res.setHeader('X-Skill-Cache', hit.cached ? 'upstream-cached' : 'upstream');
      res.type('application/gzip').send(hit.body);
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
