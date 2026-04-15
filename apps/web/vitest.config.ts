import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['**/*.test.tsx', '**/*.test.ts'],
    exclude: ['node_modules', '.next', 'tests/e2e/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
      '@lima/aura-dsl': path.resolve(__dirname, '../../packages/aura-dsl/src/index.ts'),
      '@lima/widget-catalog': path.resolve(__dirname, '../../packages/widget-catalog/src/index.ts'),
      '@lima/sdk-connectors': path.resolve(__dirname, '../../packages/sdk-connectors/src/index.ts'),
    },
  },
})
