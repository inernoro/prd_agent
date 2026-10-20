import { createHash } from "node:crypto";
import type {
  BranchEntry,
  CdsConfig,
  PreviewAddressOverride,
  Project,
} from "../types.js";
import type { StateService } from "./state.js";
import {
  configuredPreviewSlug,
  previewBranchName,
  projectReservedIdentifiers,
} from "./preview-slug.js";
import {
  occupiedHostOwners,
  projectBranchPublishedHosts,
} from "./preview-entrypoints.js";
import { resolveEffectiveProfile } from "./container.js";
import { projectIdentityVersion } from "./project-identity-history.js";

export interface PreviewAddressDraft {
  mode: "branch" | "custom";
  branchName: string;
  projectSlug: string;
  customSubdomain: string;
  applyToProject: boolean;
}
export class PreviewAddressError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "address_validation",
  ) {
    super(message);
  }
}
const locks = new WeakSet<StateService>();
export function addressWriteLocked(state: StateService): boolean {
  return locks.has(state);
}
export function acquireAddressWrite(state: StateService): () => void {
  if (locks.has(state))
    throw new PreviewAddressError(
      409,
      "地址设置正在保存，请稍后重新加载后再试。",
    );
  locks.add(state);
  return () => locks.delete(state);
}
export function previewAddressVersion(
  project: Project,
  branches: BranchEntry[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        identity: projectIdentityVersion(project),
        slug: project.slug,
        overrides: project.previewAddresses,
        branches: branches
          .filter((b) => b.projectId === project.id)
          .map((b) => [b.id, b.branch, b.createdAt])
          .sort(),
      }),
    )
    .digest("hex");
}
export function publicPreviewRoot(config: CdsConfig): string {
  return (config.previewDomain || config.rootDomains?.[0] || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}
export function addressDraft(
  project: Project,
  entry: BranchEntry,
): PreviewAddressDraft {
  const override =
    project.previewAddresses &&
    Object.hasOwn(project.previewAddresses, entry.branch)
      ? project.previewAddresses[entry.branch]
      : undefined;
  return {
    mode: override?.customSubdomain ? "custom" : "branch",
    branchName: override?.branchName || previewBranchName(entry.branch),
    projectSlug: override?.projectSlug || project.slug,
    customSubdomain: override?.customSubdomain || "",
    applyToProject: false,
  };
}
function dnsLabel(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)
  )
    throw new PreviewAddressError(
      400,
      `${field}只能使用小写字母、数字和连字符，首尾不能是连字符，最多 63 个字符。`,
    );
  return value;
}
export function parseAddressDraft(body: unknown): PreviewAddressDraft {
  const v = body as Partial<PreviewAddressDraft> | null;
  if (
    !v ||
    (v.mode !== "branch" && v.mode !== "custom") ||
    typeof v.applyToProject !== "boolean"
  )
    throw new PreviewAddressError(
      400,
      "地址设置格式不正确，请重新加载页面后重试。",
    );
  if (v.mode === "custom") {
    if (v.applyToProject)
      throw new PreviewAddressError(
        400,
        "自定义子域不修改项目 slug。请切换到仅分支后再修改项目。",
      );
    return {
      mode: "custom",
      branchName: "",
      projectSlug: "",
      customSubdomain: dnsLabel(v.customSubdomain, "子域名"),
      applyToProject: false,
    };
  }
  const branchName = dnsLabel(v.branchName, "分支名"),
    projectSlug = dnsLabel(v.projectSlug, "项目名");
  dnsLabel(`${branchName}-${projectSlug}`, "组合后的地址");
  if (v.applyToProject && projectSlug.length > 50)
    throw new PreviewAddressError(
      400,
      "项目 slug 最多 50 个字符，请缩短项目名。",
    );
  return {
    mode: "branch",
    branchName,
    projectSlug,
    customSubdomain: "",
    applyToProject: v.applyToProject,
  };
}
export function planPreviewAddress(
  project: Project,
  entry: BranchEntry,
  draft: PreviewAddressDraft,
): Project {
  const next: Project = {
    ...project,
    previewAddresses: { ...project.previewAddresses },
  };
  const override: PreviewAddressOverride =
    draft.mode === "custom"
      ? { customSubdomain: draft.customSubdomain }
      : {
          ...(draft.branchName !== previewBranchName(entry.branch)
            ? { branchName: draft.branchName }
            : {}),
          ...(!draft.applyToProject && draft.projectSlug !== project.slug
            ? { projectSlug: draft.projectSlug }
            : {}),
        };
  if (draft.mode === "branch" && draft.applyToProject)
    next.slug = draft.projectSlug;
  if (Object.keys(override).length)
    next.previewAddresses = {
      ...next.previewAddresses,
      [entry.branch]: override,
    };
  else delete next.previewAddresses![entry.branch];
  return next;
}
export function changedAddressBranches(
  before: Project,
  after: Project,
  branches: BranchEntry[],
) {
  return branches
    .filter((b) => b.projectId === before.id)
    .flatMap((b) => {
      const previous = configuredPreviewSlug(b.branch, before, b.projectId),
        next = configuredPreviewSlug(b.branch, after, b.projectId);
      return previous === next
        ? []
        : [{ branchId: b.id, branch: b.branch, before: previous, after: next }];
    });
}
export interface AddressCollision {
  host: string;
  branchId?: string;
  projectId?: string;
  reason: string;
}
export function addressCollisions(
  state: StateService,
  before: Project,
  after: Project,
  config: CdsConfig,
): AddressCollision[] {
  const roots = [
    ...new Set(
      [publicPreviewRoot(config), ...(config.rootDomains || [])].filter(
        Boolean,
      ),
    ),
  ];
  const branches = state.getAllBranches();
  const candidates = branches.filter((b) => b.projectId === before.id);
  const occupied = occupiedHostOwners(branches, roots);
  for (const b of branches.filter((b) => b.projectId !== before.id)) {
    const p = state.getProject(b.projectId);
    for (const host of projectBranchPublishedHosts(
      b,
      p,
      state.getEffectiveProfilesForBranch(b).map(profile => resolveEffectiveProfile(profile, b)),
      roots,
    ))
      occupied.set(host, b.id);
    // Legacy resolver still recognizes persisted ids and bare legacy branches.
    for (const root of roots) {
      occupied.set(`${b.id.toLowerCase()}.${root}`, b.id);
      const legacy = previewBranchName(b.branch);
      if (!occupied.has(`${legacy}.${root}`))
        occupied.set(`${legacy}.${root}`, b.id);
    }
  }
  const collision: AddressCollision[] = [];
  if (before.slug !== after.slug) {
    const owner = state
      .getProjects()
      .find(
        (p) =>
          p.id !== before.id &&
          projectReservedIdentifiers(p).includes(after.slug),
      );
    if (owner)
      collision.push({
        host: after.slug,
        projectId: owner.id,
        reason: "project-slug",
      });
  }
  // Compare the complete proposed namespace, rather than letting iteration
  // order decide whether an unchanged sibling service host is already claimed.
  const proposed = candidates.map(b => {
    const profiles = state.getEffectiveProfilesForBranch(b).map(profile => resolveEffectiveProfile(profile, b));
    const label = configuredPreviewSlug(b.branch, after, b.projectId);
    dnsLabel(label, "受影响分支的地址");
    return { b, oldHosts: new Set(projectBranchPublishedHosts(b, before, profiles, roots)),
      primaryHosts: roots.map(root => `${label}.${root}`),
      published: projectBranchPublishedHosts(b, after, profiles, roots) };
  });
  const owners = new Map<string, Set<string>>();
  for (const { b, published } of proposed) for (const host of published) {
    if (!owners.has(host)) owners.set(host, new Set());
    owners.get(host)!.add(b.id);
  }
  for (const { b, oldHosts, primaryHosts, published } of proposed) {
    for (const host of published) {
      const occupiedOwner = occupied.get(host);
      // An alias on the main application also suppresses a named-service route
      // owned by that same branch. Only a primary host may share its own alias.
      const owner = occupiedOwner && (occupiedOwner !== b.id || !primaryHosts.includes(host))
        ? occupiedOwner : [...owners.get(host)!].find(id => id !== b.id);
      if (owner && (!oldHosts.has(host) || primaryHosts.includes(host)))
        collision.push({ host, branchId: owner, projectId: state.getBranch(owner)?.projectId, reason: "occupied" });
      else if (primaryHosts.includes(host) && /^(www|cds|admin|dashboard|switch|preview)\./.test(host))
        collision.push({ host, reason: "reserved" });
    }
  }
  return collision;
}

