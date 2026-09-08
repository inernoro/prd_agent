/**
 * 写剪贴板并如实回报成没成 —— 接入台里唯一一处判据。
 *
 * 为什么要收敛成一处：这里复制的两样东西都经不起一句假的「已复制」——
 * 密钥明文只显示一次（用户据此关掉弹窗，然后手里什么都没有），
 * 连接地址被当成复制走了就会去粘贴一份旧内容进客户端配置。
 * 而剪贴板 API 在非安全来源、无权限、或被浏览器拒绝时，要么整个不存在
 * （`?.` 静默返回 undefined），要么 reject —— 两种都不会自己报错。
 *
 * 这两处原先各写各的，第一处修完第二处在下一轮 Review 才被指出来。
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
