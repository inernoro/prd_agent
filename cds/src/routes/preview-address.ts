import { Router, type Request } from "express";
import { randomUUID } from "node:crypto";
import type {
  BranchEntry,
  CdsConfig,
  PreviewAddressAudit,
  Project,
} from "../types.js";
import type { StateService } from "../services/state.js";
import type { ServerEventLogSink } from "../services/server-event-log-store.js";
import { assertProjectAccess } from "./projects.js";
import { canHumanAccessProject } from "../services/human-project-access.js";
import {
  isAuthenticatedHuman,
  isHumanSystemOwner,
} from "../services/human-auth.js";
import { projectIdentityActorFromRequest } from "../services/project-identity-history.js";
import {
  acquireAddressWrite,
  addressCollisions,
  addressDraft,
  changedAddressBranches,
  parseAddressDraft,
  planPreviewAddress,
  PreviewAddressError,
  previewAddressVersion,
  publicPreviewRoot,
  probePreviewAddress,
  type PreviewAddressProbe,
} from "../services/preview-address-settings.js";
import { buildPreviewUrlForProject } from "../services/comment-template.js";

type Entry = { name: string; url: string };
interface Deps {
  stateService: StateService;
  config: CdsConfig;
  serverEventLogStore?: ServerEventLogSink | null;
  getEntries: (entry: BranchEntry, root: string) => Entry[];
  probe?: (url: string, branchId: string) => Promise<PreviewAddressProbe>;
}
async function boundedFlush(state: StateService) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      state.flush(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("state flush timeout")),
          8000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function createPreviewAddressRouter(deps: Deps): Router {
  const { stateService: state, config } = deps;
  const router = Router();
  const root = publicPreviewRoot(config);
  const editable = (req: Request, p: Project) =>
    isHumanSystemOwner(req) && !p.mirror;
  function context(req: Request, write = false) {
    const b = state.getBranch(req.params.id);
    if (!b)
      throw new PreviewAddressError(404, "分支不存在，请重新从项目列表进入。");
    const p = state.getProject(b.projectId);
    if (!p) throw new PreviewAddressError(404, "项目不存在。");
    const scope = assertProjectAccess(
      req as Parameters<typeof assertProjectAccess>[0],
      p.id,
    );
    if (
      !isAuthenticatedHuman(req) ||
      scope ||
      !canHumanAccessProject(req, state, p.id)
    )
      throw new PreviewAddressError(
        403,
        "没有权限查看此项目的地址设置。",
        "address_forbidden",
      );
    if (write && !editable(req, p))
      throw new PreviewAddressError(
        403,
        p.mirror
          ? "镜像项目只可查看，请回到来源 CDS 修改。"
          : "你没有修改该项目地址的权限，请联系系统所有者。",
        "address_forbidden",
      );
    return { p, b };
  }
  function view(req: Request, p: Project, b: BranchEntry) {
    return {
      branchId: b.id,
      gitBranch: b.branch,
      projectId: p.id,
      projectName: p.aliasName || p.name,
      projectSlug: p.slug,
      rootDomain: root,
      canEdit: editable(req, p),
      version: previewAddressVersion(p, state.getAllBranches()),
      draft: addressDraft(p, b),
      url: buildPreviewUrlForProject(root, b.branch, p, p.id).url,
    };
  }
  function conflictView(req: Request, before: Project, after: Project) {
    return addressCollisions(state, before, after, config).map((c) => {
      const owner = c.projectId ? state.getProject(c.projectId) : undefined;
      const allowed =
        !!owner &&
        canHumanAccessProject(req, state, owner.id) &&
        !assertProjectAccess(
          req as Parameters<typeof assertProjectAccess>[0],
          owner.id,
        );
      return {
        reason: c.reason,
        host: c.host,
        projectName: allowed ? owner!.aliasName || owner!.name : "其他项目",
        ...(allowed
          ? {
              projectId: owner!.id,
              branchId: c.branchId,
              canEdit: editable(req, owner!),
              href: c.branchId
                ? `/branch-list?project=${encodeURIComponent(owner!.id)}&openBranch=${encodeURIComponent(c.branchId)}&configureAddress=1`
                : `/settings/${encodeURIComponent(owner!.id)}`,
            }
          : {}),
      };
    });
  }
  async function audit(
    req: Request,
    p: Project,
    b: BranchEntry,
    info: Pick<PreviewAddressAudit, "action" | "result" | "scope"> &
      Partial<Pick<PreviewAddressAudit, "before" | "after">>,
  ) {
    const actor = projectIdentityActorFromRequest(req);
    const record: PreviewAddressAudit = {
      ...actor,
      ...info,
      id: randomUUID(),
      at: new Date().toISOString(),
      branchId: b.id,
    };
    const latest = state.getProject(p.id)!;
    state.updateProject(
      p.id,
      { previewAddressAudit: [...(latest.previewAddressAudit || []), record] },
      actor,
    );
    await boundedFlush(state);
    deps.serverEventLogStore?.record({
      category: "system",
      severity: info.action === "rejected" ? "warn" : "info",
      source: "preview-address",
      action: `preview-address.${info.action}`,
      projectId: p.id,
      branchId: b.id,
      requestId: actor.requestId,
      message: info.result,
      details: { ...record },
    });
    return record;
  }
  const route =
    (
      handler: (req: Request, res: import("express").Response) => Promise<void>,
    ) =>
    async (req: Request, res: import("express").Response) => {
      try {
        await handler(req, res);
      } catch (err) {
        const error =
          err instanceof PreviewAddressError
            ? err
            : new PreviewAddressError(
                503,
                "设置或审计未能确认持久保存，请重新加载后核对，暂时不要重复修改。",
                "address_storage",
              );
        if (!res.headersSent)
          res
            .status(error.status)
            .json({ error: error.code, message: error.message });
      }
    };
  router.get(
    "/branches/:id/preview-address",
    route(async (req, res) => {
      const { p, b } = context(req);
      res.json(view(req, p, b));
    }),
  );
  router.get(
    "/branches/:id/preview-address/audit",
    route(async (req, res) => {
      const { p } = context(req);
      const before =
        typeof req.query.before === "string" ? req.query.before : "";
      const all = [...(p.previewAddressAudit || [])].reverse();
      const offset = before ? all.findIndex((r) => r.id === before) + 1 : 0;
      if (before && offset === 0)
        throw new PreviewAddressError(400, "记录位置已变化，请刷新。");
      res.json({
        records: all.slice(offset, offset + 50),
        nextCursor: all.length > offset + 50 ? all[offset + 49].id : null,
      });
    }),
  );
  router.post(
    "/branches/:id/preview-address/preview",
    route(async (req, res) => {
      const { p, b } = context(req);
      const draft = parseAddressDraft(req.body);
      const next = planPreviewAddress(p, b, draft);
      res.json({
        ...view(req, p, b),
        url: buildPreviewUrlForProject(root, b.branch, next, p.id).url,
        changes: changedAddressBranches(p, next, state.getAllBranches()).map(
          (c) => ({
            ...c,
            before: `https://${c.before}.${root}`,
            after: `https://${c.after}.${root}`,
          }),
        ),
        projectSlugBefore: p.slug,
        projectSlugAfter: next.slug,
        collisions: conflictView(req, p, next),
      });
    }),
  );
  router.put(
    "/branches/:id/preview-address",
    route(async (req, res) => {
      let release: (() => void) | undefined;
      const { p, b } = context(req);
      try {
        context(req, true);
        release = acquireAddressWrite(state);
        if (
          req.body?.expectedVersion !==
          previewAddressVersion(p, state.getAllBranches())
        )
          throw new PreviewAddressError(
            409,
            "地址设置已被其他操作修改，请重新加载并核对后保存。",
            "address_changed",
          );
        const draft = parseAddressDraft(req.body);
        const next = planPreviewAddress(p, b, draft);
        const collisions = conflictView(req, p, next);
        if (!root)
          throw new PreviewAddressError(
            400,
            "尚未配置公开预览域名，请先完成 CDS 入口设置。",
          );
        if (collisions.length) {
          await audit(req, p, b, {
            action: "rejected",
            result: "地址已被占用，修改被拒绝",
            scope: draft.applyToProject ? "project" : "branch",
            after: { collisions },
          });
          res
            .status(409)
            .json({
              error: "address_conflict",
              message: "地址已被占用，设置没有保存。",
              collisions,
            });
          return;
        }
        const changed = changedAddressBranches(p, next, state.getAllBranches());
        const actor = projectIdentityActorFromRequest(req);
        const snapshot = (project: Project) => ({
          projectSlug: project.slug,
          branchAddress: project.previewAddresses?.[b.branch] || null,
          addresses: state
            .getAllBranches()
            .filter((entry) => entry.projectId === p.id)
            .map((entry) => ({
              branchId: entry.id,
              url: buildPreviewUrlForProject(root, entry.branch, project, p.id)
                .url,
            })),
        });
        const record: PreviewAddressAudit = {
          ...actor,
          id: randomUUID(),
          at: new Date().toISOString(),
          branchId: b.id,
          action: "save",
          scope: draft.applyToProject ? "project" : "branch",
          result: "已保存，尚未验证",
          before: snapshot(p),
          after: snapshot(next),
        };
        const before = structuredClone(p);
        let applied: Project | undefined;
        try {
          state.updateProject(
            p.id,
            {
              slug: next.slug,
              previewAddresses: next.previewAddresses,
              previewAddressAudit: [...(p.previewAddressAudit || []), record],
            },
            actor,
          );
          applied = state.getProject(p.id);
          await boundedFlush(state);
        } catch (err) {
          applied ||= state.getProject(p.id);
          if (applied) {
            state.restoreProjectSettingsUpdate(
              p.id,
              before,
              applied,
              ["slug", "previewAddresses"],
              applied,
            );
            await boundedFlush(state);
          }
          throw err;
        }
        deps.serverEventLogStore?.record({
          category: "system",
          severity: "info",
          source: "preview-address",
          action: "preview-address.save",
          projectId: p.id,
          branchId: b.id,
          requestId: actor.requestId,
          message: record.result,
          details: { ...record },
        });
        const saved = state.getProject(p.id)!;
        res.json({
          ...view(req, saved, b),
          message: "配置已保存，正在检查公开入口。",
          auditId: record.id,
          verifyTargets: (changed.length
            ? changed
            : [{ branchId: b.id, branch: b.branch }]
          ).map((c) => ({ branchId: c.branchId, branch: c.branch })),
        });
      } catch (err) {
        await audit(req, p, b, {
          action: "rejected",
          result:
            err instanceof PreviewAddressError
              ? err.message
              : "保存未确认，已请求恢复之前的配置，请重新加载核对。",
          scope: req.body?.applyToProject === true ? "project" : "branch",
        });
        throw err;
      } finally {
        release?.();
      }
    }),
  );
  router.post(
    "/branches/:id/preview-address/visit-conflict",
    route(async (req, res) => {
      const { p, b } = context(req);
      const draft = parseAddressDraft(req.body);
      const next = planPreviewAddress(p, b, draft);
      const collisions = conflictView(req, p, next);
      const target = collisions.find(
        (c) => c.href && c.href === req.body?.href,
      );
      if (!target)
        throw new PreviewAddressError(
          403,
          "占用情况或访问权限已变化，请重新检查。",
        );
      await audit(req, p, b, {
        action: "visit-conflict",
        result: target.canEdit
          ? "跳转到有编辑权限的占用项目"
          : "跳转到只读占用项目",
        scope: "branch",
        after: target,
      });
      res.json({ href: target.href });
    }),
  );
  router.post(
    "/branches/:id/preview-address/verify",
    route(async (req, res) => {
      const { p, b } = context(req, true);
      if (
        req.body?.expectedVersion !==
        previewAddressVersion(p, state.getAllBranches())
      )
        throw new PreviewAddressError(
          409,
          "地址已变化，请重新加载后验证当前配置。",
        );
      const entries = deps.getEntries(b, root);
      const results: Array<Entry & PreviewAddressProbe> = [];
      if (!entries.length)
        results.push({
          name: "主应用",
          url: buildPreviewUrlForProject(root, b.branch, p, p.id).url,
          ok: false,
          message: "没有声明可访问的网页入口，请检查服务配置。",
        });
      for (const entry of entries) {
        let result: PreviewAddressProbe = {
          ok: false,
          message: "分支尚未运行，请部署就绪后重试。",
        };
        if (b.status === "running") {
          for (let attempt = 0; attempt < 3; attempt++) {
            result = await (deps.probe || probePreviewAddress)(entry.url, b.id);
            if (result.ok) break;
            if (attempt < 2)
              await new Promise((resolve) => setTimeout(resolve, 800));
          }
        }
        results.push({ ...entry, ...result });
      }
      if (
        req.body.expectedVersion !==
        previewAddressVersion(state.getProject(p.id)!, state.getAllBranches())
      )
        throw new PreviewAddressError(
          409,
          "验证期间地址设置已变化，请验证最新配置。",
        );
      const ok = results.length > 0 && results.every((r) => r.ok);
      await audit(req, p, b, {
        action: "verify",
        result: ok ? "公开入口验证通过" : "已保存，公开入口验证未通过",
        scope: "branch",
        after: { results },
      });
      res.json({ ok, branchId: b.id, results });
    }),
  );
  return router;
}
