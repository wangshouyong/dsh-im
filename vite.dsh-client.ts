import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  build: {
    lib: {
      entry: 'src/dsh/client-entry.tsx',
      formats: ['cjs'],
      fileName: () => 'client.inner.cjs',
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime'],
    },
    outDir: 'lib',
    emptyOutDir: false,
    sourcemap: false,
  },
})
