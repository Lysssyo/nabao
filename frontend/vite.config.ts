import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  plugins: [vue()], base: '/admin/',
  build: { target: ['es2022', 'safari16.4'], sourcemap: false },
  server: { proxy: { '/internal': { target: 'http://127.0.0.1:18081', changeOrigin: false } } },
  test: { environment: 'jsdom', clearMocks: true, restoreMocks: true },
});
