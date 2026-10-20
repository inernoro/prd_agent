import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyTextToClipboard } from '../../web/src/lib/clipboard.js';

function browser(writeText?: (text: string) => Promise<void>, result: boolean | Error = true) {
  const field = { value: '', style: {} as Record<string, string>, setAttribute: vi.fn(), select: vi.fn() };
  let selected = '';
  field.select.mockImplementation(() => { selected = field.value; });
  const removeChild = vi.fn();
  const execCommand = vi.fn(() => { if (result instanceof Error) throw result; return result; });
  vi.stubGlobal('navigator', writeText ? { clipboard: { writeText } } : {});
  vi.stubGlobal('document', { createElement: () => field, body: { appendChild: vi.fn(), removeChild }, execCommand });
  return { execCommand, removeChild, selected: () => selected };
}

describe('通行证复用浏览器复制兼容通道', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('安全来源原生复制成功时不触碰回退DOM', async () => {
    const native = vi.fn().mockResolvedValue(undefined), page = browser(native);
    await copyTextToClipboard('connection fixture');
    expect(native).toHaveBeenCalledWith('connection fixture');
    expect(page.execCommand).not.toHaveBeenCalled();
  });

  it('LAN HTTP没有clipboard API时复制完整内容并移除临时字段', async () => {
    const page = browser();
    await copyTextToClipboard('account and CA fixture');
    expect(page.selected()).toBe('account and CA fixture');
    expect(page.execCommand).toHaveBeenCalledWith('copy');
    expect(page.removeChild).toHaveBeenCalledOnce();
  });

  it('原生权限拒绝后仍可使用既有回退', async () => {
    const page = browser(() => Promise.reject(new Error('permission denied')));
    await expect(copyTextToClipboard('fixture')).resolves.toBeUndefined();
    expect(page.selected()).toBe('fixture');
    expect(page.removeChild).toHaveBeenCalledOnce();
  });

  it('浏览器明确拒绝回退时不能谎报复制成功或保留秘密字段', async () => {
    const page = browser(undefined, false);
    await expect(copyTextToClipboard('private fixture')).rejects.toThrow('浏览器未允许复制');
    expect(page.removeChild).toHaveBeenCalledOnce();
  });

  it('回退抛错时仍移除临时字段', async () => {
    const page = browser(undefined, new Error('copy denied'));
    await expect(copyTextToClipboard('private fixture')).rejects.toThrow('copy denied');
    expect(page.removeChild).toHaveBeenCalledOnce();
  });
});
