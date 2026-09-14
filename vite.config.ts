import { defineConfig } from 'vite';

export default defineConfig({
  build: { rollupOptions: { output: { manualChunks: { three: ['three', 'three/addons/controls/OrbitControls.js'] } } } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4318' },
  },
  preview: { proxy: { '/api': 'http://127.0.0.1:4318' } },
});
