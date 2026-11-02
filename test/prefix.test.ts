import { describe, expect, it } from 'vitest'
import { stripSpeakerPrefix } from '../src/core/runtime.ts'

describe('stripSpeakerPrefix（防串身份）', () => {
  it('剥掉自己的名字前缀（全角/半角冒号）', () => {
    expect(stripSpeakerPrefix('淇淇：好的', '淇淇', [])).toBe('好的')
    expect(stripSpeakerPrefix('淇淇: 好的', '淇淇', [])).toBe('好的')
    expect(stripSpeakerPrefix('  淇淇 ：好的', '淇淇', [])).toBe('好的')
  })

  it('连续套娃前缀一次剥干净：淇淇：测试2：你好', () => {
    expect(stripSpeakerPrefix('淇淇：测试2：你好', '淇淇', ['测试2'])).toBe('你好')
    expect(stripSpeakerPrefix('淇淇：测试2：敏敏：你好', '淇淇', ['测试2', '敏敏'])).toBe('你好')
  })

  it('支持 markdown 加粗 / 方括号 / 引号格式', () => {
    expect(stripSpeakerPrefix('**淇淇**：好的', '淇淇', [])).toBe('好的')
    expect(stripSpeakerPrefix('【淇淇】好的', '淇淇', [])).toBe('好的')
    expect(stripSpeakerPrefix('「淇淇」好的', '淇淇', [])).toBe('好的')
    expect(stripSpeakerPrefix('“淇淇：”好的', '淇淇', [])).toBe('好的')
    expect(stripSpeakerPrefix('**测试2**：好的', '淇淇', ['测试2'])).toBe('好的')
  })

  it('新人格首条消息：靠 memberNames 也能剥掉别人的名字前缀', () => {
    // 可见消息里还没有“测试2”，只能靠 thread 成员名识别
    expect(stripSpeakerPrefix('测试2：我来补充', '淇淇', ['测试2', '敏敏'])).toBe('我来补充')
  })

  it('不误伤正常句子（名字出现在句首但没有冒号/包裹）', () => {
    expect(stripSpeakerPrefix('淇淇这个方案我同意', '淇淇', [])).toBe('淇淇这个方案我同意')
    expect(stripSpeakerPrefix('测试2说得对，我补充一点', '淇淇', ['测试2'])).toBe('测试2说得对，我补充一点')
  })

  it('名字含正则特殊字符也能正确转义', () => {
    expect(stripSpeakerPrefix('C++（架构）: 好的', 'C++（架构）', [])).toBe('好的')
    expect(stripSpeakerPrefix('A.B：好的', 'A.B', [])).toBe('好的')
  })
})
