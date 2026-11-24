/** 浏览器已验证的同站 HTTPS 入口不能在多层代理后退回 HTTP；不改写管理员指定的其它主机。 */
export function secureSameSiteEndpoint(endpoint: string, pageOrigin: string): string {
  try {
    const target = new URL(endpoint);
    const page = new URL(pageOrigin);
    if (page.protocol === 'https:' && target.protocol === 'http:' && target.host === page.host) {
      target.protocol = 'https:';
      return target.toString();
    }
  } catch { /* 无效配置由原有错误展示处理，不凭空生成连接地址。 */ }
  return endpoint;
}
