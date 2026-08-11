import { describe, expect, it } from 'vitest';
import { toUserReadableErrorMessage } from './userReadableError';

const options = {
  fallbackMessage: '文件上传未完成',
  recoveryMessage: '请检查文件后重新上传。',
};

describe('toUserReadableErrorMessage', () => {
  it('从标准错误响应中提取用户文案并补充恢复动作', () => {
    const message = toUserReadableErrorMessage(
      '{"success":false,"data":null,"error":{"code":"INVALID_FORMAT","message":"文件内容无法解析"},"traceId":"trace-1"}',
      options,
    );

    expect(message).toBe('文件内容无法解析，请检查文件后重新上传。');
    expect(message).not.toMatch(/success|traceId|INVALID_FORMAT/);
  });

  it('屏蔽内部诊断和上游协议错误', () => {
    const message = toUserReadableErrorMessage(
      { code: 'UPLOAD_FAILED', message: 'Input must have at least 1 token. requestId=req-1' },
      options,
    );

    expect(message).toBe('文件上传未完成，请检查文件后重新上传。');
    expect(message).not.toMatch(/token|requestId/i);
  });

  it('把服务异常归类为稳定用户提示', () => {
    const message = toUserReadableErrorMessage(
      { code: 'SERVER_UNAVAILABLE', message: 'HTTP 503 /api/files' },
      options,
    );

    expect(message).toBe('服务暂时不可用，请检查文件后重新上传。');
    expect(message).not.toMatch(/HTTP|\/api\//i);
  });

  it('保留已经包含恢复动作的安全中文文案', () => {
    const message = toUserReadableErrorMessage(
      { code: 'INVALID_FORMAT', message: '文件格式不受支持，请更换文件后重试。' },
      options,
    );

    expect(message).toBe('文件格式不受支持，请更换文件后重试。');
  });

  it('权限不足时提示联系管理员而不是要求重新登录', () => {
    const message = toUserReadableErrorMessage(
      { code: 'PERMISSION_DENIED', message: 'forbidden' },
      options,
    );

    expect(message).toBe('当前账号没有执行此操作的权限，请联系管理员开通后重试。');
    expect(message).not.toContain('重新登录');
  });

  it('工作区仍在生成时保留取消任务的恢复动作', () => {
    const message = toUserReadableErrorMessage(
      { code: 'WORKSPACE_GENERATION_ACTIVE', message: 'internal detail' },
      options,
    );

    expect(message).toBe('该项目仍有图片正在生成，请先取消任务并等待状态结束后再删除。');
  });

  it.each([
    ['HAS_SPECIAL_MODELS', '以下模型被设置为系统模型，请先取消设置后再删除平台：主模型(生图模型)'],
    ['HAS_MODEL_POOL_REFS', '平台下的模型被以下模型池引用，请先从模型池移除：默认视觉池、备用视觉池'],
  ])('平台删除阻塞时保留受影响名称和恢复动作：%s', (code, backendMessage) => {
    const message = toUserReadableErrorMessage({ code, message: backendMessage }, options);

    expect(message).toBe(backendMessage);
  });

  it('屏蔽浏览器网络错误和模型协议诊断', () => {
    const networkMessage = toUserReadableErrorMessage(new TypeError('Failed to fetch'), options);
    const protocolMessage = toUserReadableErrorMessage(
      new Error('HTTP 502 provider image model protocol mismatch'),
      options,
    );

    expect(networkMessage).toBe('文件上传未完成，请检查文件后重新上传。');
    expect(protocolMessage).toBe('文件上传未完成，请检查文件后重新上传。');
    expect(`${networkMessage} ${protocolMessage}`).not.toMatch(/fetch|HTTP|provider|model|protocol/i);
  });

  it('已知错误码携带未登记文案时也不直接展示', () => {
    const message = toUserReadableErrorMessage(
      { code: 'INVALID_FORMAT', message: '文件内部处理失败，请联系服务负责人。' },
      options,
    );

    expect(message).toBe('文件上传未完成，请检查文件后重新上传。');
  });

  it('显式允许的错误码仍会屏蔽网络地址和密钥', () => {
    const connection = toUserReadableErrorMessage(
      { code: 'VALIDATION_ERROR', message: 'connect ECONNREFUSED 10.0.0.5:443' },
      options,
    );
    const credential = toUserReadableErrorMessage(
      { code: 'INVALID_FORMAT', message: 'invalid API key sk-example-secret' },
      options,
    );

    expect(connection).toBe('文件上传未完成，请检查文件后重新上传。');
    expect(credential).toBe('文件上传未完成，请检查文件后重新上传。');
    expect(`${connection} ${credential}`).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|API key|sk-/i);
  });

  it('为已登记认证错误保留明确的结果和恢复动作', () => {
    const locked = toUserReadableErrorMessage(
      { code: 'ACCOUNT_LOCKED', message: '账号已被锁定，请在 73 秒后重试' },
      options,
    );
    const sso = toUserReadableErrorMessage(
      { code: 'PASSWORD_LOGIN_DISABLED', message: '当前环境已禁用密码登录，请使用 SSO 登录' },
      options,
    );
    const expiredTicket = toUserReadableErrorMessage(
      { code: 'SYNTHETIC_LOGIN_TICKET_INVALID', message: '一次性登录入口已失效，请重新生成后再试' },
      options,
    );

    expect(locked).toBe('账号已被锁定，请在 73 秒后重试。');
    expect(sso).toBe('当前环境已禁用密码登录，请使用 SSO 登录。');
    expect(expiredTicket).toBe('一次性登录入口已失效，请重新生成后再试。');
  });

  it('账号锁定错误只提取受约束的等待秒数', () => {
    const message = toUserReadableErrorMessage(
      { code: 'ACCOUNT_LOCKED', message: '账号已被锁定，请在 10 秒后重试，traceId=secret' },
      options,
    );

    expect(message).toBe('账号已被锁定，请稍后重试。');
    expect(message).not.toContain('traceId');
  });

  it.each([
    ['SSO_PROVIDER_DISABLED', 'SSO 提供方尚未启用，请联系管理员启用后重试。'],
    ['SSO_AUTHORIZE_INVALID', 'SSO 授权参数无效，请返回模型网关重新发起登录。'],
    ['SSO_ADMIN_REQUIRED', '当前账号不是管理员，无法进入外部控制台，请使用管理员账号登录后重试。'],
    ['SSO_BINDING_DUPLICATED', '米多星球账号绑定不唯一，请联系管理员处理。'],
    ['MIDUO_SSO_NOT_CONFIGURED', '米多星球 SSO 尚未配置，请先在系统设置中配置 appCode 后重试。'],
    ['SSO_BINDING_EXISTS', '该米多星球绑定值已被其他用户使用，请先解除原绑定或更换绑定值后重试。'],
    ['MAP_SSO_BROWSER_SESSION_REQUIRED', '当前会话不能进入模型网关，请先通过管理后台登录后重试。'],
    ['MAP_ADMIN_REQUIRED', '当前账号不是管理员，无法进入模型网关，请使用管理员账号登录后重试。'],
    ['SYNTHETIC_SESSION_FEDERATION_FORBIDDEN', '合成测试会话不能进入外部控制台，请使用真人管理员账号登录后重试。'],
  ])('为 SSO 授权错误 %s 提供对应恢复动作', (code, expected) => {
    const message = toUserReadableErrorMessage(
      { code, message: '不应直接展示的服务端文案' },
      options,
    );

    expect(message).toBe(expected);
    expect(message).not.toContain(options.fallbackMessage);
  });

  it('平台模型列表变化后保留刷新和级联删除恢复动作', () => {
    const message = toUserReadableErrorMessage(
      {
        code: 'HAS_MODELS',
        message: '该平台下有3个模型，无法删除。如需级联删除，请添加 ?cascade=true 参数',
      },
      options,
    );

    expect(message).toBe('该平台下仍有模型，请刷新页面确认后选择级联删除，或先移除模型再重试。');
    expect(message).not.toMatch(/cascade|参数/);
  });

  it.each([
    ['INVALID_INVITE_CODE', '邀请码无效或已使用，请更换邀请码后重试。'],
    ['INVALID_INVITE_LINK', '邀请入口无效，请联系邀请人重新生成。'],
    ['INVITE_EXPIRED', '邀请码已过期，请联系邀请人重新生成。'],
    ['ALREADY_MEMBER', '当前账号已加入该群组，请返回群组列表查看。'],
    ['GROUP_FULL', '群组人数已达上限，请联系群组管理员处理。'],
  ])('为群组加入错误 %s 提供可执行的恢复动作', (code, expected) => {
    const message = toUserReadableErrorMessage(
      { code, message: '不应直接展示的服务端文案' },
      options,
    );

    expect(message).toBe(expected);
    expect(message).not.toContain(options.fallbackMessage);
  });

  it.each([
    ['SESSION_EXPIRED', '当前会话已过期，请返回后重新打开。'],
    ['SHARE_EXPIRED', '分享入口已过期，请联系分享者重新生成。'],
    ['INVALID_STATE', '内容状态已发生变化，请刷新页面确认后重试。'],
    ['STALE_UPDATE', '内容已被其他操作更新，请刷新页面后重新提交。'],
    ['QUOTA_EXCEEDED', '当前可用额度不足，请联系管理员补充额度后重试。'],
    ['LLM_QUOTA_EXCEEDED', '当前可用额度不足，请联系管理员补充额度或切换可用配置后重试。'],
    ['ASSET_NOT_FOUND', '这张生成图片已失效，请重新生成预览后再使用。'],
    ['TEAM_LEADER_TRANSFER_REQUIRED', '团队负责人不能直接退出，请先在成员管理中将负责人移交给其他成员。'],
    ['INVALID_CONFIG', '模型配置不完整，请先在模型平台补充 API 地址和密钥后再测试。'],
    ['DUPLICATE_MODEL', '该模型名称已存在，请刷新模型列表后确认；如需新增，请改用其他模型名称。'],
  ])('为稳定业务错误 %s 使用已登记文案而不是通用输入提示', (code, expected) => {
    const message = toUserReadableErrorMessage(
      { code, message: 'HTTP 500 provider traceId=secret' },
      options,
    );

    expect(message).toBe(expected);
    expect(message).not.toMatch(/HTTP|provider|traceId/i);
  });

  it.each([
    ['SHORT_VIDEO_INTERRUPTED', '短视频解析因服务重启而中断，请重新解析。'],
    ['SHORT_VIDEO_TIMEOUT', '短视频解析等待超时，请重新解析。'],
  ])('为短视频后台失败分类 %s 保留重新解析动作', (code, expected) => {
    expect(toUserReadableErrorMessage({ code, message: '内部诊断不得展示' }, options)).toBe(expected);
  });
});
