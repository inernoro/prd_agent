import { test, expect } from "@playwright/test";
import { installOperationsFixtures } from "../fixtures/admin-operations.mjs";

const gateway = process.env.COLLECTION_SCROLL_BASE || "http://127.0.0.1:8200/llmgw";

// Two records can exceed a phone viewport. A natural-height inner list must
// pass wheel input to its scrolling page rather than trap it at a zero range.
for (const width of [390, 320]) for (const theme of ["light", "dark"]) {
  test(`${width} ${theme} 少量密钥末项可从卡片区域滚动到达`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 568 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await installOperationsFixtures(page);
    await page.route(/\/gw\/service-keys(?:\?.*)?$/, route => route.fulfill({ json: {
      success: true, data: ["beta", "alpha"].map((suffix, index) => ({
        id: `scroll-key-${suffix}`, name: `scroll-readability-${suffix}-integration`,
        keyPrefix: `gwk_fixture_${suffix}`, enabled: true, sourceSystem: "external",
        clientCode: `scroll-${suffix}`, environment: "test", purpose: "external-platform",
        appCallerCodes: [`scroll-${suffix}.read::chat`], ingressProtocols: ["openai-compatible"],
        scopes: ["route:read"], allowedCidrs: [], rotationState: "active",
        expiresAt: "2099-01-01T00:00:00Z", teamId: "team",
        createdAt: `2026-11-1${5-index}T08:30:00Z`, createdByUsername: "fixture-owner",
      })),
    } }));
    await page.addInitScript(value => localStorage.setItem("llmgw.theme", value), theme);
    await page.goto(gateway + "/login");
    await page.locator("#llmgw-username").fill("demo");
    await page.locator("#llmgw-password").fill("demo");
    await page.locator("button[type=submit]").click();
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page.getByRole("link", { name: "接入密钥", exact: true }).click();
    const cards = page.locator(".lg-service-key-card");
    await expect(cards).toHaveCount(2);
    const last = cards.last();
    const name = await last.locator(".lg-service-key-card-heading strong").innerText();
    const target = last.getByRole("button", { name: /个调用用途/ });
    const initial = await target.boundingBox();
    expect(initial).not.toBeNull();
    expect(initial!.y + initial!.height).toBeGreaterThan(page.viewportSize()!.height);
    // Use the visible part of the actual card region; never scrollIntoView,
    // focus, locator auto-scroll or a different blank area to rescue this path.
    const first = await cards.first().boundingBox();
    expect(first).not.toBeNull();
    const pointer = { x: first!.x + first!.width / 2,
      y: Math.min(first!.y + 40, page.viewportSize()!.height - 20) };
    await page.mouse.move(pointer.x, pointer.y);
    const hit = await page.evaluate(point => Boolean(document.elementFromPoint(point.x, point.y)?.closest(".lg-service-key-card")), pointer);
    expect(hit).toBe(true);
    let reached = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      await page.mouse.wheel(0, 360);
      await page.waitForTimeout(100);
      const box = await target.boundingBox();
      if (box && box.y >= 0 && box.y + box.height <= page.viewportSize()!.height) { reached = true; break; }
    }
    expect(reached, "ordinary wheel input over short cards must reach the last key permission action").toBe(true);
    expect(await target.evaluate(node => {
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return hit !== null && node.contains(hit);
    }), "the reached permission action must be unobscured").toBe(true);
    await target.click();
    const pane = page.getByRole("complementary", { name: "清单详情", exact: true });
    await expect(pane.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(pane.getByText("route:read", { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("short-keys-permissions.png") });
    await page.keyboard.press("Escape");
    await expect(pane).toBeHidden();
    await expect(target).toBeFocused();
    // Another short-collection consumer keeps the same keyboard return rule.
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page.getByRole("link", { name: "上游", exact: true }).click();
    const models = page.locator(".lg-collection-provider-row td:nth-child(2) button").first();
    await models.click();
    await expect(pane.getByRole("heading", { name: "验收供应方", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pane).toBeHidden();
    await expect(models).toBeFocused();
    await models.click();
    await expect(pane).toBeVisible();
    // Adversarial focus stimulus: a subsequent task claims focus in the same
    // event turn as the pane closes. Deferred restoration must respect it.
    await page.evaluate(() => {
      (document.querySelector(".lg-collection-close") as HTMLButtonElement).click();
      const dialog = document.createElement("dialog");
      dialog.id = "fixture-subsequent-focus";
      dialog.setAttribute("aria-label", "后续任务（合成边界测试）");
      const button = document.createElement("button");
      button.textContent = "合成后续确认";
      dialog.append(button); document.body.append(dialog);
      dialog.showModal(); button.focus();
    });
    await expect(page.getByRole("button", { name: "合成后续确认", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.querySelector("#fixture-subsequent-focus")?.remove());
    expect(errors).toEqual([]);
  });
}
