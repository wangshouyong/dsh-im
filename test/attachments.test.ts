import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createImApi, type DshAttachmentStore } from '../src/host/im-api.ts'
import { readMetrics } from '../src/host/metrics-store.ts'
import { ImService } from '../src/core/im.ts'
import { modelContentForAttachments } from '../src/core/runtime.ts'
import type { MessageAttachment, Speaker } from '../src/core/types.ts'

function fakeStore(): DshAttachmentStore & { savedFiles: string[]; savedImages: string[] } {
  const savedFiles: string[] = []
  const savedImages: string[] = []
  return {
    savedFiles,
    savedImages,
    async saveFile(input) {
      savedFiles.push(input.name ?? '')
      return { attachmentId: 'sha256:file-1', name: input.name, bytes: input.data.byteLength }
    },
    async saveImages(inputs) {
      for (const input of inputs) savedImages.push(input.name ?? '')
      return inputs.map((input, index) => ({
        attachmentId: `sha256:image-${index}`,
        name: input.name,
        mediaType: input.mediaType,
        width: 640,
        height: 480,
      }))
    },
  }
}

const speaker: Speaker = {
  async complete() {
    return { text: '收到' }
  },
}

describe('附件上传（host）', () => {
  it('文本文件：落盘到本群 attachments/、带 inline 文本、登记 DSH 附件存储', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-att-'))
    const store = fakeStore()
    const api = createImApi({ projectRoot: () => root, llm: () => undefined, attachments: () => store })
    const bytes = Buffer.from('export const a = 1\n', 'utf8')
    const { attachment, url } = await api.uploadAttachment({
      threadId: 't1',
      projectRoot: root,
      name: 'a.ts',
      mediaType: 'text/plain',
      data: bytes,
    })
    expect(attachment).toMatchObject({
      kind: 'file',
      name: 'a.ts',
      bytes: bytes.byteLength,
      attachmentId: 'sha256:file-1',
    })
    expect(attachment.text).toContain('export const a = 1')
    expect(attachment.path).toMatch(/^attachments\/a_/)
    expect(url).toContain('/api/im/attachment?')
    expect(store.savedFiles).toEqual(['a.ts'])
    const saved = await readFile(join(root, '.dsh-im', 'groups', 't1', attachment.path!), 'utf8')
    expect(saved).toContain('export const a = 1')

    const read = await api.attachmentFile({ threadId: 't1', file: attachment.path, projectRoot: root })
    expect(Buffer.from(read.bytes).toString('utf8')).toContain('export const a = 1')
    expect(read.mediaType).toBe('text/plain')
  })

  it('图片：带 DSH 图片引用与尺寸；读取接口只允许 attachments/', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-att-'))
    const store = fakeStore()
    const api = createImApi({ projectRoot: () => root, llm: () => undefined, attachments: () => store })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const { attachment } = await api.uploadAttachment({
      threadId: 't1',
      projectRoot: root,
      name: 'shot.png',
      mediaType: 'image/png',
      data: png,
    })
    expect(attachment).toMatchObject({
      kind: 'image',
      mediaType: 'image/png',
      attachmentId: 'sha256:image-0',
      width: 640,
      height: 480,
    })
    expect(store.savedImages).toEqual(['shot.png'])
    await expect(api.attachmentFile({ threadId: 't1', file: '../../state.json', projectRoot: root }))
      .rejects.toThrow(/attachments/)
  })

  it('附件过大被拒绝；没有宿主附件存储时仍保存本地、只是没有 attachmentId', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-att-'))
    const api = createImApi({ projectRoot: () => root, llm: () => undefined })
    const tiny = await api.uploadAttachment({
      threadId: 't1',
      projectRoot: root,
      name: 'note.txt',
      mediaType: 'text/plain',
      data: Buffer.from('hi'),
    })
    expect(tiny.attachment.attachmentId).toBeUndefined()
    expect(tiny.attachment.kind).toBe('file')
    expect(tiny.modelVisible).toBe(false)
    const saved = await readMetrics(root, 't1')
    expect(saved.some((entry) => entry.kind === 'attachment_host_save' && entry.fields?.reason === 'no-store' && entry.fields?.ok === false)).toBe(true)

    const huge = Buffer.alloc(21 * 1024 * 1024, 1)
    await expect(api.uploadAttachment({
      threadId: 't1',
      projectRoot: root,
      name: 'big.bin',
      mediaType: 'application/octet-stream',
      data: huge,
    })).rejects.toMatchObject({ status: 413 })
  })

  it('没有宿主附件存储：记 no-store 指标；读接口不信路径扩展名', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-att-'))
    const api = createImApi({ projectRoot: () => root, llm: () => undefined })
    const { attachment } = await api.uploadAttachment({
      threadId: 't1',
      projectRoot: root,
      name: 'fake.png',
      mediaType: 'image/png',
      data: Buffer.from('这不是图片'),
    })
    expect(attachment.downgraded).toBe(true)
    expect(attachment.text).toContain('这不是图片')
    const metrics = await readFile(join(root, '.dsh-im', 'groups', 't1', 'metrics.jsonl'), 'utf8')
    const rows = metrics.trim().split('\n').map((line) => JSON.parse(line) as { kind: string; fields?: { reason?: string } })
    expect(rows.some((row) => row.kind === 'attachment_host_save' && row.fields?.reason === 'no-store')).toBe(true)

    const file = await api.attachmentFile({ threadId: 't1', file: attachment.path, projectRoot: root })
    expect(file.mediaType).toBe('application/octet-stream')
  })

  it('声明是图片但内容不是：降级为文件（不走 8MB 图片上限）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-att-'))
    const api = createImApi({ projectRoot: () => root, llm: () => undefined })
    const { attachment, modelVisible } = await api.uploadAttachment({
      threadId: 't1',
      projectRoot: root,
      name: 'fake.png',
      mediaType: 'image/png',
      data: Buffer.from('这不是图片，是文本'),
    })
    expect(attachment).toMatchObject({ kind: 'file', downgraded: true })
    expect(attachment.mediaType).toBe('application/octet-stream')
    expect(modelVisible).toBe(false)
  })

  it('threadId 不能穿越目录；长文件名保留扩展名；多字节文本不劈字符', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-att-'))
    const api = createImApi({ projectRoot: () => root, llm: () => undefined })
    await expect(api.uploadAttachment({
      threadId: '../../evil',
      projectRoot: root,
      name: 'a.txt',
      mediaType: 'text/plain',
      data: Buffer.from('x'),
    })).rejects.toThrow(/threadId/)

    const long = await api.uploadAttachment({
      threadId: 't1',
      projectRoot: root,
      name: '很长的文件名'.repeat(20) + '.ts',
      mediaType: 'text/plain',
      data: Buffer.from('export const 中 = 1\n', 'utf8'),
    })
    expect(long.attachment.path?.endsWith('.ts')).toBe(true)

    const chinese = await api.uploadAttachment({
      threadId: 't1',
      projectRoot: root,
      name: '中文.md',
      mediaType: 'text/plain',
      data: Buffer.from('这是一段中文，不应出现乱码。\n'.repeat(4000), 'utf8'),
    })
    expect(chinese.attachment.text).toContain('这是一段中文')
    expect(chinese.attachment.text?.endsWith('\uFFFD')).toBe(false)
  })
})

