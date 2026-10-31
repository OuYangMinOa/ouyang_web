/** User-Agent 太長，表格裡只顯示「裝置 · 瀏覽器」，完整的放在 title */
export function describeAgent(ua: string) {
  if (!ua) return '—'
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X/.test(ua)
            ? 'macOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : ''
  const browser = /\bLine\//.test(ua)
    ? 'LINE'
    : /FBAN|FBAV/.test(ua)
      ? 'Facebook'
      : /Edg\//.test(ua)
        ? 'Edge'
        : /SamsungBrowser/.test(ua)
          ? 'Samsung'
          : /OPR\//.test(ua)
            ? 'Opera'
            : /Firefox|FxiOS/.test(ua)
              ? 'Firefox'
              : /CriOS|Chrome\//.test(ua)
                ? 'Chrome'
                : /Safari\//.test(ua)
                  ? 'Safari'
                  : ''
  return [os, browser].filter(Boolean).join(' · ') || ua.slice(0, 40)
}
