// 從 APP、小工具、小遊戲的登記（src/apps/registry.ts 等）產生本站的功能清單 dist/site-catalog.json，
// 給後端 AI 助手的「搜尋本站功能」工具（backend/src/ai_builtin.rs 的 site_search）查。
// npm run build 最後會跑這支：之後新增 APP、工具或遊戲，只要登記進 registry，AI 就查得到，不用另外維護清單。
//
// 用 Vite 的 SSR 載入 registry（TypeScript、路徑別名都照前端的設定），遊戲和工具本身是 lazy import，不會被載入。
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(root, 'dist/site-catalog.json')

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
  const { APPS } = await server.ssrLoadModule('/src/apps/registry.ts')
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
} finally {
  await server.close()
}
