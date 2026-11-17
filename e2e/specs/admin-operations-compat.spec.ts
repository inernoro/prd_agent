import { observeNativeAudio, nativeAudioEvidence } from '../fixtures/admin-operations-audio';
import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  installOperationsFixtures,
  targetName,
} from "../fixtures/admin-operations.mjs";
test.beforeEach(async ({ browser, page }, testInfo) => {
  page.on("pageerror", (error) =>
    testInfo.annotations.push({
      type: "pageerror",
      description: error.message,
    }),
  );
  testInfo.annotations.push({
    type: "engine-version",
    description: browser.version(),
  });
});
test.afterEach(async ({}, testInfo) => {
  expect(testInfo.annotations.filter((a) => a.type === "pageerror")).toEqual(
    [],
  );
});
async function reachable(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  await locator.click({ trial: true });
  const r = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, width: innerWidth };
  });
  expect(r.left).toBeGreaterThanOrEqual(-2);
  expect(r.right).toBeLessThanOrEqual(r.width + 2);
}
async function loginGateway(page: Page) {
  await page.goto("http://127.0.0.1:8200/llmgw/login", {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator(".consciousness-art")).toHaveJSProperty("naturalWidth", 1672);
  await page.locator("#llmgw-username").fill("demo");
  await page.locator("#llmgw-password").fill("demo");
  await page.locator("button[type=submit]").click();
  await expect(page.locator(".gateway-entry")).toHaveAttribute("data-phase", "authorized");
  await expect(page).toHaveURL(/\/llmgw\/quickstart$/);
  await expect(page.getByRole("textbox", { name: "我想做什么", exact: true })).toBeEditable();
  await expect(page.getByRole("button", { name: "进入控制台", exact: true })).toHaveCount(0);
  const coverage = await page.locator('.gateway-quickstart-stage').evaluate(stage => {
    const main = stage.closest('main')!.getBoundingClientRect();
    const scene = stage.querySelector('.consciousness-scene')!.getBoundingClientRect();
    const heading = stage.querySelector('h1')!.getBoundingClientRect();
    return { gaps: [scene.left-main.left, scene.top-main.top, main.right-scene.right, main.bottom-scene.bottom], headingInside: heading.top >= scene.top && heading.bottom <= scene.bottom, radius: getComputedStyle(stage).borderRadius };
  });
  expect(coverage.gaps.every(gap => Math.abs(gap) < 2)).toBe(true);
  expect(coverage.headingInside).toBe(true);
  expect(coverage.radius).toBe('0px');
  await expect(page.locator(".lg-console-content")).toBeVisible();
  await expect(page.locator(".lg-console-header")).toBeVisible({ timeout: 12000 });
  await expect(page.locator(".lg-console-header input")).toHaveCount(0);
  await expect(page.locator(".gateway-quickstart-stage textarea")).toHaveCount(1);
  const expandMenu = page.getByRole("button", { name: "展开菜单", exact: true });
  if (await expandMenu.isVisible()) {
    const sidebar = page.locator(".lg-console-sidebar");
    await expect.poll(() => sidebar.evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(64);
    await expandMenu.click();
    await expect.poll(() => sidebar.evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(224);
    await expect(page.getByRole("button", { name: "收起菜单", exact: true })).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("button", { name: "收起菜单", exact: true }).click();
    await expect.poll(() => sidebar.evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(64);
  }
  if (await page.getByLabel("打开导航", { exact: true }).isVisible())
    await page.getByLabel("打开导航", { exact: true }).click();
  await page.locator('nav a[href="/llmgw/logical-models"]').click();
}
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 800, height: 600 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
])
  for (const theme of ["light", "dark"]) {
    test(`${viewport.width} ${theme} 核心管理操作`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await installOperationsFixtures(page);
      await page.addInitScript((t) => {
        localStorage.setItem("cds_theme", t);
        localStorage.setItem("cds_ui_scale", "100");
        localStorage.setItem("llmgw.theme", t);
      }, theme);
      await page.goto("http://127.0.0.1:5273/project-list");
      if (await page.getByLabel("打开导航菜单").isVisible())
        await page.getByLabel("打开导航菜单").click();
      await page
        .getByRole("link", { name: "发布控制台", exact: true })
        .first()
        .click();
      await reachable(page.getByLabel("要发布的版本"));
      await page.getByRole("button", { name: "开始发布", exact: true }).click();
      const confirm = page.getByRole("button", {
        name: `确认发布到 ${targetName}`,
        exact: true,
      });
      await reachable(confirm);
      await confirm.click();
      await expect(
        page.getByText("隔离预检失败", { exact: false }).first(),
      ).toBeVisible();
      await page.getByRole("button", { name: "流水线", exact: true }).click();
      await reachable(page.getByRole("button", { name: "关闭", exact: true }));
      await page.getByRole("button", { name: "关闭", exact: true }).click();
      await page.getByRole("tab", { name: /^失败/ }).click();
      await page
        .getByRole("button", { name: "看日志", exact: true })
        .first()
        .click();
      await expect(
        page.getByText("COMPAT_LOG_END", { exact: true }).last(),
      ).toBeAttached();
      const lastLog = page.locator(".cds-log-line").last();
      await lastLog.scrollIntoViewIfNeeded();
      await expect(lastLog).toBeVisible();
      await expect(lastLog).toContainText("COMPAT_LOG_END");
      expect(
        await lastLog.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.right <= innerWidth + 2;
        }),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath("release-console.png"),
      });
      await testInfo.attach("发布控制台", {
        path: testInfo.outputPath("release-console.png"),
        contentType: "image/png",
      });
      await loginGateway(page);
      await page
        .getByRole("button", { name: "查看", exact: true })
        .first()
        .click();
      const pane = page.getByRole("complementary", { name: "清单详情" });
      await reachable(
        pane.getByRole("button", { name: "升级策略", exact: true }),
      );
      await pane.getByRole("button", { name: "模型配置", exact: true }).click();
      await pane
        .getByRole("button", { name: "指定调用方", exact: true })
        .click();
      const input = page.getByLabel("验收模型 指定的调用方");
      await reachable(input);
      await input.fill("compat.test::chat");
      await reachable(pane.getByRole("button", { name: "保存", exact: true }));
      await pane.getByRole("button", { name: "保存", exact: true }).click();
      await expect(
        page.getByText("1 个调用方不点名时，从现在起走「验收模型」", {
          exact: true,
        }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("logical-models.png"),
      });
      await testInfo.attach("模型配置", {
        path: testInfo.outputPath("logical-models.png"),
        contentType: "image/png",
      });
    });
  }
