// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisualModelSettings } from "./VisualModelSettings";
import {
  getVisualModelCatalog,
  getVisualModelPolicy,
  saveVisualModelPolicy,
  type VisualModelCatalogEntry,
  type VisualModelPolicy,
} from "@/services/real/visualModelPolicy";
const auth = vi.hoisted(() => ({ isRoot: true, permissions: [] as string[] }));
vi.mock("@/stores/authStore", () => ({
  useAuthStore: (selector: (state: typeof auth) => unknown) => selector(auth),
}));
vi.mock("@/components/ui/VideoLoader", () => ({
  MapSectionLoader: ({ text }: { text: string }) => <div>{text}</div>,
  MapSpinner: () => <span>保存中</span>,
}));
vi.mock("@/services/real/visualModelPolicy", () => ({
  getVisualModelCatalog: vi.fn(),
  getVisualModelPolicy: vi.fn(),
  saveVisualModelPolicy: vi.fn(),
}));
const catalog: VisualModelCatalogEntry[] = ["alpha", "beta", "gamma"].map(
  (id) => ({
    model: { code: id, name: `模型 ${id}`, capabilities: ["image_generation"] },
    imageCapabilities: {
      supportsImageToImage: true,
      sizesByResolution: {
        "1K": [{ size: "1024x1024", aspectRatio: "1:1" }],
        "2K": [{ size: "2048x1024", aspectRatio: "2:1" }],
      },
    },
  }),
);
const initial: VisualModelPolicy = {
  revision: 7,
  defaultModelId: "alpha",
  models: [
    { modelId: "alpha", displayName: "模型 alpha", description: "原始说明" },
    { modelId: "beta", displayName: "模型 beta", description: "第二个" },
  ],
};
let root: Root;
let container: HTMLDivElement;
const byLabel = (label: string) => {
  const element = [
    ...document.querySelectorAll<HTMLElement>("[aria-label]"),
  ].find((node) => node.getAttribute("aria-label") === label);
  if (!element) throw new Error(`找不到 ${label}`);
  return element;
};
const button = (text: string) => {
  const element = [...document.querySelectorAll("button")].find(
    (node) => node.textContent === text,
  );
  if (!element) throw new Error(`找不到按钮 ${text}`);
  return element;
};
const click = async (element: HTMLElement) => {
  await act(async () => {
    element.click();
  });
};
const input = async (element: HTMLElement, value: string) => {
  await act(async () => {
    const proto =
      element.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const open = async () => {
  await act(async () => {
    root.render(<VisualModelSettings />);
  });
  await click(button("模型设置"));
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  auth.isRoot = true;
  auth.permissions = [];
  vi.mocked(getVisualModelPolicy).mockResolvedValue({
    success: true,
    error: null,
    data: structuredClone(initial),
  });
  vi.mocked(getVisualModelCatalog).mockResolvedValue({
    success: true,
    error: null,
    data: structuredClone(catalog),
  });
  vi.mocked(saveVisualModelPolicy).mockImplementation(async (policy) => ({
    success: true,
    error: null,
    data: { ...policy, revision: 8 },
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
describe("视觉创作模型设置", () => {
  it("详情选择不修改默认项；搜索、排序、说明及开放项一起保存原 revision", async () => {
    await open();
    await input(byLabel("搜索模型名称或标识"), "beta");
    await click(byLabel("查看 模型 beta"));
    await click(byLabel("上移 模型 beta"));
    await input(byLabel("模型 beta 业务说明"), "新的业务说明");
    await input(byLabel("搜索模型名称或标识"), "");
    await click(byLabel("开放 模型 gamma"));
    await click(button("保存配置"));
    expect(saveVisualModelPolicy).toHaveBeenCalledWith({
      revision: 7,
      defaultModelId: "alpha",
      models: [
        {
          modelId: "beta",
          displayName: "模型 beta",
          description: "新的业务说明",
        },
        initial.models[0],
        { modelId: "gamma", displayName: "模型 gamma", description: undefined },
      ],
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("关闭默认项不自动替换；重新选择已开放模型后才能保存", async () => {
    await open();
    await click(byLabel("开放 模型 alpha"));
    expect(button("保存配置").disabled).toBe(true);
    expect(document.body.textContent).toContain("请选择默认模型");
    await click(byLabel("查看 模型 gamma"));
    expect(button("设为默认模型").disabled).toBe(true);
    await click(byLabel("查看 模型 beta"));
    await click(button("设为默认模型"));
    await click(button("保存配置"));
    expect(saveVisualModelPolicy).toHaveBeenCalledWith({
      ...initial,
      defaultModelId: "beta",
      models: [initial.models[1]],
    });
  });
  it("失效默认项保留用于迁移，不能保存或作为新默认项", async () => {
    vi.mocked(getVisualModelCatalog).mockResolvedValue({
      success: true,
      error: null,
      data: catalog.slice(1),
    });
    await open();
    expect(document.body.textContent).toContain("默认模型已不可用");
    expect(button("保存配置").disabled).toBe(true);
    expect(button("设为默认模型").disabled).toBe(true);
    await click(byLabel("开放 模型 alpha"));
    await click(byLabel("查看 模型 beta"));
    await click(button("设为默认模型"));
    await click(button("保存配置"));
    expect(
      vi
        .mocked(saveVisualModelPolicy)
        .mock.calls[0][0].models.map((model) => model.modelId),
    ).toEqual(["beta"]);
  });
  it("刷新与保存失败保留草稿；取消后重新打开恢复服务器配置", async () => {
    await open();
    await input(byLabel("模型 alpha 业务说明"), "尚未保存");
    await click(button("刷新目录"));
    expect((byLabel("模型 alpha 业务说明") as HTMLTextAreaElement).value).toBe(
      "尚未保存",
    );
    vi.mocked(saveVisualModelPolicy).mockResolvedValueOnce({
      success: false,
      data: null,
      error: { code: "CONFLICT", message: "配置已更新，请重新加载后重试。" },
    });
    await click(button("保存配置"));
    expect(document.body.textContent).toContain("配置已更新");
    expect((byLabel("模型 alpha 业务说明") as HTMLTextAreaElement).value).toBe(
      "尚未保存",
    );
    await click(button("重新加载配置"));
    expect((byLabel("模型 alpha 业务说明") as HTMLTextAreaElement).value).toBe("原始说明");
    await input(byLabel("模型 alpha 业务说明"), "取消的修改");
    await click(button("取消"));
    await click(button("模型设置"));
    expect((byLabel("模型 alpha 业务说明") as HTMLTextAreaElement).value).toBe(
      "原始说明",
    );
  });
  it("尺寸按目录分组，完整尺寸和比例可展开", async () => {
    await open();
    expect(document.body.textContent).not.toContain("2048 × 1024");
    await click(button("2K"));
    expect(document.body.textContent).toContain("2048 × 1024");
    await click(button("查看全部尺寸与比例"));
    expect(document.body.textContent).toContain("2:1");
    expect(document.body.textContent).toContain("1024 × 1024");
    await click(button("收起全部尺寸与比例"));
    expect(document.body.textContent).not.toContain("2:1");
  });
  it("无管理权限不显示入口", async () => {
    auth.isRoot = false;
    await act(async () => root.render(<VisualModelSettings />));
    expect(container.textContent).toBe("");
    expect(getVisualModelPolicy).not.toHaveBeenCalled();
  });
});
