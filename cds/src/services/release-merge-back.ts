import type { StateService } from './state.js';
import type { GitHubAppClient } from './github-app-client.js';
import type { MergeBackReader } from './release-governance.js';
import { createExternalResponseAudit } from './standby-response-audit.js';
import type { ServerEventLogSink } from './server-event-log-store.js';
import { FULL_SHA } from './release-governance-git.js';

export function releaseMergeBackReader(state: StateService,
  app?: Pick<GitHubAppClient, 'getInstallationToken'>, fetchImpl: typeof fetch = fetch, sink?: ServerEventLogSink | null): MergeBackReader {
  return async (projectId, number) => {
    const project = state.getProject(projectId), repository = project?.githubRepoFullName;
    if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !project.githubInstallationId || !app) {
      throw new Error('项目尚未接入 GitHub PR 读取权限，请先完成仓库授权');
    }
    const url = `https://api.github.com/repos/${repository}/pulls/${number}`;
    const audit = createExternalResponseAudit(sink, {
      projectId, remoteProjectId: `${repository}#${number}`, policy: 'release-merge-back', dryRun: true,
    }, { source: 'release-merge-back', action: 'release.merge-back.response', message: '发布回并 PR 响应核验' });
    try {
      audit.assertAvailable();
      const started = Date.now();
      let token = '', response: Response | undefined, text: string | undefined, json: unknown;
      let parseState = 'no-response', localDecision = 'token-unavailable';
      let result: Awaited<ReturnType<MergeBackReader>> | undefined;
      try {
        token = await app.getInstallationToken(project.githubInstallationId);
        localDecision = 'no-response';
        response = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(15_000), redirect: 'error',
        });
        parseState = 'body-read-failed'; localDecision = 'body-read-failed';
        text = await response.text();
        parseState = 'invalid-json'; localDecision = 'invalid-json';
        try { json = JSON.parse(text); parseState = 'json'; } catch { /* Persist the failed parse before normalization. */ }
        if (!response.ok) localDecision = response.status === 403 ? 'http-forbidden' : response.status === 429 ? 'rate-limited' : 'http-error';
        else if (parseState === 'json') {
          const pr = json as { number?: number; state?: string; merged_at?: string; merge_commit_sha?: string;
            head?: { sha: string }; base?: { ref: string; repo?: { full_name: string } } } | null;
          localDecision = 'invalid-pr-identity';
          if (pr?.number === number && pr.base?.repo?.full_name?.toLowerCase() === repository.toLowerCase()
            && pr.head?.sha && FULL_SHA.test(pr.head.sha) && ['open','closed'].includes(pr.state || '')) {
            result = { repository, number, url: `https://github.com/${repository}/pull/${number}`,
              state: pr.merged_at ? 'merged' : pr.state as 'open' | 'closed', headSha: pr.head.sha,
              baseRef: pr.base.ref, mergedAt: pr.merged_at || undefined,
              mergeCommitSha: pr.merge_commit_sha && FULL_SHA.test(pr.merge_commit_sha) ? pr.merge_commit_sha : undefined,
              checkedAt: new Date().toISOString() };
            localDecision = 'success';
          }
        }
      } catch { /* No raw credential-bearing exceptions enter the audit or user error. */ }
      await audit.record({ peerId: 'github', url, method: 'GET', startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started, timeoutMs: 15_000, responseReceived: Boolean(response),
        httpStatus: response?.status ?? null, contentType: response?.headers.get('content-type') ?? null,
        upstreamRequestId: response?.headers.get('x-github-request-id') ?? null,
        text, json, parseState, localDecision, secrets: token ? [token] : [] });
      if (!result) throw new Error();
      return result;
    } catch { throw new Error('GitHub PR 状态暂未核实，请检查项目仓库权限后重试；未判定为已回并'); }
  };
}
