import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { imPersistPlugin } from './src/dev/persist-plugin'

export default defineConfig({
  plugins: [react(), imPersistPlugin()],
  server: { port: 5173 },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // 隔离测试数据根记忆文件，绝不写用户真实 home（见 test/setup.ts）。
    setupFiles: ['./test/setup.ts'],
  },
})
