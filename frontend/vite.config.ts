import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('react-pdf') || id.includes('pdfjs-dist')) return 'pdf-viewer';
          if (id.includes('react-markdown') || id.includes('micromark') || id.includes('remark') || id.includes('unified')) return 'markdown';
          if (id.includes('lucide-react')) return 'icons';
          if (id.includes('react') || id.includes('react-dom') || id.includes('react-router-dom') || id.includes('scheduler')) return 'react-vendor';
          return undefined;
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 17890,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:17891',
        changeOrigin: true,
        timeout: 600000, // 10 min for long SSE streams (summary generation)
      },
      '/uploads': {
        target: 'http://127.0.0.1:17891',
        changeOrigin: true,
      },
    },
  },
})
