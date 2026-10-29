import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import type { ReleaseRun, ReleaseStrategy } from '../types.js';
import { DEFAULT_RELEASE_SCRIPT_FILE } from '../domain/release-script-contract.js';
import { shellQuote } from './sidecar/sidecar-deployer.js';

export function releaseScriptFile(strategy: ReleaseStrategy): string {
  return strategy.scriptFile || DEFAULT_RELEASE_SCRIPT_FILE;
}

export function validateProjectScript(strategy: ReleaseStrategy): string | null {
  if (strategy.ciWorkflowFile && !/^[A-Za-z0-9_-]+\.ya?ml$/.test(strategy.ciWorkflowFile)) return '发布 CI 必须是 .github/workflows 下的工作流文件名';
  if (strategy.mode === 'project-script') {
    const file = releaseScriptFile(strategy);
    if (!/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.sh$/.test(file)
      || file.split('/').some(part => part === '.' || part === '..')) return '发布脚本必须是仓库内安全的相对 .sh 路径';
    return null;
  }
  if (!strategy.script?.trim() || Buffer.byteLength(strategy.script) > 262144) return 'CDS 独立脚本不能为空且不得超过 256 KiB';
  return null;
}

/** Read the committed blob, never a mutable worktree/host file or a symlink. */
export function projectScriptContent(strategy: ReleaseStrategy, run: ReleaseRun): string {
  if (strategy.mode === 'managed-script') return strategy.script!;
  if (run.executionSnapshot?.mode === 'project-script' && run.executionSnapshot.scriptContent !== undefined) {
    const content = run.executionSnapshot.scriptContent;
    if (crypto.createHash('sha256').update(content).digest('hex') !== run.executionSnapshot.scriptSha256) throw new Error('历史发布脚本正文与指纹不一致');
    return content;
  }
  if (!/^[a-f0-9]{40}$/.test(run.commitSha) || !run.artifact.artifactPath) throw new Error('发布脚本缺少完整提交或项目仓库');
  const file = releaseScriptFile(strategy);
  try {
    const args = ['-C', run.artifact.artifactPath];
    const entry = execFileSync('git', [...args, 'ls-tree', run.commitSha, '--', file], { encoding: 'utf8', timeout: 5000 });
    if (!/^100(?:644|755) blob [a-f0-9]+\t/.test(entry)) throw new Error('not regular');
    return execFileSync('git', [...args, 'show', `${run.commitSha}:${file}`], { encoding: 'utf8', timeout: 5000, maxBuffer: 262144 });
  } catch {
    throw new Error(`提交 ${run.commitSha.slice(0, 12)} 缺少普通发布脚本 ${file}，请提交脚本并通过 CI`);
  }
}

export function checkedScriptContent(strategy: ReleaseStrategy, run: ReleaseRun): { content: string; hash: string } {
  const error = validateProjectScript(strategy);
  if (error) throw new Error(error);
  const content = projectScriptContent(strategy, run);
  try { execFileSync('bash', ['-n'], { input: content, timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch { throw new Error('发布脚本 Bash 语法校验失败，请先修复并通过 CI'); }
  if (!content.trim()) throw new Error('发布脚本不能为空');
  return { content, hash: crypto.createHash('sha256').update(content).digest('hex') };
}

export function projectReleaseExecution(strategy: ReleaseStrategy, run: ReleaseRun, preservePrevious: boolean) {
  const { content, hash } = checkedScriptContent(strategy, run);
  const managed = strategy.mode === 'managed-script';
  const script = `#!/usr/bin/env bash
set -Eeuo pipefail
: "\${CDS_COMMIT_SHA:?}" "\${CDS_RELEASE_ID:?}" "\${CDS_TARGET_ID:?}"
repo="$PWD"
release_root="$(dirname "$repo")/.cds-releases/$CDS_TARGET_ID"
worktree="$release_root/worktrees/$CDS_RELEASE_ID"
mkdir -p "$release_root/worktrees"
git -C "$repo" fetch --all --prune
git -C "$repo" cat-file -e "$CDS_COMMIT_SHA^{commit}"
if [ ! -d "$worktree" ]; then git -C "$repo" worktree add --detach "$worktree" "$CDS_COMMIT_SHA"; fi
cd "$worktree"
${managed ? `release_script="$(mktemp "$release_root/managed.XXXXXX.sh")"
trap 'rm -f "$release_script"' EXIT
printf %s ${shellQuote(Buffer.from(content).toString('base64'))} | base64 -d > "$release_script"` : `release_script=${shellQuote('./' + releaseScriptFile(strategy))}`}
python3 -c 'import hashlib,sys; assert hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest()==sys.argv[2], "release script content changed"' "$release_script" ${shellQuote(hash)}
bash "$release_script" check
bash "$release_script" deploy
${preservePrevious ? '# preserve previous during recovery' : 'if [ -L "$release_root/current" ]; then ln -sfn "$(readlink "$release_root/current")" "$release_root/previous"; fi'}
ln -sfn "$worktree" "$release_root/current.next"
python3 -c 'import os,sys; os.replace(sys.argv[1],sys.argv[2])' "$release_root/current.next" "$release_root/current"
printf 'release_id=%s\\ncommit=%s\\nmode=${strategy.mode}\\n' "$CDS_RELEASE_ID" "$CDS_COMMIT_SHA"
`;
  return {
    mode: strategy.mode,
    command: `printf %s ${shellQuote(Buffer.from(script).toString('base64'))} | base64 -d | bash`,
    scriptSha256: hash,
    scriptContent: managed ? undefined : content,
    summary: managed ? '执行 CDS 独立脚本（备选，正文哈希已固定）' : `执行项目版本化发布脚本 ${releaseScriptFile(strategy)}（同提交正文哈希）`,
  };
}
