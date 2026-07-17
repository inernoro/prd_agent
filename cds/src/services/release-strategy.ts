import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  BranchEntry,
  Project,
  ReleaseExecutionMode,
  ReleaseProjectIdentity,
  ReleaseRun,
  ReleaseStrategy,
  ReleaseTarget,
} from '../types.js';
import { shellQuote } from './sidecar/sidecar-deployer.js';

export interface ReleaseStrategyCandidate {
  mode: ReleaseExecutionMode;
  label: string;
  description: string;
  confidence: 'high' | 'medium' | 'manual';
  strategy: ReleaseStrategy;
  requirements: string[];
}

export interface ReleaseStrategyDiscovery {
  projectIdentity: ReleaseProjectIdentity;
  branchId: string;
  branchName: string;
  recommendedMode: ReleaseExecutionMode | null;
  candidates: ReleaseStrategyCandidate[];
  warnings: string[];
  scannedAt: string;
}

const SCRIPT_CANDIDATES = [
  './exec_dep.sh',
  './fast.sh',
  './deploy.sh',
  './scripts/deploy.sh',
  './scripts/release.sh',
];

const COMPOSE_CANDIDATES = [
  'cds-compose.yml',
  'cds-compose.yaml',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
];

const STATIC_DIRECTORIES = ['dist', 'build', 'out', 'public'];

export function releaseProjectIdentity(project: Project): ReleaseProjectIdentity {
  return {
    projectId: project.id,
    projectSlug: project.slug,
    repository: project.githubRepoFullName || sanitizeRepository(project.gitRepoUrl),
  };
}

