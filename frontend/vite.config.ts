import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // 最大的是 HEIC 解碼器 heic-to，約 3.2 MB（gzip 後 810 kB），只有在圖片轉檔遇到瀏覽器解不了的 HEIC 才下載；
    // 其次是 three.js 約 530 kB（gzip 後 130 kB），只在首頁動態載入，不影響其他頁面
    chunkSizeWarningLimit: 3300,
  },
  optimizeDeps: {
    // ffmpeg.wasm 用 new URL('./worker.js', import.meta.url) 開 worker，預先打包後相對路徑會跑掉，開發時就載不到
    exclude: ['@ffmpeg/ffmpeg'],
  },
  server: {
    // 開發時把 /api 轉給本機的 Rust 後端（cargo run，預設 :8080）
    proxy: {
      // ws：小遊戲線上對戰的 WebSocket 也走 /api
      '/api': { target: 'http://localhost:8080', ws: true },
      // 短網址的跳轉由後端處理
      '/s/': 'http://localhost:8080',
    },
  },
})
