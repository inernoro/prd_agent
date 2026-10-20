import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPreviewAddressRouter } from "../../src/routes/preview-address.js";
import { StateService } from "../../src/services/state.js";
import { buildPreviewUrlForProject } from "../../src/services/comment-template.js";
import { ProxyService } from "../../src/services/proxy.js";
import { ForwarderRoutePublisher } from "../../src/services/forwarder-route-publisher.js";
import { previewAddressVersion } from "../../src/services/preview-address-settings.js";
import { flushAllJsonStateStores } from "../../src/infra/state-store/json-backing-store.js";
import type { BranchEntry, CdsConfig, Project } from "../../src/types.js";

let dir: string, state: StateService, server: http.Server;
let probe = vi.fn();
const endpoint = "/api/branches/foo-main/preview-address";
const draft = {
  mode: "branch",
  branchName: "main",
  projectSlug: "foo",
  customSubdomain: "",
  applyToProject: false,
};
function request(
  method: string,
  pathname: string,
  body?: unknown,
  human = "owner",
  scope?: string,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: (server.address() as { port: number }).port,
        path: pathname,
        method,
        headers: {
          "Content-Type": "application/json",
          "x-test-human": human,
          ...(scope ? { "x-test-scope": scope } : {}),
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode!, data: JSON.parse(text || "{}") }),
        );
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
function version() {
  return previewAddressVersion(
    state.getProject("foo")!,
    state.getAllBranches(),
  );
}
function addBranch(project: string, branch: string, aliases: string[] = []) {
  state.addBranch({
    id: `${project}-${branch}`,
    projectId: project,
    branch,
    worktreePath: dir,
    services: {
      [`web-${project}`]: {
        profileId: `web-${project}`,
        containerName: "test-container",
        hostPort: 20001,
        status: "running",
      },
    },
    status: "running",
    createdAt: new Date().toISOString(),
    subdomainAliases: aliases,
  } as BranchEntry);
}
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cds-address-"));
  state = new StateService(path.join(dir, "state.json"));
  state.load();
  for (const id of ["foo", "bar"]) {
    state.addProject({
      id,
      slug: id,
      name: id,
      kind: "git",
      legacyFlag: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Project);
    state.addBuildProfile({
      id: `web-${id}`,
      projectId: id,
      name: "web",
      pathPrefixes: ["/"],
      containerPort: 8080,
      webEntry: { name: "主应用", path: "/" },
    } as any);
  }
  addBranch("foo", "main");
  addBranch("foo", "develop");
  addBranch("bar", "master", ["occupied"]);
  probe = vi.fn().mockResolvedValue({
    ok: true,
    message: "HTML 与入口资源通过",
    status: 200,
    assets: 2,
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers["x-test-human"] !== "none") {
      (req as any).cdsUser = {
        id: "verified-owner",
        isSystemOwner: req.headers["x-test-human"] !== "member",
        authProvider: "local",
      };
      (req as any).cdsSession = {};
    }
    if (req.headers["x-test-scope"])
      (req as any).cdsProjectKey = {
        projectId: req.headers["x-test-scope"],
        keyId: "scope",
      };
    next();
  });
  app.use(
    "/api",
    createPreviewAddressRouter({
      stateService: state,
      config: {
        previewDomain: "preview.test",
        rootDomains: ["preview.test", "secondary.test"],
      } as CdsConfig,
      probe,
      getEntries: (entry, root) => [
        {
          name: "主应用",
          url: buildPreviewUrlForProject(
            root,
            entry.branch,
            state.getProject(entry.projectId),
            entry.projectId,
          ).url,
        },
      ],
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  await state.flush();
});
afterEach(async () => {
  await flushAllJsonStateStores();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("地址设置真实请求链与隔离", () => {
  it("读取当前配置，未认证或跨项目调用被拒绝", async () => {
    const current = (await request("GET", endpoint)).data;
    expect(current.url).toBe("https://main-foo.preview.test");
    expect(current.draft.branchName).toBe("main");
    expect((await request("GET", endpoint, undefined, "none")).status).toBe(
      403,
    );
    expect(
      (await request("GET", endpoint, undefined, "owner", "bar")).status,
    ).toBe(403);
  });
  it("草稿预览不修改任何项目或写审计", async () => {
    const before = JSON.stringify(state.getProjects());
    const result = await request("POST", `${endpoint}/preview`, {
      ...draft,
      projectSlug: "next",
      applyToProject: true,
    });
    expect(result.data.changes).toHaveLength(2);
    expect(result.data.projectSlugAfter).toBe("next");
    expect(JSON.stringify(state.getProjects())).toBe(before);
  });
  it("仅分支保存后发布器采用新地址，项目 slug 与另一分支保持不变", async () => {
    const result = await request("PUT", endpoint, {
      ...draft,
      branchName: "staging",
      projectSlug: "local",
      expectedVersion: version(),
    });
    expect(result.status).toBe(200);
    expect(result.data.url).toBe("https://staging-local.preview.test");
    expect(state.getProject("foo")!.slug).toBe("foo");
    expect(state.getBranch("foo-main")!.branch).toBe("main");
    expect(
      buildPreviewUrlForProject(
        "preview.test",
        "develop",
        state.getProject("foo"),
      ).url,
    ).toBe("https://develop-foo.preview.test");
    const publisher = new ForwarderRoutePublisher({
      state,
      rootDomains: ["preview.test"],
      outputPath: path.join(dir, "routes.json"),
    } as any);
    const routes = (publisher as any).buildRoutes();
    expect(
      routes.some(
        (r: any) =>
          r.host === "staging-local.preview.test" && r.branchId === "foo-main",
      ),
    ).toBe(true);
    expect(
      (new ProxyService(state) as any).resolveBranchEntry("staging-local")?.id,
    ).toBe("foo-main");
    expect(
      routes.some(
        (r: any) =>
          r.host === "develop-foo.preview.test" && r.branchId === "foo-develop",
      ),
    ).toBe(true);
    const reloaded = new StateService(path.join(dir, "state.json"));
    reloaded.load();
    expect(
      buildPreviewUrlForProject(
        "preview.test",
        "main",
        reloaded.getProject("foo"),
      ).url,
    ).toBe(result.data.url);
    expect(reloaded.getProject("foo")!.previewAddressAudit![0].actor).toBe(
      "user:verified-owner",
    );
  });
  it("全项目覆盖更新 slug，保留自定义地址，并留下完整服务端前后快照", async () => {
    state.updateProject("foo", {
      previewAddresses: { develop: { customSubdomain: "independent" } },
    });
    const result = await request("PUT", endpoint, {
      ...draft,
      projectSlug: "next",
      applyToProject: true,
      expectedVersion: version(),
      actor: "forged-admin",
      previewAddressAudit: [],
    });
    expect(result.status).toBe(200);
    expect(state.getProject("foo")!.slug).toBe("next");
    expect(
      buildPreviewUrlForProject(
        "preview.test",
        "develop",
        state.getProject("foo"),
      ).url,
    ).toBe("https://independent.preview.test");
    const audit = (await request("GET", `${endpoint}/audit`)).data.records[0];
    expect(audit.actor).toBe("user:verified-owner");
    expect(audit.scope).toBe("project");
    expect(audit.before.projectSlug).toBe("foo");
    expect(audit.after.projectSlug).toBe("next");
    expect(audit.at).toBeTruthy();
  });
  it("自定义直接成为主入口，不拼接项目名，验证读取真实保存结果", async () => {
    const saved = await request("PUT", endpoint, {
      ...draft,
      mode: "custom",
      customSubdomain: "custom",
      expectedVersion: version(),
    });
    expect(saved.data.url).toBe("https://custom.preview.test");
    const checked = await request("POST", `${endpoint}/verify`, {
      expectedVersion: saved.data.version,
    });
    expect(checked.data.ok).toBe(true);
    expect(probe).toHaveBeenCalledWith(
      "https://custom.preview.test",
      "foo-main",
    );
    const audit = (await request("GET", `${endpoint}/audit`)).data.records;
    expect(audit.map((a: any) => a.action)).toEqual(["verify", "save"]);
  });
  it("重复子域不能覆盖其他项目，并返回有权限的占用项目入口", async () => {
    const before = JSON.stringify(state.getProject("bar"));
    const result = await request("PUT", endpoint, {
      ...draft,
      mode: "custom",
      customSubdomain: "occupied",
      expectedVersion: version(),
    });
    expect(result.status).toBe(409);
    expect(result.data.collisions[0].projectId).toBe("bar");
    expect(result.data.collisions[0].href).toContain("configureAddress=1");
    expect(JSON.stringify(state.getProject("bar"))).toBe(before);
    expect(
      (await request("GET", `${endpoint}/audit`)).data.records[0].action,
    ).toBe("rejected");
  });
  it("多个根域名的占用提示保留各自真实 host，不改写成相同地址", async () => {
    const result = await request("POST", endpoint + "/preview", {
      ...draft, mode:"custom", customSubdomain:"occupied",
    });
    expect(result.data.collisions.map((c: {host:string}) => c.host).sort()).toEqual([
      "occupied.preview.test", "occupied.secondary.test",
    ]);
  });
  it("被项目授权限制的调用者不能读取占用方项目详情", async () => {
    const result = await request(
      "POST",
      `${endpoint}/preview`,
      { ...draft, mode: "custom", customSubdomain: "occupied" },
      "owner",
      "foo",
    );
    expect(result.data.collisions[0].projectName).toBe("其他项目");
    expect(result.data.collisions[0].href).toBeUndefined();
    expect(result.data.collisions[0].branchId).toBeUndefined();
  });
  it("保留旧裸分支入口，不能抢占已可解析的 master 地址", async () => {
    const result = await request("PUT", endpoint, {
      ...draft,
      mode: "custom",
      customSubdomain: "master",
      expectedVersion: version(),
    });
    expect(result.status).toBe(409);
    expect(result.data.collisions[0].branchId).toBe("bar-master");
  });
  it("一次预览过期后拒绝保存，不能覆盖后来的设置", async () => {
    const old = version();
    await request("PUT", endpoint, {
      ...draft,
      branchName: "first",
      expectedVersion: old,
    });
    const stale = await request("PUT", endpoint, {
      ...draft,
      branchName: "second",
      expectedVersion: old,
    });
    expect(stale.status).toBe(409);
    expect(stale.data.error).toBe("address_changed");
    expect(
      buildPreviewUrlForProject("preview.test", "main", state.getProject("foo"))
        .url,
    ).toBe("https://first-foo.preview.test");
  });
  it("只读镜像禁止保存，不能借跳转提升权限", async () => {
    state.getProject("foo")!.mirror = {
      capturedAt: new Date().toISOString(),
      source: "parent-cds",
    } as any;
    expect((await request("GET", endpoint)).data.canEdit).toBe(false);
    const result = await request("PUT", endpoint, {
      ...draft,
      branchName: "attack",
      expectedVersion: version(),
    });
    expect(result.status).toBe(403);
    expect(state.getProject("foo")!.previewAddresses).toBeUndefined();
  });
  it("已保存但验证失败不会假报通过，失败结果会被审计", async () => {
    probe.mockResolvedValue({ ok: false, message: "页面资源未就绪" });
    const saved = await request("PUT", endpoint, {
      ...draft,
      branchName: "check",
      expectedVersion: version(),
    });
    const checked = await request("POST", `${endpoint}/verify`, {
      expectedVersion: saved.data.version,
    });
    expect(checked.data.ok).toBe(false);
    expect(
      (await request("GET", `${endpoint}/audit`)).data.records[0].result,
    ).toContain("验证未通过");
    probe.mockResolvedValue({ ok: true, message: "恢复后检查通过" });
    expect(
      (
        await request("POST", `${endpoint}/verify`, {
          expectedVersion: saved.data.version,
        })
      ).data.ok,
    ).toBe(true);
  });
  it("只有服务端确认的占用项目才允许跳转，跳转有独立审计", async () => {
    const d = { ...draft, mode: "custom", customSubdomain: "occupied" };
    expect(
      (
        await request("POST", `${endpoint}/visit-conflict`, {
          ...d,
          href: "https://external.test",
        })
      ).status,
    ).toBe(403);
    const preview = await request("POST", `${endpoint}/preview`, d);
    const visit = await request("POST", `${endpoint}/visit-conflict`, {
      ...d,
      href: preview.data.collisions[0].href,
    });
    expect(visit.status).toBe(200);
    expect(
      (await request("GET", `${endpoint}/audit`)).data.records[0].action,
    ).toBe("visit-conflict");
  });
  it("普通成员即使伪造审计身份也无法保存或验证", async () => {
    const before = structuredClone(state.getProject("foo"));
    const result = await request(
      "PUT",
      endpoint,
      {
        ...draft,
        branchName: "release",
        expectedVersion: version(),
        actor: "owner",
      },
      "member",
    );
    expect(result.status).toBe(403);
    expect(state.getProject("foo")!.previewAddresses).toEqual(
      before!.previewAddresses,
    );
    expect(
      (
        await request(
          "POST",
          endpoint + "/verify",
          { expectedVersion: version() },
          "member",
        )
      ).status,
    ).toBe(403);
  });
  it("持久保存失败时恢复地址，拒绝回报保存成功并保留失败审计", async () => {
    await state.flush();
    const oldSlug = state.getProject("foo")!.slug;
    vi.spyOn(state, "flush").mockRejectedValueOnce(
      new Error("disk unavailable"),
    );
    const result = await request("PUT", endpoint, {
      ...draft,
      projectSlug: "renamed",
      applyToProject: true,
      expectedVersion: version(),
    });
    expect(result.status).toBe(503);
    expect(state.getProject("foo")!.slug).toBe(oldSlug);
    expect(state.getProject("foo")!.previewAddresses).toBeUndefined();
    expect(state.getProject("foo")!.previewAddressAudit!.at(-1)).toMatchObject({
      action: "rejected",
    });
  });
});
