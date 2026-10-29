import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 開發時把 /api 轉給本機的 Rust 後端（cargo run，預設 :8080）
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
})
