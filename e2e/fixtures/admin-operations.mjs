// 浏览器内隔离写入：不执行真实发布，不改真实模型配置。
import { resolveFixture } from "../../cds/scripts/fixtures/mobile-layout-fixtures.mjs";
export const targetName = "隔离验收环境-" + "long-target-".repeat(8);
const sha = "a".repeat(40);
export const target = {
  id: "compat-target",
  projectId: "fixture-project",
  name: targetName,
  type: "site",
  isEnabled: true,
  environment: "production",
  isCanonical: true,
  strategy: {
    mode: "project-script",
    command: "printf " + "long-command".repeat(100),
  },
};
export const logs = Array.from({ length: 150 }, (_, i) => ({
  seq: i + 1,
  at: "2026-11-12T00:00:00Z",
  level: i === 149 ? "error" : "info",
  message:
    i === 149
      ? "COMPAT_LOG_END"
      : `日志 ${i} ${i === 0 ? "unbroken-log-".repeat(180) : "正常日志"}`,
}));
export const run = {
  releaseId: "compat-run",
  projectId: target.projectId,
  branchId: "compat-branch",
  commitSha: sha,
  targetId: target.id,
  status: "failed",
  startedAt: "2026-11-12T00:00:00Z",
  finishedAt: "2026-11-12T00:01:00Z",
  artifact: { type: "branch", commitSha: sha },
  logs,
};
export const logical = {
  id: "compat-model",
  name: "验收模型",
  publicId: "compat-model",
  identityKind: "stable",
  modelType: "chat",
  capabilities: ["tools", "streaming"],
  enabled: true,
  routingStrategy: "priority",
  defaultForAppCallerCodes: [],
  allowedAppCallerCodes: [],
  offerings: [],
  displayOrder: 1,
};
export async function installOperationsFixtures(page) {
  const writes = [];
  let model = structuredClone(logical);
  let error = false;
  let preflightPass = false;
  let latestRun = run;
  await page.route("**/*", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    const reply = (data) => route.fulfill({ json: data });
    if (req.resourceType() === "eventsource")
      return route.fulfill({
        contentType: "text/event-stream",
        // WebKit 在跨应用导航取消重连时仍校验模拟 SSE 的 CORS，明确响应所属请求源。
        headers: {
          "access-control-allow-origin": req.headers().origin || new URL(req.url()).origin,
          "access-control-allow-credentials": "true",
        },
        body: ": fixture\n\n",
      });
    if (path.startsWith("/api/")) {
      if (req.method() !== "GET")
        writes.push({ path, method: req.method(), body: req.postDataJSON() });
      if (path === "/api/releases/center")
        return reply({
          rows: [
            {
              target,
              currentVersion: "old",
              currentCommit:
                latestRun.status === "success" ? sha : "b".repeat(40),
              healthStatus: "failed",
              canRollback: false,
              latestRun,
            },
          ],
          runs: [latestRun],
          plans: [],
        });
      if (path === "/api/releases/targets")
        return reply({
          targets: [target],
          archivedTargets: [],
          remoteHosts: [],
        });
      if (path === "/api/branches")
        return reply({
          branches: [
            {
              id: "compat-branch",
              projectId: target.projectId,
              branch: "compat-branch",
              commitSha: sha,
              status: "running",
              previewUrl: "https://example.test",
            },
          ],
        });
      if (path.endsWith("/preflight"))
        return reply({
          checks: preflightPass
            ? []
            : [
                {
                  id: "compat",
                  label: "隔离预检失败",
                  status: "fail",
                  blocking: true,
                  detail: "错误说明 " + "diagnostic-".repeat(200),
                },
              ],
        });
      if (
        path.endsWith("/branches/compat-branch/runs") &&
        req.method() === "POST"
      ) {
        latestRun = {
          ...run,
          releaseId: "compat-success-run",
          status: "success",
          logs: [{ ...logs[0], message: "COMPAT_RELEASE_SUCCESS" }],
        };
        return reply({ run: latestRun });
      }
      if (path.includes("/releases/runs/")) return reply({ run, logs });
      return reply(resolveFixture(path) ?? {});
    }
    if (path.includes("/gw/")) {
      const api = path.slice(path.indexOf("/gw/") + 3);
      let data = { items: [], total: 0 };
      if (req.method() !== "GET")
        writes.push({
          path: api,
          method: req.method(),
          body: req.postDataJSON(),
        });
      if (api === "/auth/login")
        data = {
          token: "fixture",
          username: "demo",
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          mustChangePassword: false,
          tenant: {
            id: "t1",
            name: "验收租户",
            isInternal: true,
            role: "owner",
            teamIds: [],
          },
        };
      else if (api === "/logical-models") {
        if (error)
          return reply({
            success: false,
            error: { message: "加载失败，请重试" },
            data: null,
          });
        data = { items: [model], total: 1 };
      } else if (api === "/logical-models/usage") data = { items: [] };
      else if (
        api === "/logical-models/compat-model/delete-check" &&
        req.method() === "GET"
      )
        data = { canDelete: true, reasons: [], offerings: model.offerings.length };
      else if (
        api === "/logical-models/compat-model" &&
        req.method() === "PUT"
      ) {
        model = { ...model, ...req.postDataJSON() };
        data = model;
      } else if (api === "/exchanges/meta")
        data = {
          modelTypes: [{ value: "chat", label: "对话" }],
          transformerTypes: [],
          authSchemes: [],
        };
      else if (api === "/healthz") data = { status: "ok" };
      else if (api === "/platforms")
        data = {
          items: [
            {
              id: "compat-provider",
              name: "验收供应方",
              authority: "llm_gateway",
              platformType: "openai",
              apiUrl: "https://example.test/v1",
              enabled: true,
              hasKey: true,
              maxConcurrency: 10,
            },
          ],
          total: 1,
        };
      else if (api === "/organization")
        data = {
          tenant: { id: "t1", name: "验收租户" },
          teams: [],
          members: [],
        };
      else if (api === "/service-keys")
        data = [
          {
            id: "compat-key",
            name: "验收密钥",
            sourceSystem: "external",
            clientCode: "compat-client",
            environment: "test",
            purpose: "external-platform",
            keyPrefix: "gwk_fixture",
            enabled: true,
            appCallerCodes: ["compat.test::chat"],
            ingressProtocols: ["openai"],
            scopes: ["invoke"],
            allowedCidrs: [],
            createdAt: "2026-11-12T00:00:00Z",
          },
        ];
      else if (api === "/logs")
        data = {
          items: [
            {
              id: "compat-log",
              requestId: "compat-request",
              startedAt: "2026-11-12T00:00:00Z",
              status: "failed",
              statusCode: 502,
              model: "compat-model",
              provider: "验收供应方",
              appCallerCode: "compat.test::chat",
              durationMs: 1000,
            },
          ],
          total: 1,
        };
      else if (api === "/logs/compat-log")
        data = {
          id: "compat-log",
          requestId: "compat-request",
          startedAt: "2026-11-12T00:00:00Z",
          status: "failed",
          statusCode: 502,
          model: "compat-model",
          provider: "验收供应方",
          questionText: "request-" + "long-request-".repeat(200),
          answerText: "response-" + "long-response-".repeat(200),
          providerAttempts: [],
          routerTrace: { isFallback: false },
          error: "隔离上游失败示例",
        };
      else if (api === "/logs/meta")
        data = {
          models: [],
          providers: [],
          statuses: [],
          appCallerCodes: [],
          sessions: [],
          teams: [],
          serviceKeys: [],
          clientCodes: [],
          environments: [],
        };
      else if (api === "/logs/summary")
        data = { total: 0, totalTokens: 0, estimatedCosts: [] };
      return reply({ success: true, error: null, data });
    }
    await route.continue();
  });
  return {
    writes,
    setPreflightPass: (value) => {
      preflightPass = value;
    },
    setError: (v) => {
      error = v;
    },
  };
}