export interface PreviewAddressProbe {
  ok: boolean;
  message: string;
  status?: number;
  assets?: number;
}
/** Only server-produced URLs are accepted by the caller. Never forwards human cookies/credentials. */
export async function probePreviewAddress(
  url: string,
  branchId: string,
): Promise<PreviewAddressProbe> {
  const origin = new URL(url).origin;
  const request = async (target: string) => {
    let current = target;
    for (let i = 0; i < 4; i++) {
      const response = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
        headers: {
          "User-Agent": "curl/8.5.0",
          Accept: "text/html,application/javascript,text/css;q=0.9",
        },
      });
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.get("location")
      ) {
        const next = new URL(response.headers.get("location")!, current);
        await response.body?.cancel();
        if (next.origin !== origin)
          throw new Error("入口跳转到了其他站点，无法确认本分支页面。");
        current = next.href;
        continue;
      }
      const reader = response.body?.getReader();
      let body = "";
      const decoder = new TextDecoder();
      let bytes = 0;
      if (reader)
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 2 * 1024 * 1024)
              throw new Error("入口响应过大，无法完成检查。");
            body += decoder.decode(part.value, { stream: true });
          }
          body += decoder.decode();
        } finally {
          await reader.cancel().catch(() => {});
        }
      return { response, body, url: current };
    }
    throw new Error("入口跳转次数过多，请检查应用登录或首页设置。");
  };
  try {
    const page = await request(url);
    const status = page.response.status;
    if (
      status !== 200 ||
      !/text\/html/i.test(page.response.headers.get("content-type") || "") ||
      !page.body.trim()
    )
      return {
        ok: false,
        status,
        message: "入口尚未返回可用的 HTML 页面，请检查分支状态后重试。",
      };
    if (page.response.headers.get("x-cds-branch") !== branchId)
      return {
        ok: false,
        status,
        message:
          "页面可响应，但尚未确认路由属于当前分支，请等待路由发布后重试。",
      };
    if (
      /CDS Preview (Failed|Loading)|CDS PREVIEW FAILED|data-cds-waiting/i.test(
        page.body,
      )
    )
      return {
        ok: false,
        status,
        message: "入口仍处于部署等待或失败页面，请检查分支运行状态。",
      };
    const assets: string[] = [];
    for (const tag of page.body.matchAll(/<(script|link)\b[^>]*>/gi)) {
      if (
        tag[1].toLowerCase() === "link" &&
        !/\brel=["']stylesheet["']/i.test(tag[0])
      )
        continue;
      const path = /\b(?:src|href)=["']([^"']+)["']/i.exec(tag[0])?.[1];
      if (!path) continue;
      const asset = new URL(path.replace(/&amp;/g, "&"), page.url);
      if (asset.origin === origin && !assets.includes(asset.href))
        assets.push(asset.href);
    }
    for (const asset of assets.slice(0, 6)) {
      const result = await request(asset);
      if (
        result.response.status !== 200 ||
        !result.body.trim() ||
        !/(javascript|text\/css)/i.test(
          result.response.headers.get("content-type") || "",
        ) ||
        result.response.headers.get("x-cds-branch") !== branchId
      )
        return {
          ok: false,
          message:
            "页面可打开，但入口脚本或样式未通过检查，请检查静态资源后重试。",
        };
    }
    return {
      ok: true,
      status,
      assets: Math.min(assets.length, 6),
      message: `页面归属、HTML 与 ${Math.min(assets.length, 6)} 个同源入口资源检查通过。`,
    };
  } catch {
    return {
      ok: false,
      message:
        "公开入口暂时无法访问或检查超时，请确认 DNS、证书和分支服务状态后重试。",
    };
  }
}
