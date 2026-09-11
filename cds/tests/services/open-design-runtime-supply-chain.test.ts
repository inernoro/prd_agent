import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

describe('OpenDesign runtime supply chain', () => {
  it('pins the CDS runtime to an immutable digest', () => {
    const runtimeSource = fs.readFileSync(
      path.join(repoRoot, 'cds/src/services/agent-workspace-session-runtime.ts'),
      'utf8',
    );

    expect(runtimeSource).toMatch(
      /OPEN_DESIGN_IMAGE\s*=\s*'ghcr\.io\/inernoro\/prd_agent\/opendesign-runtime@sha256:[a-f0-9]{64}'/,
    );
  });

  it('publishes only commit-addressed tags from branch workflows', () => {
    const workflow = fs.readFileSync(
      path.join(repoRoot, '.github/workflows/open-design-runtime.yml'),
      'utf8',
    );

    expect(workflow).toContain(
      'tags: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:sha-${{ github.sha }}',
    );
    expect(workflow).not.toContain('RUNTIME_TAG');
    expect(workflow).not.toContain('od-0.21.1-opencode-1.18.28');
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain("github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/heads/codex/')");
    expect(workflow).toContain('Build runtime without publishing');
    expect(workflow).toContain('agent: Codex CLI 0.143.0');
    expect(workflow).not.toContain('agent: OpenCode');
  });

  it('keeps the codex version identical across the pin, the build description and the notices', () => {
    // 事故形状：构建描述换成了 codex，运行时常量、清单各写各的，没有任何判据要求三者一致。
    // 这里把三处解析出来互相比对——改一处忘一处会直接红。
    const runtimeSource = fs.readFileSync(
      path.join(repoRoot, 'cds/src/services/agent-workspace-session-runtime.ts'),
      'utf8',
    );
    const dockerfile = fs.readFileSync(
      path.join(repoRoot, 'cds/open-design-runtime/Dockerfile'),
      'utf8',
    );
    const notices = fs.readFileSync(
      path.join(repoRoot, 'cds/open-design-runtime/THIRD_PARTY_NOTICES.md'),
      'utf8',
    );

    const runtimeVersion = /OPEN_DESIGN_CODEX_VERSION = '([^']+)'/.exec(runtimeSource)?.[1];
    const dockerfileVersion = /@openai\/codex@([0-9][^\s\\]*)/.exec(dockerfile)?.[1];
    const probeVersion = /codex-cli \$\{OPEN_DESIGN_CODEX_VERSION\}/.test(runtimeSource);
    const noticesVersion = /\| Codex CLI \| ([^|]+?) \|/.exec(notices)?.[1]?.trim();

    // 解析不出来就是解析规则和源码漂移了，必须红，不能当成「没问题」。
    expect(runtimeVersion, '无法解析运行时的 codex 版本常量').toBeTruthy();
    expect(dockerfileVersion, '无法解析构建描述里的 codex 版本').toBeTruthy();
    expect(noticesVersion, '无法解析第三方清单里的 codex 版本').toBeTruthy();

    expect(dockerfileVersion).toBe(runtimeVersion);
    expect(noticesVersion).toBe(runtimeVersion);
    // 探针必须用那个常量拼版本串，而不是另写一个字面量。
    expect(probeVersion, '能力探针没有使用 OPEN_DESIGN_CODEX_VERSION 常量').toBe(true);
  });

  it('actually runs the pinned-image probe in CI, for the files that can drift', () => {
    // 事故形状：守卫写了、也接进 CI 了，但闸门的路径过滤不含被守文件，
    // 于是「只改销钉」的 PR 一路全绿。这里断言接线本身。
    const workflow = fs.readFileSync(
      path.join(repoRoot, '.github/workflows/open-design-runtime.yml'),
      'utf8',
    );
    const verifier = path.join(repoRoot, 'cds/open-design-runtime/verify-pinned-runtime.sh');

    expect(fs.existsSync(verifier), '缺少钉住镜像的校验脚本').toBe(true);
    expect(workflow).toContain('bash cds/open-design-runtime/verify-pinned-runtime.sh');
    // 销钉与探针都住在这个文件里；它必须被闸门的路径过滤覆盖，否则守卫对它要防的场景不设防。
    const filterHits = workflow.split('cds/src/services/agent-workspace-session-runtime.ts').length - 1;
    expect(filterHits, '运行时源码没有被 push 与 pull_request 两个路径过滤同时覆盖')
      .toBeGreaterThanOrEqual(2);
  });

  it('ships versioned third-party provenance and license responsibilities in the derived image', () => {
    const dockerfile = fs.readFileSync(
      path.join(repoRoot, 'cds/open-design-runtime/Dockerfile'),
      'utf8',
    );
    const notices = fs.readFileSync(
      path.join(repoRoot, 'cds/open-design-runtime/THIRD_PARTY_NOTICES.md'),
      'utf8',
    );

    expect(dockerfile).toContain('org.opencontainers.image.licenses="Apache-2.0"');
    expect(dockerfile).toContain('@openai/codex@0.143.0');
    expect(dockerfile).not.toContain('opencode-ai');
    expect(dockerfile).toContain('COPY THIRD_PARTY_NOTICES.md');
    expect(notices).toContain('| OpenDesign | 0.21.1 |');
    expect(notices).toContain('| Codex CLI | 0.143.0 |');
    expect(notices).toContain('正式升级前');
  });
});
