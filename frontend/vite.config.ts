import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // three.js 的 chunk 約 530 kB（gzip 後 130 kB），只在首頁動態載入，不影響其他頁面
    chunkSizeWarningLimit: 600,
  },
  server: {
    // 開發時把 /api 轉給本機的 Rust 後端（cargo run，預設 :8080）
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
})
