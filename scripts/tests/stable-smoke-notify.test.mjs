import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNotificationPayload, sendNotification, validateNotificationOptions } from '../stable-smoke-notify.mjs';

const base = {
  baseUrl: 'https://map.example.test',
  accessKey: 'secret-value',
  impersonateUser: 'stsmk_admin',
  targetUserId: 'target-user-id',
  verdict: 'fail',
  runId: 'stsmk-123',
  environment: '正式',
  module: '多图视觉创作',
  caseId: 'REG-multi-image-001',
  recovery: '暂停异常模型并通过 CDS 回滚 previous 版本',
  reportUrl: 'https://reports.example.test/stsmk-123',
  isTest: false,
};

test('通知始终定向用户并包含证据和恢复动作', () => {
  assert.deepEqual(validateNotificationOptions(base), []);
  const payload = buildNotificationPayload(base);
  assert.equal(payload.targetUserId, 'target-user-id');
  assert.equal(payload.actionUrl, base.reportUrl);
  assert.match(payload.message, /CDS 回滚/);
  assert.equal(payload.source, 'stable-smoke');
  assert.match(payload.dedupKey, /REG-multi-image-001/);
});

test('执行链异常可以把动作改为打开通知中心', () => {
  const payload = buildNotificationPayload({
    verdict: 'fail',
    runId: 'fatal-run',
    environment: 'CDS 环境、正式环境',
    module: '稳定冒烟执行链',
    recovery: '按失败摘要恢复后重试。',
    reportUrl: 'https://map.ebcone.net/?panel=notifications',
    targetUserId: 'user-1',
    actionLabel: '打开通知中心',
  });

  assert.equal(payload.actionLabel, '打开通知中心');
  assert.equal(payload.actionUrl, 'https://map.ebcone.net/?panel=notifications');
});

test('缺少目标用户时拒绝全局通知', () => {
  assert.ok(validateNotificationOptions({ ...base, targetUserId: '' }).some((item) => item.includes('拒绝发送全局通知')));
});

test('通过结果只归档，不发送通知', async () => {
  const result = await sendNotification({ ...base, verdict: 'pass' }, () => {
    throw new Error('不应发出请求');
  });
  assert.deepEqual(result, { sent: false, reason: 'pass-only-archive' });
});

test('失败结果调用 MAP 站内通知接口且不包含其他通知通道', async () => {
  let captured;
  const result = await sendNotification(base, async (url, init) => {
    captured = { url: String(url), init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ success: true, data: { created: true, notification: { id: 'n-1', targetUserId: 'target-user-id' } } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  assert.equal(result.sent, true);
  assert.match(captured.url, /\/api\/dashboard\/notifications\/events$/);
  assert.equal(captured.init.headers['X-AI-Impersonate'], 'stsmk_admin');
  assert.equal(captured.body.targetUserId, 'target-user-id');
  assert.equal(JSON.stringify(captured).toLowerCase().includes('slack'), false);
});

test('服务端未确认目标用户时不得把接口成功误报为送达', async () => {
  await assert.rejects(
    sendNotification(base, async () => new Response(JSON.stringify({
      success: true,
      data: { created: true, notification: { id: 'n-1', targetUserId: 'deleted-user' } },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })),
    /没有确认通知已写入指定用户/,
  );
});
