import { describe, expect, it } from 'vitest'
import { resolveModelBinding, type ModelOption } from '../src/host/models.ts'

const listed: ModelOption[] = [
  { id: 'deepseek-account::deepseek-flash', label: 'V41-Flash', provider: 'DeepSeek 账号', route: 'deepseek-account', modelId: 'deepseek-flash', ready: true },
  { id: 'deepseek-official::deepseek-flash', label: 'V41-Flash', provider: 'DeepSeek', route: 'deepseek-official', modelId: 'deepseek-flash', ready: true },
  { id: 'magpie::grok', label: 'Grok', provider: 'Magpie', route: 'magpie', modelId: 'grok', ready: true },
  { id: 'broken::', label: 'Broken', provider: 'Broken', route: 'broken', modelId: '', ready: false },
]

describe('模型解析：选的哪个组就用哪个组', () => {
  it('记录的提供方（route 或显示名）命中时照用', () => {
    expect(resolveModelBinding(listed, 'deepseek-flash', 'deepseek-official')).toEqual({ route: 'deepseek-official', model: 'deepseek-flash' })
    expect(resolveModelBinding(listed, 'deepseek-flash', 'DeepSeek 账号')).toEqual({ route: 'deepseek-account', model: 'deepseek-flash' })
  })

  it('记录的提供方不在了就返回空（报错重选），不换组', () => {
    expect(resolveModelBinding(listed, 'deepseek-flash', '不存在的提供方')).toBeNull()
  })

  it('没有记录提供方时，重复 id 视为歧义而不是猜一个', () => {
    expect(resolveModelBinding(listed, 'deepseek-flash')).toBeNull()
    expect(resolveModelBinding(listed, 'grok', 'Magpie')).toEqual({ route: 'magpie', model: 'grok' })
  })

  it('完整 provider::model 必须精确存在，不可用分组不认', () => {
    expect(resolveModelBinding(listed, 'magpie::grok')).toEqual({ route: 'magpie', model: 'grok' })
    expect(resolveModelBinding(listed, 'magpie::missing')).toBeNull()
    expect(resolveModelBinding(listed, 'broken::')).toBeNull()
    expect(resolveModelBinding(listed, undefined)).toBeNull()
  })
})
