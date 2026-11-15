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
  await page.locator("#llmgw-username").fill("demo");
  await page.locator("#llmgw-password").fill("demo");
  await page.locator("button[type=submit]").click();
  await expect(page.locator(".lg-console-content")).toBeVisible();
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