test("320 双倍字号模型配置回归", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await installOperationsFixtures(page);
  await loginGateway(page);
  await page.addStyleTag({
    content:
      ".lg-collection-page { --fs-body: 28px; --fs-secondary: 26px; --fs-heading: 32px; --fs-caption: 24px; }",
  });
  await page.getByRole("button", { name: "查看", exact: true }).first().click();
  const pane = page.getByRole("complementary", { name: "清单详情" });
  await reachable(pane.getByRole("button", { name: "升级策略", exact: true }));
  expect(
    await pane.evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(1);
  await pane.getByRole("button", { name: "模型配置", exact: true }).click();
  await pane.getByRole("button", { name: "指定调用方", exact: true }).click();
  await reachable(page.getByLabel("验收模型 指定的调用方"));
  await reachable(pane.getByRole("button", { name: "保存", exact: true }));
});
async function keyboardViewport(page: Page) {
  await page.evaluate(() => {
    const viewport = new EventTarget();
    Object.assign(viewport, {
      width: 390,
      height: 300,
      offsetTop: 120,
      offsetLeft: 0,
      scale: 1,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
    window.dispatchEvent(new Event("resize"));
  });
}
async function insideKeyboardViewport(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.click({ trial: true });
  const r = await locator.boundingBox();
  expect(r).not.toBeNull();
  expect(r!.y).toBeGreaterThanOrEqual(120);
  expect(r!.y + r!.height).toBeLessThanOrEqual(421);
}
for (const theme of ["light", "dark"])
  test(`${theme} 可视区域缩小与共享弹窗`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const fixture = await installOperationsFixtures(page);
    await page.addInitScript((t) => {
      localStorage.setItem("cds_theme", t);
      localStorage.setItem("llmgw.theme", t);
    }, theme);
    // 发布中心是共享 Dialog 的另一个实际使用方。
    await page.goto(
      "http://127.0.0.1:5273/release-center?project=fixture-project",
    );
    await page.getByRole("button", { name: "环境与配置", exact: true }).click();
    await page.getByRole("button", { name: "添加环境", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await keyboardViewport(page);
    await insideKeyboardViewport(
      dialog.getByRole("button", { name: "关闭", exact: true }),
    );
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await loginGateway(page);
    await page.getByRole("button", { name: "查看", exact: true }).click();
    const pane = page.getByRole("complementary", { name: "清单详情" });
    await pane.getByRole("button", { name: "模型配置", exact: true }).click();
    await pane.getByRole("button", { name: "删除", exact: true }).click();
    const prompt = page.getByRole("dialog");
    await expect(prompt).toBeVisible();
    await keyboardViewport(page);
    await prompt.getByLabel("确认请输入 publicId").fill("compat-model");
    await insideKeyboardViewport(
      prompt.getByRole("button", { name: "删除", exact: true }),
    );
    await insideKeyboardViewport(
      prompt.getByRole("button", { name: "取消", exact: true }),
    );
    await prompt.getByRole("button", { name: "取消", exact: true }).click();
    expect(
      fixture.writes.some((x: { method: string }) => x.method === "DELETE"),
    ).toBe(false);
  });
for (const theme of ["light", "dark"])
  test(`${theme} 共享详情其他使用方和长调用日志`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const fixture = await installOperationsFixtures(page);
    await page.addInitScript(
      (t) => localStorage.setItem("llmgw.theme", t),
      theme,
    );
    await loginGateway(page);
    async function nav(path: string) {
      if (await page.getByLabel("打开导航", { exact: true }).isVisible())
        await page.getByLabel("打开导航", { exact: true }).click();
      await page.locator(`nav a[href="/llmgw/${path}"]`).click();
    }
    await nav("platforms");
    await page
      .getByRole("button", { name: "还没有模型", exact: false })
      .click();
    let pane = page.getByRole("complementary", { name: "清单详情" });
    await pane.getByRole("button", { name: "连接配置", exact: true }).click();
    await reachable(
      pane.getByRole("button", { name: "编辑连接", exact: true }),
    );
    await pane.getByRole("button", { name: "关闭详情", exact: true }).click();
    await nav("service-keys");
    await page
      .getByRole("button", { name: "1 个调用用途", exact: true })
      .first()
      .click();
    pane = page.getByRole("complementary", { name: "清单详情" });
    await pane.getByRole("button", { name: "轮换与使用", exact: true }).click();
    await pane.getByRole("button", { name: "撤销", exact: true }).click();
    const revoke = page.getByRole("dialog");
    await reachable(revoke.getByRole("button", { name: "取消", exact: true }));
    await revoke.getByRole("button", { name: "取消", exact: true }).click();
    expect(fixture.writes.some((write) => write.method === "DELETE")).toBe(
      false,
    );
    await reachable(
      pane.getByRole("button", { name: "关闭详情", exact: true }),
    );
    await pane.getByRole("button", { name: "关闭详情", exact: true }).click();
    await nav("logs");
    await page
      .getByRole("button", { name: /11-12 00:00 compat-model/ })
      .click({ position: { x: 5, y: 5 } });
    const detail = page.getByRole("dialog", { name: "请求详情" });
    await expect(detail).toBeVisible();
    await detail.getByRole("tab", { name: "请求与响应", exact: true }).click();
    await expect(
      detail.getByText(/request-long-request/).first(),
    ).toBeVisible();
    await detail.getByRole("tab", { name: "审计", exact: true }).click();
    await reachable(
      detail.getByRole("button", { name: "关闭详情", exact: true }),
    );
    await detail.getByRole("button", { name: "关闭详情", exact: true }).click();
    fixture.setError(true);
    await nav("logical-models");
    await expect(page.getByRole("alert")).toContainText("加载失败，请重试");
    fixture.setError(false);
    await nav("logs");
    await nav("logical-models");
    await expect(
      page.getByRole("button", { name: "查看", exact: true }),
    ).toBeVisible();
  });
for (const theme of ["light", "dark"]) {
  test(`320 ${theme} CDS 双倍字号完整确认目标`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await installOperationsFixtures(page);
    await page.addInitScript((t) => localStorage.setItem("cds_theme", t), theme);
    await page.goto("http://127.0.0.1:5273/project-list");
    await page.getByLabel("打开导航菜单").click();
    await page.getByRole("link", { name: "发布控制台", exact: true }).click();
    await expect(page.getByLabel("要发布的版本")).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await reachable(page.getByLabel("要发布的版本"));
    await page.getByRole("button", { name: "开始发布", exact: true }).click();
    const confirm = page.getByRole("button", {
      name: `确认发布到 ${targetName}`,
      exact: true,
    });
    const target = page.getByRole("region", { name: "本次发布目标", exact: true });
    await expect(target).toHaveText(targetName);
    await target.scrollIntoViewIfNeeded();
    const targetLayout = await target.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return { width: el.clientWidth, height: el.clientHeight, bottom: el.scrollTop + el.clientHeight, fullHeight: el.scrollHeight, viewport: innerHeight };
    });
    expect(targetLayout.height).toBeLessThanOrEqual(targetLayout.viewport * 0.4 + 1);
    expect(targetLayout.bottom).toBeGreaterThanOrEqual(targetLayout.fullHeight - 1);
    await reachable(confirm);
    const layout = await confirm.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const label = el.querySelector("span")!;
      const text = label.getBoundingClientRect();
      return {
        buttonHeight: rect.height,
        textWidth: text.width,
        fontSize: parseFloat(getComputedStyle(label).fontSize),
        viewportHeight: innerHeight,
      };
    });
    // 横向不溢出、trial click 成功仍可能是逐字竖排的多屏按钮。
    expect(layout.buttonHeight).toBeLessThan(layout.viewportHeight - 32);
    expect(layout.textWidth).toBeGreaterThanOrEqual(layout.fontSize * 4);
    await testInfo.attach("大字确认布局", {
      body: JSON.stringify(layout), contentType: "application/json",
    });
    expect(
      await confirm.evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("large-text-confirm.png") });
    await testInfo.attach("完整确认目标", {
      path: testInfo.outputPath("large-text-confirm.png"), contentType: "image/png",
    });
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "开始发布", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "开始发布", exact: true }).click();
    await confirm.click();
    await expect(page.getByText("隔离预检失败", { exact: false }).first()).toBeVisible();
  });
}
test("390 隔离发布成功闭环", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await installOperationsFixtures(page);
  fixture.setPreflightPass(true);
  await page.goto("http://127.0.0.1:5273/project-list");
  await page.getByLabel("打开导航菜单").click();
  await page.getByRole("link", { name: "发布控制台", exact: true }).click();
  await page.getByRole("button", { name: "开始发布", exact: true }).click();
  const confirm = page.getByRole("button", {
    name: `确认发布到 ${targetName}`,
    exact: true,
  });
  await reachable(confirm);
  await confirm.click();
  const output = page
    .locator(".cds-log-line")
    .filter({ hasText: "COMPAT_RELEASE_SUCCESS" });
  await output.scrollIntoViewIfNeeded();
  await expect(output).toBeVisible();
  expect(
    fixture.writes.filter((write) =>
      write.path.endsWith("/branches/compat-branch/runs"),
    ),
  ).toEqual([
    {
      path: "/api/releases/branches/compat-branch/runs",
      method: "POST",
      body: { targetId: "compat-target", previewUrl: "https://example.test" },
    },
  ]);
});