describe('消息携带附件 + 模型内容块', () => {
  const image: MessageAttachment = {
    id: 'a1',
    kind: 'image',
    name: 'shot.png',
    mediaType: 'image/png',
    bytes: 128,
    attachmentId: 'sha256:img-1',
    width: 640,
    height: 480,
    path: 'attachments/a1_shot.png',
  }
  const textFile: MessageAttachment = {
    id: 'a2',
    kind: 'file',
    name: 'a.ts',
    mediaType: 'text/plain',
    bytes: 20,
    text: 'const a = 1',
    path: 'attachments/a2_a.ts',
  }

  it('sendUser 把附件落到消息上（私聊转发也带上）', async () => {
    const im = new ImService(speaker)
    const p = im.createPersona({
      name: '淇淇',
      avatar: '淇',
      personality: '',
      duties: ['协作'],
      model: 'mock',
      proactiveDm: false,
      defaultActivity: 'high',
    })
    const group = im.createGroup('群', [p.id], 'D:/ws')
    await im.sendUser(group.id, '看下这两个文件', { attachments: [image, textFile] })
    const groupUserMessage = group.messages.filter((message) => message.kind === 'user').at(-1)
    expect(groupUserMessage?.attachments).toHaveLength(2)

    await im.sendUser(group.id, '@淇淇 找我私聊一下', { attachments: [image] })
    const dm = im.state.threads.find((thread) => thread.kind === 'dm')
    const userMessage = dm?.messages.filter((message) => message.kind === 'user').at(-1)
    expect(userMessage?.attachments).toHaveLength(1)
  })

  it('inline 文本以完整汉字结尾时不丢字；被截断时也不产坏字符', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-att-'))
    const api = createImApi({ projectRoot: () => root, llm: () => undefined })
    const short = await api.uploadAttachment({
      threadId: 't1', projectRoot: root, name: 'short.txt', mediaType: 'text/plain',
      data: Buffer.from('结尾是完整的：你好', 'utf8'),
    })
    expect(short.attachment.text).toBe('结尾是完整的：你好')

    const long = await api.uploadAttachment({
      threadId: 't1', projectRoot: root, name: 'long.txt', mediaType: 'text/plain',
      data: Buffer.from('汉'.repeat(30_000), 'utf8'),
    })
    expect(long.attachment.text?.endsWith('\uFFFD')).toBe(false)
    expect(long.attachment.text?.at(-1)).toBe('汉')
  })

  it('store 只有 saveImages 时，上传文本落 no-saveFile 指标', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-att-'))
    const store = { async saveImages() { return [] } } as unknown as DshAttachmentStore
    const api = createImApi({ projectRoot: () => root, llm: () => undefined, attachments: () => store })
    const { attachment } = await api.uploadAttachment({
      threadId: 't1', projectRoot: root, name: 'note.txt', mediaType: 'text/plain', data: Buffer.from('hello 文本'),
    })
    expect(attachment.text).toContain('hello 文本')
    const rows = await readMetrics(root, 't1')
    expect(rows.some((row) => row.kind === 'attachment_host_save' && (row.fields as { reason?: string })?.reason === 'no-saveFile')).toBe(true)
  })

  it('未注册 projectRoot 直接 400；注册根按大小写变体访问也落在注册路径', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-att-'))
    const evil = await mkdtemp(join(tmpdir(), 'dshim-evil-'))
    const api = createImApi({
      projectRoot: () => root,
      llm: () => undefined,
      workspaces: () => [{ path: root }],
    })
    await expect(api.uploadAttachment({
      threadId: 't1', projectRoot: evil, name: 'a.txt', mediaType: 'text/plain', data: Buffer.from('hello'),
    })).rejects.toMatchObject({ status: 400 })

    const variant = process.platform === 'win32' ? root.toUpperCase() : root
    const { attachment, url } = await api.uploadAttachment({
      threadId: 't1', projectRoot: variant, name: 'a.txt', mediaType: 'text/plain', data: Buffer.from('hello'),
    })
    await expect(readFile(join(root, '.dsh-im', 'groups', 't1', attachment.path ?? ''), 'utf8')).resolves.toBe('hello')
    expect(url).not.toContain(root)

    // URL 不带绝对根，读接口仍能从注册根里找到该群。
    const file = await api.attachmentFile({ threadId: 't1', file: attachment.path })
    expect(file.mediaType).toBe('text/plain')
  })

  it('空注册表时 strict 也 400，不静默回退', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-att-'))
    const other = await mkdtemp(join(tmpdir(), 'dshim-other-'))
    const api = createImApi({ projectRoot: () => root, llm: () => undefined })
    await expect(api.uploadAttachment({
      threadId: 't1', projectRoot: other, name: 'a.txt', mediaType: 'text/plain', data: Buffer.from('x'),
    })).rejects.toMatchObject({ status: 400 })
  })

  it('20k 处正好切在汉字边界时不丢最后一个整字', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-att-'))
    const api = createImApi({ projectRoot: () => root, llm: () => undefined })
    // 80004 = 26668 * 3，+1 字节让截断正好落在完整汉字之后。
    const { attachment } = await api.uploadAttachment({
      threadId: 't1', projectRoot: root, name: 'boundary.txt', mediaType: 'text/plain',
      data: Buffer.concat([Buffer.from('汉'.repeat(26668), 'utf8'), Buffer.from('x')]),
    })
    expect(attachment.text?.endsWith('汉')).toBe(true)
    expect(attachment.text?.length).toBe(20000)
  })

  it('emoji 截断不留半个代理对', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-att-'))
    const api = createImApi({ projectRoot: () => root, llm: () => undefined })
    const { attachment } = await api.uploadAttachment({
      threadId: 't1', projectRoot: root, name: 'emoji.txt', mediaType: 'text/plain',
      data: Buffer.from('😀'.repeat(12_000), 'utf8'),
    })
    expect(attachment.text).toBeTruthy()
    expect(attachment.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(attachment.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  it('声明图片但实际是 PDF/ZIP：降级后不把二进制当正文', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-att-'))
    const api = createImApi({ projectRoot: () => root, llm: () => undefined })
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('not really a pdf but no nul')])
    const { attachment } = await api.uploadAttachment({
      threadId: 't1', projectRoot: root, name: 'fake.png', mediaType: 'image/png', data: pdf,
    })
    expect(attachment.kind).toBe('file')
    expect(attachment.mediaType).toBe('application/pdf')
    expect(attachment.text).toBeUndefined()

    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('zip body no nul')])
    const zipFile = await api.uploadAttachment({
      threadId: 't1', projectRoot: root, name: 'fake2.png', mediaType: 'image/png', data: zip,
    })
    expect(zipFile.attachment.mediaType).toBe('application/zip')
    expect(zipFile.attachment.text).toBeUndefined()
  })

  it('畸形 toolAllow 直接 400，不静默放宽', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-att-'))
    const api = createImApi({ projectRoot: () => root, llm: () => undefined })
    await expect(api.complete({
      model: 'deepseek-account::deepseek-flash',
      messages: [{ role: 'user', content: 'hi' }],
      toolAllow: 'write' as unknown as string[],
    })).rejects.toMatchObject({ status: 400 })
  })

  it('写入口 complete/writeFile 对未注册根返回 400', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-att-'))
    const evil = await mkdtemp(join(tmpdir(), 'dshim-evil-'))
    const api = createImApi({ projectRoot: () => root, llm: () => undefined, workspaces: () => [{ path: root }] })
    await expect(api.complete({
      model: 'deepseek-account::deepseek-flash',
      projectRoot: evil,
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toMatchObject({ status: 400 })
    await expect(api.writeFile({ threadId: 't1', relativePath: 'x.md', content: 'x', projectRoot: evil }))
      .rejects.toMatchObject({ status: 400 })
  })

  it('非法 threadId 统一返回 400（upload/gc）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-att-'))
    const api = createImApi({ projectRoot: () => root, llm: () => undefined })
    await expect(api.uploadAttachment({
      threadId: '../evil', projectRoot: root, name: 'a.txt', mediaType: 'text/plain', data: Buffer.from('x'),
    })).rejects.toMatchObject({ status: 400 })
    await expect(api.attachmentGc({ threadId: '../evil' })).rejects.toMatchObject({ status: 400 })
  })

  it('store 有函数但返回空 ref 时，记 no-ref 指标且 modelVisible=false', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-att-'))
    const store = {
      async saveImages() { return [] },
      async saveFile() { return undefined },
    } as unknown as DshAttachmentStore
    const api = createImApi({ projectRoot: () => root, llm: () => undefined, attachments: () => store })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const image = await api.uploadAttachment({
      threadId: 't1', projectRoot: root, name: 'shot.png', mediaType: 'image/png', data: png,
    })
    expect(image.modelVisible).toBe(false)
    const txt = await api.uploadAttachment({
      threadId: 't1', projectRoot: root, name: 'note.txt', mediaType: 'text/plain', data: Buffer.from('hi'),
    })
    expect(txt.modelVisible).toBe(false)
    const rows = await readMetrics(root, 't1')
    expect(rows.filter((row) => row.kind === 'attachment_host_save' && (row.fields as { reason?: string })?.reason === 'no-ref')).toHaveLength(2)
  })

  it('store 返回空 attachmentId 时同样走 no-ref', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-att-'))
    const store = {
      async saveImages() { return [{ attachmentId: '' }] },
      async saveFile() { return { attachmentId: '' } },
    } as unknown as DshAttachmentStore
    const api = createImApi({ projectRoot: () => root, llm: () => undefined, attachments: () => store })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const image = await api.uploadAttachment({ threadId: 't1', projectRoot: root, name: 'shot.png', mediaType: 'image/png', data: png })
    const txt = await api.uploadAttachment({ threadId: 't1', projectRoot: root, name: 'note.txt', mediaType: 'text/plain', data: Buffer.from('hi') })
    expect(image.modelVisible).toBe(false)
    expect(txt.modelVisible).toBe(false)
    const rows = await readMetrics(root, 't1')
    expect(rows.filter((row) => row.kind === 'attachment_host_save' && (row.fields as { reason?: string })?.reason === 'no-ref')).toHaveLength(2)
  })

  it('模型内容块：图片走 ImageBlock、文本文件内联、二进制只留占位', () => {
    const prompt = '这是当前消息'
    const binary: MessageAttachment = {
      id: 'a3',
      kind: 'file',
      name: 'x.pdf',
      mediaType: 'application/pdf',
      bytes: 1024,
      path: 'attachments/a3_x.pdf',
    }
    const parts = modelContentForAttachments(prompt, {
      id: 'm1',
      threadId: 't1',
      kind: 'user',
      authorName: '你',
      text: '看下',
      attachments: [image, textFile, binary],
      createdAt: 1,
    })
    expect(Array.isArray(parts)).toBe(true)
    const blocks = parts as Exclude<typeof parts, string>
    expect(blocks[0]).toEqual({ type: 'text', text: prompt })
    expect(blocks.some((block) => block.type === 'image' && block.attachment.attachmentId === 'sha256:img-1')).toBe(true)
    expect(blocks.some((block) => block.type === 'text' && block.text.includes('const a = 1'))).toBe(true)
    expect(blocks.some((block) => block.type === 'text' && block.text.includes('x.pdf'))).toBe(true)

    // 没有附件时保持纯字符串（老的 prompt 行为不变）
    expect(modelContentForAttachments(prompt, undefined)).toBe(prompt)
  })
})
