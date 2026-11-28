// npm run build 最後會跑這支，從 APP、小工具、小遊戲的登記（src/apps/registry.ts 等）產生兩樣東西：
// - 本站的功能清單 dist/site-catalog.json：後端 AI 助手的「搜尋本站功能」（backend/src/ai_builtin.rs 的 site_search）
//   和給爬蟲的網站地圖、robots.txt（backend/src/crawlers.rs）都從這裡查
// - dist/index.html 裡沒登入時的首頁：不跑 JavaScript 的爬蟲（搜尋引擎、公司防火牆的網站分類）才看得到網站在做什麼
// 之後新增 APP、工具或遊戲，只要登記進 registry 就會跟著變，不用另外維護清單。
//
// 用 Vite 的 SSR 載入 registry（TypeScript、路徑別名都照前端的設定），遊戲和工具本身是 lazy import，不會被載入。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(root, 'dist/site-catalog.json')
const indexHtml = resolve(root, 'dist/index.html')
const ROOT = '<div id="root"></div>'

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/**
 * 沒登入的人看到的首頁（頁首、自我介紹、作品清單），寫成 HTML 放進 index.html 的 #root。
 * class 跟 Home.tsx 和 App.tsx 的 Header 一樣，樣式直接套用；React 載入後 createRoot 會換掉 #root 裡的東西。
 * 每個網址回的都是這份 index.html：後面那段小程式在首頁以外先清掉，等 React 畫出那一頁，不會先閃一下首頁。
 */
function staticHome(home, apps) {
  const item = (entry) => {
    const body =
      `<span class="home-item-glyph" aria-hidden="true">${escapeHtml(entry.glyph)}</span>` +
      `<span class="home-item-name">${escapeHtml(entry.name)}</span>` +
      `<span class="home-item-desc">${escapeHtml(entry.desc)}</span>` +
      `<span class="home-item-tag${entry.live ? ' live' : ''}">${escapeHtml(entry.tag)}</span>`
    return entry.to
      ? `<li><a class="home-item" href="${escapeHtml(entry.to)}">${body}<span class="home-item-go" aria-hidden="true">→</span></a></li>`
      : `<li><div class="home-item">${body}</div></li>`
  }
  const profile = home.PROFILE.map((row) => `<div><dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd></div>`)
  return `<div id="root">
      <div class="site-top">
        <header class="site-header">
          <a href="/" class="brand">歐陽天地</a>
          <div class="header-end"><a href="/login" class="header-link">登入</a></div>
        </header>
      </div>
      <main>
        <section class="home-intro">
          <div class="home-wrap home-intro-grid">
            <div class="home-intro-copy">
              <h1 class="home-name">${escapeHtml(home.OWNER)}</h1>
              <p class="home-lead">${escapeHtml(home.LEAD)}</p>
              <dl class="home-profile">${profile.join('')}</dl>
            </div>
          </div>
        </section>
        <section id="works" class="home-section">
          <div class="home-wrap">
            <header class="home-head">
              <h2>${escapeHtml(home.WORKS.title)}</h2>
              <p>${escapeHtml(home.WORKS.note)}</p>
            </header>
            <ul class="home-items">
              ${[home.BOT, ...apps].map(item).join('\n              ')}
            </ul>
          </div>
        </section>
        <noscript><p class="home-wrap muted">這個網站的功能要開啟 JavaScript 才能使用。</p></noscript>
      </main>
    </div>
    <script>
      // 上面的首頁只給首頁和不跑 JavaScript 的爬蟲；其他網址先清掉，等 React 畫出那一頁
      if (location.pathname !== '/') document.getElementById('root').replaceChildren()
    </script>`
}

/** 不在任何 APP 裡、但使用者會問到的頁面 */
const EXTRA_PAGES = [
  { id: 'feedback', name: '回報與許願', url: '/feedback', description: '回報問題或許願想要的新功能，管理員會在這裡回覆，不用登入也能送。' },
  { id: 'account', name: '我的帳號', url: '/account', description: '修改自己的密碼。', login: true },
]

const server = await createServer({
  root,
  configFile: resolve(root, 'vite.config.ts'),
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
})

try {
  const registry = await server.ssrLoadModule('/src/apps/registry.ts')
  const { APPS } = registry
  const { TOOLS } = await server.ssrLoadModule('/src/tools/registry.ts')
  const { GAMES } = await server.ssrLoadModule('/src/games/registry.ts')

  const items = [
    ...APPS.map((app) => ({
      kind: 'app',
      id: app.id,
      name: app.name,
      description: app.blurb,
      url: `/${app.id}`,
      tags: [app.tag].filter(Boolean),
      login: !!app.loginOnly,
      permission: app.permission ?? null,
      // 小遊戲、小工具的頁面就是下面一個一個的項目，不用重複列
      pages: ['games', 'tools'].includes(app.id)
        ? []
        : app.nav.flatMap((group) => group.items).map((item) => ({ label: item.label, url: item.to })),
    })),
    ...TOOLS.map((tool) => ({
      kind: 'tool',
      id: tool.id,
      name: tool.name,
      description: tool.blurb,
      url: `/tools/${tool.id}`,
      tags: tool.tags,
      category: tool.category,
    })),
    ...GAMES.map((game) => ({
      kind: 'game',
      id: game.id,
      name: game.name,
      description: game.blurb,
      url: `/games/${game.id}`,
      tags: game.tags,
      category: game.category,
      players: game.lobby?.players ?? null,
    })),
    ...EXTRA_PAGES.map((page) => ({ kind: 'page', tags: [], login: false, ...page })),
  ]

  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, JSON.stringify({ generated_at: new Date().toISOString(), items }, null, 1))
  const count = (kind) => items.filter((item) => item.kind === kind).length
  console.log(
    `site-catalog.json：${count('app')} 個 APP、${count('tool')} 個小工具、${count('game')} 款遊戲、${count('page')} 個頁面`,
  )

  // 首頁的靜態版本：作品清單只放沒登入也看得到的 APP
  const home = await server.ssrLoadModule('/src/pages/homeContent.ts')
  const apps = registry.visibleApps({ user: null, can: () => false }).map((app) => ({
    glyph: app.glyph,
    name: app.name,
    desc: app.blurb,
    tag: app.tag,
    to: registry.appPath(app),
  }))
  const page = await readFile(indexHtml, 'utf8')
  if (page.split(ROOT).length !== 2) throw new Error(`dist/index.html 裡要剛好有一個 ${ROOT}`)
  await writeFile(indexHtml, page.replace(ROOT, () => staticHome(home, apps)))
  console.log(`index.html：寫進沒登入時的首頁（${apps.length} 個 APP）`)
} finally {
  await server.close()
}
