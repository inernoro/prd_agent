import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const injectorPath = resolve(
  process.cwd(),
  '../prd-api/src/PrdAgent.Api/Controllers/Api/OfficialSkills/OfficialMarketplaceSkillInjector.cs',
)
const source = readFileSync(injectorPath, 'utf8')

describe('official marketplace skill metadata contract', () => {
  it('exposes stable slugs for bootstrap, catalog, and bundle entries', () => {
    expect(source).toContain('slug = OfficialSkillTemplates.FindMapSkillsKey')
    expect(source).toContain('slug = e.Key')
    expect(source).toContain('slug = b.Key')
  })
})
