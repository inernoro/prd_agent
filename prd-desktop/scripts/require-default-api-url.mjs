import { pathToFileURL } from 'node:url'

export function validateDesktopApiUrl(rawValue) {
  const value = String(rawValue || '').trim()
  if (!value) return '发布构建必须设置 PRD_DESKTOP_DEFAULT_API_URL'

  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return 'PRD_DESKTOP_DEFAULT_API_URL 必须使用 http 或 https'
    if (url.username || url.password) return 'PRD_DESKTOP_DEFAULT_API_URL 不得包含用户名或密码'
    return null
  } catch {
    return 'PRD_DESKTOP_DEFAULT_API_URL 必须是完整 URL'
  }
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedAsScript) {
  const error = validateDesktopApiUrl(process.env.PRD_DESKTOP_DEFAULT_API_URL)
  if (error) {
    console.error(error)
    process.exit(1)
  }
}
