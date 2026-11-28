/** 在設定裡用的伺服器名稱 */
export const SERVER_NAME = 'ouyang-michelin'

/** 給對方貼給自己 AI 的一段話：連線方式、各種用戶端怎麼設定、接上之後怎麼用 */
export function buildPrompt(origin: string, token: string) {
  const url = `${origin}/mcp`
  const auth = `Authorization: Bearer ${token}`
  const call = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'michelin_availability', arguments: { party: 2, meal: 'dinner' } },
  })
  return `請幫我接上「ouyang.app 米其林空位」這個 MCP 伺服器，之後我問台灣米其林星級餐廳哪天、幾點還能訂位，就用它查。

連線資訊
- 網址：${url}（Streamable HTTP）
- 驗證：每個請求帶標頭 ${auth}
- 不能自己加標頭的用戶端（claude.ai、Claude Desktop、ChatGPT 的「自訂連接器」）：網址改填 ${url}?key=${token}，驗證方式選「無」

依你所在的環境設定，做得到就直接幫我設好：
- Claude Code：claude mcp add --transport http ${SERVER_NAME} ${url} --header "${auth}"
- Cursor（~/.cursor/mcp.json）：{"mcpServers": {"${SERVER_NAME}": {"url": "${url}", "headers": {"Authorization": "Bearer ${token}"}}}}
- 其他用戶端（VS Code、Windsurf、Gemini CLI、Codex…）照上面的網址和標頭設定；你自己沒辦法改設定的話，告訴我要去哪裡、怎麼加。

接上之後
- 工具 michelin_availability：查台灣米其林星級餐廳近兩週還能訂的時段，可以指定人數（2、4、6 位）、日期或一段日子、午餐／晚餐或幾點到幾點、店名、地區、星等。
- 回答時說資料是幾點查的、附上訂位連結，提醒以訂位頁為準；它只能查，不能訂位。

沒辦法接 MCP、但可以執行指令的話，也能直接呼叫（JSON-RPC）：
curl -s ${url} -H "${auth}" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '${call}'

這把金鑰只能查空位；不要貼到公開的地方，外流了跟我說，我到 ${url} 刪掉。`
}
