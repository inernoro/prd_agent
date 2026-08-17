import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildStableSmokeAuthHeaders } from './stable-smoke-signature.mjs';

function readArg(argv, name, fallback = '') {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
}

export function buildNotificationPayload(options) {
  const isTest = options.isTest === true;
  const source = options.source || 'stable-smoke';
  const title = isTest ? '稳定冒烟通知通道测试' : `稳定冒烟${options.verdict === 'fail' ? '失败' : '需要确认'}`;
  const detail = [
    `运行：${options.runId}`,
    `环境：${options.environment}`,
    `模块：${options.module || '整轮'}`,
    options.caseId ? `用例：${options.caseId}` : '',
    options.requestId ? `追踪号：${options.requestId}` : '',
    `处理：${isTest ? '这是一条通道测试，无需处理。' : options.recovery}`,
  ].filter(Boolean).join('\n');

  return {
    source,
    title,
    message: detail,
    level: isTest ? 'info' : options.verdict === 'fail' ? 'error' : 'warning',
    targetUserId: options.targetUserId || undefined,
    targetUsername: options.targetUserId ? undefined : options.targetUsername,
    actionLabel: options.actionLabel || '查看验收证据',
    actionUrl: options.reportUrl,
    actionKind: 'open-url',
    section: 'admin',
    dedupKey: isTest
      ? 'stable-smoke-channel-test'
      : `${options.runId}:${options.environment}:${options.caseId || 'run'}:${options.module || 'all'}`,
    expiresInDays: isTest ? 3 : 30,
  };
}

export function validateNotificationOptions(options) {
  const errors = [];
  if (!['fail', 'conditional', 'pass'].includes(options.verdict)) errors.push('verdict 必须是 pass、conditional 或 fail');
  if (!options.runId) errors.push('缺少 runId');
  if (!options.environment) errors.push('缺少 environment');
  if (!options.targetUserId && !options.targetUsername) {
    errors.push('缺少定向通知用户，拒绝发送全局通知');
  }
  if (!options.reportUrl || !/^https:\/\//.test(options.reportUrl)) errors.push('验收证据必须是 HTTPS 地址');
  if (!options.isTest && options.verdict !== 'pass' && !options.recovery) errors.push('失败通知必须给出恢复动作');
  return errors;
}

export async function sendNotification(options, fetchImpl = fetch) {
  const errors = validateNotificationOptions(options);
  if (errors.length > 0) throw new Error(errors.join('；'));
  if (options.verdict === 'pass' && !options.isTest) return { sent: false, reason: 'pass-only-archive' };

  const baseUrl = new URL(options.baseUrl);
  if (baseUrl.protocol !== 'https:' && baseUrl.hostname !== '127.0.0.1' && baseUrl.hostname !== 'localhost') {
    throw new Error('通知地址必须使用 HTTPS');
  }
  if (!options.impersonateUser) throw new Error('通知账号未配置');
  if (!options.accessKey && (!options.signingKeyId || !options.signingPrivateKey)) {
    throw new Error('通知凭据未配置');
  }

  const eventUrl = new URL('/api/dashboard/notifications/events', baseUrl);
  const body = JSON.stringify(buildNotificationPayload(options));
  const response = await fetchImpl(eventUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...buildStableSmokeAuthHeaders({
        method: 'POST',
        url: eventUrl.href,
        body,
        username: options.impersonateUser,
        aiAccessKey: options.accessKey,
        keyId: options.signingKeyId,
        privateKey: options.signingPrivateKey,
      }),
    },
    body,
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok || responseBody.success !== true) {
    const message = responseBody?.error?.message || 'MAP 暂时没有接收稳定冒烟通知';
    throw new Error(`${message}。报告已经保留，请修复通知配置后按相同 runId 补发。`);
  }
  const notification = responseBody?.data?.notification;
  if (!notification?.id
      || !notification.targetUserId
      || (options.targetUserId && notification.targetUserId !== options.targetUserId)) {
    throw new Error('MAP 没有确认通知已写入指定用户。报告已经保留，请核对目标用户后按相同 runId 补发。');
  }
  return {
    sent: true,
    created: responseBody?.data?.created === true,
    notificationId: notification.id,
    targetUserId: notification.targetUserId,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const options = {
    baseUrl: readArg(argv, '--base-url', process.env.STABLE_SMOKE_NOTIFY_BASE_URL || ''),
    accessKey: process.env.STABLE_SMOKE_NOTIFY_AI_ACCESS_KEY || '',
    signingKeyId: process.env.STABLE_SMOKE_NOTIFY_SIGNING_KEY_ID || '',
    signingPrivateKey: process.env.STABLE_SMOKE_NOTIFY_SIGNING_PRIVATE_KEY || '',
    impersonateUser: process.env.STABLE_SMOKE_NOTIFY_USER || '',
    targetUserId: process.env.STABLE_SMOKE_NOTIFY_TARGET_USER_ID || '',
    targetUsername: process.env.STABLE_SMOKE_NOTIFY_TARGET_USERNAME || '',
    source: readArg(argv, '--source', 'stable-smoke'),
    verdict: readArg(argv, '--verdict', 'conditional'),
    runId: readArg(argv, '--run-id'),
    environment: readArg(argv, '--environment'),
    module: readArg(argv, '--module', '整轮'),
    caseId: readArg(argv, '--case-id'),
    requestId: readArg(argv, '--request-id'),
    recovery: readArg(argv, '--recovery'),
    reportUrl: readArg(argv, '--report-url'),
    actionLabel: readArg(argv, '--action-label', '查看验收证据'),
    isTest: argv.includes('--test'),
  };
  const result = await sendNotification(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
