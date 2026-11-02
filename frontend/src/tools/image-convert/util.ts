import type { OutFormat } from './convert'

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 2 : 1)} MB`
}

export const FORMAT_LABEL: Record<OutFormat, string> = {
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'image/avif': 'AVIF',
}

const EXT: Record<OutFormat, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
}

export function outputName(name: string, format: OutFormat) {
  const dot = name.lastIndexOf('.')
  return `${dot > 0 ? name.slice(0, dot) : name}.${EXT[format]}`
}

/** 打包檔名：images-2026-11-02.zip（本地日期） */
export function zipName() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `images-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.zip`
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 太早撤銷的話有些瀏覽器會下載失敗
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
