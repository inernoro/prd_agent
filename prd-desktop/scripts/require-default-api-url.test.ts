import { describe, expect, it } from 'vitest'
import { validateDesktopApiUrl } from './require-default-api-url.mjs'

describe('桌面发布 API 地址门禁', () => {
  it('拒绝缺失、非 HTTP 和携带凭据的地址', () => {
    expect(validateDesktopApiUrl('')).toContain('必须设置')
    expect(validateDesktopApiUrl('file:///tmp/api')).toContain('http 或 https')
    expect(validateDesktopApiUrl('https://user:secret@map.example.com')).toContain('不得包含用户名或密码')
  })

  it('接受部署时注入的完整 HTTP 地址', () => {
    expect(validateDesktopApiUrl('https://map.example.com')).toBeNull()
    expect(validateDesktopApiUrl('http://127.0.0.1:5000')).toBeNull()
  })
})
