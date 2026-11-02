import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeToolAllow, toolsForAllow } from '../src/core/index.ts'
import {
  buildCheckArgv,
  buildTypecheckArgv,
  formatCheckResult,
  resolveCheckTarget,
  runCheck,
  type CheckSpec,
} from '../src/host/run-check.ts'

describe('run_check：只跑测试，不给终端', () => {
  it('target 只接受工作区内的相对路径', () => {
    expect(resolveCheckTarget('D:/ws', 'tests/a.test.ts')).toEqual({ target: 'tests/a.test.ts' })
    expect(resolveCheckTarget('D:/ws', undefined)).toEqual({})
    expect(resolveCheckTarget('D:/ws', '')).toEqual({})
    expect(resolveCheckTarget('D:/ws', 'a; rm -rf /')).toHaveProperty('error')
    expect(resolveCheckTarget('D:/ws', '../outside.test.ts')).toHaveProperty('error')
    expect(resolveCheckTarget('D:/ws', 'C:/other.test.ts')).toHaveProperty('error')
    expect(resolveCheckTarget('D:/ws', 'src/x.ts > out.log')).toHaveProperty('error')
  })

  it('命令固定为 node + 工作区里的 vitest 入口，不经 shell', () => {
    const argv = buildCheckArgv('/ws/node_modules/vitest/vitest.mjs', 'tests/a.test.ts')
    expect(argv.command).toBe(process.execPath)
    expect(argv.args).toEqual(['/ws/node_modules/vitest/vitest.mjs', 'run', 'tests/a.test.ts'])
  })

  it('typecheck：走本地 tsc -p tsconfig.json --noEmit，不跑 vitest', () => {
    const argv = buildTypecheckArgv('/ws/node_modules/typescript/bin/tsc')
    expect(argv.command).toBe(process.execPath)
    expect(argv.args).toEqual([
      '/ws/node_modules/typescript/bin/tsc',
      '-p',
      'tsconfig.json',
      '--noEmit',
      '--allowImportingTsExtensions',
    ])
    expect(resolveCheckTarget('D:/ws', 'typecheck')).toEqual({ target: 'typecheck' })
  })

  it('只有勾了 check 的角色才看得到 run_check，老 id 会被收敛', () => {
    expect(toolsForAllow(['read']).map((tool) => tool.name)).not.toContain('run_check')
    expect(toolsForAllow(['check']).map((tool) => tool.name)).toContain('run_check')
    expect(normalizeToolAllow(['read', 'shell', 'check'])).toEqual(['read', 'check'])
    expect(normalizeToolAllow(['write', 'check'])).toEqual(['write', 'check'])
  })

  it('跑一次检查：超时/失败都有结论，日志落到群缓存', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-check-'))
    await mkdir(join(root, 'node_modules/vitest'), { recursive: true })
    await writeFile(join(root, 'node_modules/vitest/vitest.mjs'), 'export {}\n', 'utf8')
    const seen: CheckSpec[] = []
    const result = await runCheck(
      { workspaceRoot: root, threadId: 'thread-1', rawTarget: 'tests/x.test.ts' },
      async (spec) => {
        seen.push(spec)
        return { exitCode: 1, timedOut: false, output: 'FAIL tests/x.test.ts > 期望 1 实得 2', ms: 1200 }
      },
    )
    expect(seen[0].command).toBe(process.execPath)
    expect(seen[0].args.slice(-2)).toEqual(['run', 'tests/x.test.ts'])
    expect(seen[0].cwd).toBe(root)
    expect(seen[0].env.NO_COLOR).toBe('1')
    expect(seen[0].timeoutMs).toBe(60_000)
    expect((seen[0] as unknown as { shell?: unknown }).shell).toBeUndefined()
    expect(result.logPath).toContain(join('.dsh-im', 'thread-1', '.cache', 'checks'))
    const text = formatCheckResult(result)
    expect(text).toContain('失败（退出码 1）')
    expect(text).toContain('FAIL tests/x.test.ts')
  })

  it('typecheck 真跑时用固定参数，日志落到群缓存', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-typecheck-'))
    await mkdir(join(root, 'node_modules/typescript/bin'), { recursive: true })
    await writeFile(join(root, 'node_modules/typescript/bin/tsc'), '#!/usr/bin/env node\n', 'utf8')
    const seen: CheckSpec[] = []
    const result = await runCheck(
      { workspaceRoot: root, threadId: 'thread-1', rawTarget: 'typecheck' },
      async (spec) => {
        seen.push(spec)
        return { exitCode: 0, timedOut: false, output: 'tsc: no errors', ms: 800 }
      },
    )
    expect(seen[0].args).toEqual([
      join(root, 'node_modules/typescript/bin/tsc'),
      '-p',
      'tsconfig.json',
      '--noEmit',
      '--allowImportingTsExtensions',
    ])
    expect(result.command).toContain('tsc')
    expect(result.logPath).toContain(join('.dsh-im', 'thread-1', '.cache', 'checks'))
    expect(formatCheckResult(result)).toContain('通过（退出码 0）')
  })

  it('工作区没有 vitest 时明确报错，并给出当前检查根，而不是去调外部命令', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-check-'))
    await expect(runCheck({ workspaceRoot: root, threadId: 't' })).rejects.toThrow(/vitest/)
    await expect(runCheck({ workspaceRoot: root, threadId: 't' })).rejects.toThrow(/当前检查根/)
  })
})