for (const width of [390, 1440])
  for (const theme of ["light", "dark"]) {
    test(`${width} ${theme} 电影式接入全流程与账户组织布局`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const { writes } = await installOperationsFixtures(page, { quickstart: true });
      await observeNativeAudio(page);
      await page.addInitScript(t => localStorage.setItem("llmgw.theme", t), theme);
      await page.goto("http://127.0.0.1:8200/llmgw/login");
      await page.locator("#llmgw-username").fill("demo");
      await page.locator("#llmgw-password").fill("demo");
      await page.getByRole("button", { name: "开始身份确认", exact: true }).click();
      await expect(page).toHaveURL(/\/quickstart$/);
      await expect(page.locator(".lg-console-header")).toBeVisible({ timeout: 12000 });

      await page.reload();
      const firstNavigation = page.locator(".lg-console-sidebar nav a").first();
      await expect(firstNavigation).toHaveAttribute("aria-label", "对话");
      await expect(firstNavigation).toHaveAttribute("href", /\/quickstart$/);
      await expect(page.locator(".gateway-identity-card")).toHaveCount(0);
      await expect(page.locator(".consciousness-ghost > span")).toHaveText("LLM Gateway");
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      const userMenu = page.locator("details.lg-user-menu");
      const userToggle = page.getByLabel("打开用户菜单", { exact: true });
      const setTheme = async (next: string) => {
        await userToggle.click();
        await page.getByRole("button", { name: next === "light" ? "切换浅色" : "切换深色", exact: true }).click();
        await expect(userMenu).not.toHaveAttribute("open", "");
        await expect(page.locator("html")).toHaveAttribute("data-theme", next);
        await expect(page.locator(".gateway-quickstart-stage")).toHaveCSS("color-scheme", next);
      };
      const navigateTo = async (name: string) => {
        if (await page.getByLabel("打开导航", { exact: true }).isVisible()) await page.getByLabel("打开导航", { exact: true }).click();
        await page.locator(".lg-console-sidebar nav").getByRole("link", { name, exact: true }).click();
      };
      const otherTheme = theme === "light" ? "dark" : "light";
      const originalInk = await page.locator(".gateway-intent-heading").evaluate(el => getComputedStyle(el).color);
      await setTheme(otherTheme);
      expect(await page.locator(".gateway-intent-heading").evaluate(el => getComputedStyle(el).color)).not.toBe(originalInk);
      await navigateTo("概览");
      await expect(page.locator("html")).toHaveAttribute("data-theme", otherTheme);
      await navigateTo("对话");
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", otherTheme);
      await expect(page.locator(".gateway-quickstart-stage")).toHaveCSS("color-scheme", otherTheme);
      await setTheme(theme);
      await userToggle.click();
      await page.locator(".lg-user-popover").getByLabel("切换组织", { exact: true }).click();
      const organizations = page.locator("details.gateway-account-organizations");
      await expect(organizations).toHaveAttribute("open", "");
      await expect(userMenu).toHaveAttribute("open", "");
      await page.locator(".lg-console-brand > span:last-child").click();
      await expect(userMenu).not.toHaveAttribute("open", "");
      await expect(organizations).not.toHaveAttribute("open", "");
      await userToggle.click();
      await page.keyboard.press("Escape");
      await expect(userMenu).not.toHaveAttribute("open", "");
      await expect(userToggle).toBeFocused();
      await page.locator(".gateway-entry-help > summary").click();
      await page.locator(".lg-console-brand > span:last-child").click();
      await expect(page.locator(".gateway-entry-help")).not.toHaveAttribute("open", "");
      const hoverTarget = page.locator(".gateway-intent-starters button").first();
      const idleBackground = await hoverTarget.evaluate(el => getComputedStyle(el).backgroundColor);
      await hoverTarget.hover();
      await expect.poll(() => hoverTarget.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(idleBackground);
      await page.mouse.move(0, 0);
      const starters = page.getByRole("group", { name: "从一个想法开始" });
      await expect(starters.getByRole("button")).toHaveCount(4);
      const draftCalls = () => writes.filter(write => write.path === "/app-callers/draft").length;
      const before = draftCalls();
      await starters.getByRole("button", { name: "搭建知识库助手", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "我想做什么", exact: true })).toHaveValue(/团队知识库助手/);
      expect(draftCalls()).toBe(before);
      await page.locator(".gateway-entry-help > summary").click();
      await expect(page.locator(".gateway-entry-help-body")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await page.getByRole("button", { name: "试试这句", exact: true }).click();
      await expect(page.locator(".gateway-entry-help")).not.toHaveAttribute("open", "");
      await page.getByRole("button", { name: "准备接入", exact: true }).click();
      await expect(page.getByRole("heading", { name: "确认你的接入", exact: true })).toBeVisible();
      await page.reload();
      await page.locator(".gateway-entry-resume button").click();
      await expect(page.getByRole("textbox", { name: "我想做什么", exact: true })).toHaveValue(/产品文档.*售后同事/);
      expect(draftCalls()).toBe(before + 1);
      const sound = page.locator(".gateway-chrome-sound");
      await expect(sound).toHaveAttribute("data-audio-status", "pending");
      if (await sound.getAttribute("data-audio-status") === "ready") await sound.click();
      await sound.click();
      try {
        await expect(sound).toHaveAttribute("data-audio-status", "ready");
      } finally {
        const evidence = await nativeAudioEvidence(page);
        console.log("Layout native audio evidence:", testInfo.title, JSON.stringify(evidence));
        await testInfo.attach("layout-native-audio", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
      }
      await sound.click();
      await expect(sound).toHaveAttribute("data-audio-status", "muted");
      await page.getByLabel("打开用户菜单", { exact: true }).click();
      await page.locator(".lg-user-popover").getByLabel("切换组织", { exact: true }).click();
      const account = page.locator(".lg-user-popover");
      await expect(account.getByRole("menu", { name: "可用组织" })).toBeVisible();
      const menuBounds = await account.evaluate(el => {
        const list = el.querySelector(".gateway-account-organization-list")!.getBoundingClientRect();
        const menu = el.getBoundingClientRect();
        const name = el.querySelector(".gateway-account-organizations > summary > span")!;
        return { inside: list.left >= menu.left && list.right <= menu.right, overflow: el.scrollWidth > el.clientWidth, nameWidth: name.getBoundingClientRect().width, nameBackground: getComputedStyle(name).backgroundColor };
      });
      expect(menuBounds.inside).toBe(true);
      expect(menuBounds.overflow).toBe(false);
      expect(menuBounds.nameWidth).toBeGreaterThan(100);
      expect(menuBounds.nameBackground).toBe("rgba(0, 0, 0, 0)");
      await testInfo.attach("account-organization", { body: await page.screenshot(), contentType: "image/png" });
      await page.getByLabel("打开用户菜单", { exact: true }).click();

      const assertScene = async (step: string) => {
        await expect(page.locator(".gateway-flow-frame")).toHaveAttribute("data-step", step);
        await expect(page.locator(".gateway-flow-frame")).toHaveCSS("transform", "none");
        await expect(page.locator(".consciousness-art")).toHaveJSProperty("naturalWidth", 1672);
        const state = await page.locator(".gateway-quickstart-stage").evaluate(stage => {
          const scene = stage.querySelector(".consciousness-scene")!.getBoundingClientRect(), main = stage.closest("main")!.getBoundingClientRect();
          const surface = stage.querySelector(".lg-qs-step-card, .lg-qs-key-hero");
          return { gaps: [scene.left - main.left, scene.top - main.top, main.right - scene.right, main.bottom - scene.bottom], blur: surface ? getComputedStyle(surface).backdropFilter : "", overflow: document.documentElement.scrollWidth > innerWidth };
        });
        expect(state.gaps.every(gap => Math.abs(gap) < 2)).toBe(true);
        expect(state.overflow).toBe(false);
        expect(state.blur).toContain("blur");
        await testInfo.attach(step, { body: await page.screenshot(), contentType: "image/png" });
      };
      await page.getByRole("textbox", { name: "我想做什么", exact: true }).fill("为团队知识库接入问答助手");
      await page.getByRole("textbox", { name: "我想做什么", exact: true }).press("Enter");
      await expect(page.getByRole("button", { name: "下一步", exact: true })).toBeEnabled();
      await assertScene("draft");
      await page.getByRole("button", { name: "下一步", exact: true }).click();
      await page.getByRole("radio", { name: "知识库团队", exact: true }).click();
      await page.getByRole("textbox", { name: "月预算（美元）", exact: true }).fill("25");
      await assertScene("owner");
      const advancedGap = await page.locator(".lg-qs-create-footer").evaluate(el => {
        const summary = el.parentElement!.querySelector(".lg-explainer > summary")!;
        return el.getBoundingClientRect().top - summary.getBoundingClientRect().bottom;
      });
      expect(advancedGap).toBeGreaterThanOrEqual(0);
      await page.getByRole("button", { name: "回上一步", exact: true }).click();
      await expect(page.getByText("team.knowledge::chat", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "下一步", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "月预算（美元）", exact: true })).toHaveValue("25");
      await page.getByRole("button", { name: "创建密钥", exact: true }).click();
      await expect(page.getByText("gwk_fixture_visual_only_not_a_credential", { exact: true })).toBeVisible();
      await assertScene("result");
      await expect(page.getByText(/未访问上游。/)).toBeVisible();
      const governance = writes.find(w => w.path === "/app-callers/fixture-caller" && w.method === "PUT")!.body as { monthlyBudgetUsd: number; budgetReservationUsd: number };
      expect(governance.monthlyBudgetUsd).toBe(25);
      expect(governance.budgetReservationUsd).toBeGreaterThan(0);
      expect(writes.filter(w => w.path === "/service-keys" && w.method === "POST")).toHaveLength(1);
      await page.getByRole("tab", { name: "cURL", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "试跑要发送的内容", exact: true })).toBeVisible();
      await assertScene("result");
      await page.getByRole("tab", { name: "提示词", exact: true }).click();
      await expect(page.getByRole("radiogroup", { name: "调用方式" })).toBeVisible();
      await page.reload();
      await expect(page.locator(".gateway-intent-starters")).toBeVisible();
      await expect(page.locator(".gateway-entry-resume button")).toHaveCount(0);
    });
  }
