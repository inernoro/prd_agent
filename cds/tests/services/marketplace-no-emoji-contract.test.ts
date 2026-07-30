import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readController = (name: string) => readFileSync(
  resolve(process.cwd(), `../prd-api/src/PrdAgent.Api/Controllers/Api/${name}`),
  'utf8',
)

const openController = readController('MarketplaceSkillsOpenApiController.cs')
const managedController = readController('MarketplaceSkillsController.cs')

describe('marketplace visual marker contract', () => {
  it('does not contain pictographic literals in marketplace controllers', () => {
    expect(openController).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(managedController).not.toMatch(/\p{Extended_Pictographic}/u)
  })

  it('stores an empty compatibility value for new and updated skills', () => {
    expect(openController).toContain('var finalIcon = string.Empty;')
    expect(managedController).toContain('var finalIcon = string.Empty;')
    expect(managedController).toContain('.Set(x => x.IconEmoji, string.Empty)')
  })

  it('never exposes persisted visual marker values through marketplace DTOs', () => {
    expect(openController).not.toContain('iconEmoji = s.IconEmoji')
    expect(managedController).not.toContain('iconEmoji = s.IconEmoji')
    expect(managedController).not.toContain('iconEmoji = skill.IconEmoji')
  })
})