export function normalizeRepositoryIdentity(value?: string): string {
  const raw = value?.trim();
  if (!raw) return '';
  const scpLike = raw.match(/^[^@\s]+@[^:\s]+:(.+)$/);
  let repositoryPath = scpLike?.[1] || raw;
  if (!scpLike) {
    try {
      const url = new URL(raw);
      repositoryPath = url.pathname;
    } catch {
      repositoryPath = raw;
    }
  }
  return repositoryPath
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

export function discoverReleaseStrategies(project: Project, branch: BranchEntry): ReleaseStrategyDiscovery {
  const root = path.resolve(branch.worktreePath);
  const candidates: ReleaseStrategyCandidate[] = [];
  const warnings: string[] = [];
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return {
      projectIdentity: releaseProjectIdentity(project),
      branchId: branch.id,
      branchName: branch.branch,
      recommendedMode: null,
      candidates: [],
      warnings: [`分支工作区不存在，无法自动检测: ${root}`],
      scannedAt: new Date().toISOString(),
    };
  }

  const scripts = SCRIPT_CANDIDATES.filter((candidate) => fs.existsSync(path.join(root, candidate.replace(/^\.\//, ''))));
  if (scripts.length > 0) {
    const command = scripts.includes('./fast.sh') && scripts.includes('./exec_dep.sh')
      ? './fast.sh && ./exec_dep.sh'
      : scripts[0];
    candidates.push({
      mode: 'existing-script',
      label: '项目现有脚本',
      description: `复用仓库中已存在的 ${scripts.join('、')}`,
      confidence: 'high',
      strategy: { mode: 'existing-script', command, detectedFrom: scripts },
      requirements: ['远端发布目录是该项目的 Git 仓库', '脚本具备可执行权限'],
    });
  }

  const composeFile = COMPOSE_CANDIDATES.find((candidate) => fs.existsSync(path.join(root, candidate)));
  if (composeFile) {
    candidates.push({
      mode: 'generated-compose',
      label: 'CDS 生成 Compose 发布脚本',
      description: `项目无需发布脚本，CDS 按 ${composeFile} 为每个 commit 建立隔离 worktree 并更新服务`,
      confidence: 'high',
      strategy: {
        mode: 'generated-compose',
        composeFile,
        composeProject: shellSafeName(`${project.slug}-prod`),
        detectedFrom: [composeFile],
      },
      requirements: ['远端已安装 Git、Docker、Docker Compose 与 Python 3', '远端发布目录是该项目的 Git 仓库'],
    });
  }

  const packageJson = readPackageJson(root);
  const buildCommand = detectBuildCommand(root, packageJson);
  const artifactDirectory = detectArtifactDirectory(root, packageJson);
  if (buildCommand || artifactDirectory) {
    candidates.push({
      mode: 'generated-static',
      label: 'CDS 生成静态站发布脚本',
      description: '项目无需发布脚本，CDS 构建后离线校验入口资源，再原子切换 current 并保留 previous',
      confidence: buildCommand && artifactDirectory ? 'medium' : 'manual',
      strategy: {
        mode: 'generated-static',
        buildCommand: buildCommand || '',
        artifactDirectory: artifactDirectory || 'dist',
        publicDirectory: `/opt/${project.slug}-web`,
        detectedFrom: [
          ...(packageJson ? ['package.json'] : []),
          ...(artifactDirectory ? [artifactDirectory] : []),
        ],
      },
      requirements: ['远端已安装 Git、Bash、Python 3 与项目构建依赖', 'Web Server 根目录指向 publicDirectory/current'],
    });
  }

  if (candidates.length === 0) {
    warnings.push('未发现发布脚本、Compose 文件或静态构建信号，需要手动选择策略并补齐参数。');
  }
  const recommended = candidates.find((candidate) => candidate.mode === 'existing-script')
    || candidates.find((candidate) => candidate.mode === 'generated-compose')
    || candidates.find((candidate) => candidate.mode === 'generated-static');
  return {
    projectIdentity: releaseProjectIdentity(project),
    branchId: branch.id,
    branchName: branch.branch,
    recommendedMode: recommended?.mode || null,
    candidates,
    warnings,
    scannedAt: new Date().toISOString(),
  };
}

export function effectiveReleaseStrategy(target: ReleaseTarget): ReleaseStrategy {
  if (target.strategy) return target.strategy;
  return { mode: 'existing-script', command: target.ssh?.deployCommand || '' };
}

export function validateReleaseStrategy(strategy: ReleaseStrategy): string | null {
  if (strategy.mode === 'existing-script') {
    return strategy.command?.trim() ? null : 'existing-script strategy requires command';
  }
  if (strategy.mode === 'generated-compose') {
    if (!isSafeRelativePath(strategy.composeFile || '')) return 'composeFile must be a safe relative path';
    if (!strategy.composeProject?.trim() || shellSafeName(strategy.composeProject) !== strategy.composeProject) {
      return 'composeProject must contain only lowercase letters, digits, hyphen and underscore';
    }
    return null;
  }
  if (!strategy.buildCommand?.trim()) return 'generated-static strategy requires buildCommand';
  if (!isSafeRelativePath(strategy.artifactDirectory || '')) return 'artifactDirectory must be a safe relative path';
  if (!isSafePublicDirectory(strategy.publicDirectory || '')) {
    return 'publicDirectory must be a non-system absolute directory with at least two path segments';
  }
  return null;
}

export function buildReleaseExecution(target: ReleaseTarget, run: ReleaseRun): {
  mode: ReleaseExecutionMode;
  command: string;
  scriptSha256: string;
  summary: string;
} {
  const strategy = effectiveReleaseStrategy(target);
  const validation = validateReleaseStrategy(strategy);
  if (validation) throw new Error(validation);
  if (strategy.mode === 'existing-script') {
    const command = strategy.command!.trim();
    return {
      mode: strategy.mode,
      command,
      scriptSha256: sha256(command),
      summary: `执行项目现有发布命令: ${command}`,
    };
  }
  const script = strategy.mode === 'generated-compose'
    ? generatedComposeScript(strategy)
    : generatedStaticScript(strategy);
  return {
    mode: strategy.mode,
    command: `printf %s ${shellQuote(Buffer.from(script, 'utf8').toString('base64'))} | base64 -d | bash`,
    scriptSha256: sha256(script),
    summary: strategy.mode === 'generated-compose'
      ? `CDS 动态生成 Compose 发布脚本，配置 ${strategy.composeFile}`
      : `CDS 动态生成静态发布脚本，产物 ${strategy.artifactDirectory}，线上根 ${strategy.publicDirectory}/current`,
  };
}

export function buildStrategyPreflightCommand(target: ReleaseTarget): string {
  if (!target.ssh) throw new Error('target is not SSH');
  const strategy = effectiveReleaseStrategy(target);
  if (strategy.mode === 'existing-script') return '';
  const repo = shellQuote(target.ssh.appPath);
  const base = `test -d ${repo} && git -C ${repo} rev-parse --is-inside-work-tree >/dev/null && command -v base64 >/dev/null && command -v bash >/dev/null && command -v python3 >/dev/null`;
  if (strategy.mode === 'generated-compose') {
    return `${base} && command -v docker >/dev/null && docker compose version >/dev/null && test -f ${shellQuote(path.posix.join(target.ssh.appPath, strategy.composeFile!))}`;
  }
  return `${base} && command -v python3 >/dev/null && mkdir -p ${shellQuote(strategy.publicDirectory!)}`;
}

function generatedComposeScript(strategy: ReleaseStrategy): string {
  return `#!/usr/bin/env bash
set -Eeuo pipefail
: "\${CDS_COMMIT_SHA:?CDS_COMMIT_SHA is required}"
: "\${CDS_RELEASE_ID:?CDS_RELEASE_ID is required}"
: "\${CDS_TARGET_ID:?CDS_TARGET_ID is required}"
repo="$PWD"
repo_parent="$(dirname "$repo")"
release_root="$repo_parent/.cds-releases/$CDS_TARGET_ID"
worktree="$release_root/worktrees/$CDS_RELEASE_ID"
mkdir -p "$release_root/worktrees"
git -C "$repo" fetch --all --prune
git -C "$repo" cat-file -e "$CDS_COMMIT_SHA^{commit}"
if [ ! -d "$worktree" ]; then git -C "$repo" worktree add --detach "$worktree" "$CDS_COMMIT_SHA"; fi
test -f "$worktree/${strategy.composeFile}"
docker compose -p ${shellQuote(strategy.composeProject!)} -f "$worktree/${strategy.composeFile}" up -d --build --remove-orphans
if [ -L "$release_root/current" ]; then ln -sfn "$(readlink "$release_root/current")" "$release_root/previous"; fi
rm -f "$release_root/current.next"
ln -s "$worktree" "$release_root/current.next"
python3 -c 'import os, sys; os.replace(sys.argv[1], sys.argv[2])' "$release_root/current.next" "$release_root/current"
printf 'release_id=%s\ncommit=%s\nmode=generated-compose\n' "$CDS_RELEASE_ID" "$CDS_COMMIT_SHA"
`;
}

function generatedStaticScript(strategy: ReleaseStrategy): string {
  return `#!/usr/bin/env bash
set -Eeuo pipefail
: "\${CDS_COMMIT_SHA:?CDS_COMMIT_SHA is required}"
: "\${CDS_RELEASE_ID:?CDS_RELEASE_ID is required}"
: "\${CDS_TARGET_ID:?CDS_TARGET_ID is required}"
repo="$PWD"
publish_root=${shellQuote(strategy.publicDirectory!)}
repo_parent="$(dirname "$repo")"
worktree_root="$repo_parent/.cds-releases/$CDS_TARGET_ID/worktrees"
worktree="$worktree_root/$CDS_RELEASE_ID"
version="$publish_root/.releases/$CDS_RELEASE_ID"
mkdir -p "$worktree_root" "$publish_root/.releases"
chmod 755 "$publish_root" "$publish_root/.releases"
git -C "$repo" fetch --all --prune
git -C "$repo" cat-file -e "$CDS_COMMIT_SHA^{commit}"
if [ ! -d "$worktree" ]; then git -C "$repo" worktree add --detach "$worktree" "$CDS_COMMIT_SHA"; fi
cd "$worktree"
${strategy.buildCommand}
source_dir="$worktree/${strategy.artifactDirectory}"
test -s "$source_dir/index.html"
rm -rf "$version.tmp"
mkdir -p "$version.tmp"
cp -a "$source_dir/." "$version.tmp/"
find "$version.tmp" -type d -exec chmod 755 {} +
find "$version.tmp" -type f -exec chmod 644 {} +
python3 - "$version.tmp" <<'PY'
import pathlib, re, sys
root = pathlib.Path(sys.argv[1])
index = root / 'index.html'
if not index.is_file() or index.stat().st_size == 0:
    raise SystemExit('index.html missing or empty')
html = index.read_text(encoding='utf-8', errors='replace')
refs = re.findall(r'(?:src|href)=["\\\']([^"\\\']+\\.(?:js|css)(?:\\?[^"\\\']*)?)["\\\']', html, re.I)
if not refs:
    raise SystemExit('index.html has no JS/CSS entry reference')
for ref in refs:
    clean = ref.split('?', 1)[0]
    if clean.startswith(('http://', 'https://', '//')):
        continue
    asset = root / clean.lstrip('/')
    if not asset.is_file() or asset.stat().st_size == 0:
        raise SystemExit(f'entry asset missing or empty: {clean}')
PY
rm -rf "$version"
mv "$version.tmp" "$version"
if [ -L "$publish_root/current" ]; then ln -sfn "$(readlink "$publish_root/current")" "$publish_root/previous"; fi
rm -f "$publish_root/current.next"
ln -s "$version" "$publish_root/current.next"
python3 -c 'import os, sys; os.replace(sys.argv[1], sys.argv[2])' "$publish_root/current.next" "$publish_root/current"
printf 'release_id=%s\ncommit=%s\nmode=generated-static\n' "$CDS_RELEASE_ID" "$CDS_COMMIT_SHA"
`;
}

function readPackageJson(root: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function detectBuildCommand(root: string, packageJson: Record<string, unknown> | null): string {
  const scripts = packageJson?.scripts as Record<string, unknown> | undefined;
  if (typeof scripts?.build !== 'string') return '';
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile && pnpm build';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn install --frozen-lockfile && yarn build';
  return 'npm ci && npm run build';
}

function detectArtifactDirectory(root: string, packageJson: Record<string, unknown> | null): string {
  const existing = STATIC_DIRECTORIES.find((candidate) => fs.existsSync(path.join(root, candidate, 'index.html')));
  if (existing) return existing;
  const dependencies = {
    ...((packageJson?.dependencies as Record<string, unknown> | undefined) || {}),
    ...((packageJson?.devDependencies as Record<string, unknown> | undefined) || {}),
  };
  if ('next' in dependencies) return 'out';
  if ('react-scripts' in dependencies) return 'build';
  return packageJson ? 'dist' : '';
}

function isSafeRelativePath(value: string): boolean {
  if (!value || path.posix.isAbsolute(value) || value.includes('\\')) return false;
  const normalized = path.posix.normalize(value);
  return normalized !== '..' && !normalized.startsWith('../');
}

function isSafePublicDirectory(value: string): boolean {
  if (!path.posix.isAbsolute(value) || value.includes('\\')) return false;
  const normalized = path.posix.normalize(value);
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length < 2) return false;
  const protectedRoots = new Set(['bin', 'boot', 'dev', 'etc', 'lib', 'lib64', 'proc', 'run', 'sbin', 'sys', 'usr']);
  return !protectedRoots.has(segments[0]);
}

function sanitizeRepository(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return value.replace(/:\/\/[^/@]+@/, '://');
  }
}

function shellSafeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'cds-release';
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
