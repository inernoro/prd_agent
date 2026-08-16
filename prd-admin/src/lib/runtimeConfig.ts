export type PublicDeploymentConfigKey =
  | 'VITE_CONTACT_EMAIL'
  | 'VITE_FRONT_END_PDA_LINKS_JSON'
  | 'VITE_FRONT_END_PROJECT_REGISTRY_JSON'
  | 'VITE_PA_LEARN_MORE_URL'
  | 'VITE_PUBLIC_DOCS_URL';

/**
 * 预构建镜像优先读取容器启动时生成的公开配置；源码开发和静态构建回退到 Vite 环境。
 * 此通道会暴露给浏览器，严禁承载密钥或连接串。
 */
export function readPublicDeploymentConfig(key: PublicDeploymentConfigKey): string {
  const runtimeValue = typeof window === 'undefined'
    ? undefined
    : window.__MAP_RUNTIME_CONFIG__?.[key];
  const buildValue = (import.meta.env as Record<string, string | undefined>)[key];
  return runtimeValue?.trim() || buildValue?.trim() || '';
}
