/** Keep the existing LAN HTTP fallback; never report a rejected copy as success. */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // A secure-origin permission rejection can still permit a user-initiated fallback.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-625rem';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  try {
    textarea.select();
    if (!document.execCommand('copy')) throw new Error('浏览器未允许复制，请保持当前页面在前台并重试。');
  } finally {
    document.body.removeChild(textarea);
  }
}
