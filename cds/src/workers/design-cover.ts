import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { runDesignHandoff, type DesignHandoffInput } from '../services/design-handoff-browser.js';
import { captureDesignReference, type DesignReferenceTarget } from '../services/design-framework-browser.js';
import { decorateDesignPrototype } from '../services/design-prototype.js';
import { createDesignAcceptanceBrowser, fingerprintInstalledDesignBuild,
  type InstalledDesignCaptureReply, type InstalledDesignCaptureRequest } from '../services/design-acceptance-browser.js';
import { PlanningError, rejectPlanning } from '../services/engineering-planning-input.js';

function launchBrowser(executablePath = '/usr/bin/chromium', args: string[] = []) {
  return chromium.launch({ executablePath, timeout: 5000,
    args: ['--disable-background-networking', '--no-proxy-server', ...args] });
}

async function captureInstalled(request: InstalledDesignCaptureRequest, prototype: Buffer): Promise<InstalledDesignCaptureReply> {
  const { kind: _kind, buildDigest, ...input } = request;
  const webDist = '/app/web/dist';
  try {
    const fingerprint = await fingerprintInstalledDesignBuild(webDist, input.commit).catch(() => undefined);
    if (!fingerprint || fingerprint !== buildDigest) {
      return rejectPlanning(409, 'design_capture_build_mismatch', '隔离浏览器里的前端产物与正式站不一致，请更新本提交的渲染产物后重试。');
    }
    const capture = createDesignAcceptanceBrowser(webDist, '/usr/bin/chromium', undefined, launchBrowser);
    const result = await capture?.({ ...input, prototype });
    if (!result) return rejectPlanning(422, 'design_capture_incomplete', '未能进入原型与实现的同一画面，请核对画面绑定后重试。');
    const { reference, implementation, ...evidence } = result;
    if (reference.length > 1536 * 1024 || implementation.length > 1536 * 1024) {
      return rejectPlanning(422, 'design_capture_incomplete', '逐画面对照中的截图超过大小上限，请核对画面后重试。');
    }
    return { ok: true, result: { ...evidence, reference: reference.toString('base64'), implementation: implementation.toString('base64') } };
  } catch (error) {
    if (error instanceof PlanningError) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
}

async function snapshot() {
  if (!existsSync('/.dockerenv') || process.getuid?.() !== 1000) throw new Error('Cover worker requires the render container');
  const reader = createInterface({ input: process.stdin });
  const { value: input } = await reader[Symbol.asyncIterator]().next();
  reader.close();
  process.stdin.pause();
  if (typeof input !== 'string' || input.length > 8 * 1024 * 1024) throw new Error('Invalid cover input');
  const request = JSON.parse(input) as { prototype: string; target: DesignReferenceTarget }
    | { prototype: string; references: DesignReferenceTarget[]; retry?: boolean }
    | (Omit<DesignHandoffInput, 'prototype'> & { prototype: string })
    | InstalledDesignCaptureRequest;
  const prototype = Buffer.from(request.prototype, 'base64');
  if ('kind' in request) {
    if (request.kind !== 'installed-acceptance') throw new Error('Invalid capture kind');
    process.stdout.write(JSON.stringify(await captureInstalled(request, prototype)));
    return;
  }
  // This Chromium process lives in a disposable read-only container with no network, mounts or capabilities.
  const browser = await launchBrowser();
  try {
    if ('cases' in request) {
      const result = await runDesignHandoff(browser, { prototype, cases: request.cases, screens: request.screens });
      process.stdout.write(JSON.stringify(result));
      return;
    }
    const html = decorateDesignPrototype(prototype.toString('utf8'));
    if ('references' in request) {
      const pngs: Array<string | null> = [];
      for (const target of request.references) {
        const bytes = await captureDesignReference(browser, html, target, request.retry === true);
        pngs.push(bytes && bytes.length <= 1536 * 1024 ? bytes.toString('base64') : null);
      }
      process.stdout.write(JSON.stringify(pngs));
      return;
    }
    const bytes = await captureDesignReference(browser, html, request.target);
    if (!bytes) throw new Error('Cover screen is unavailable');
    process.stdout.write(bytes.toString('base64'));
  } finally {
    await browser.close().catch(() => {});
  }
}

snapshot().catch(() => {
  process.stderr.write('CDS isolated design browser could not complete the request\n');
  process.exitCode = 1;
});
