import { api } from '../api'

/** 對應後端 mcp_server.rs 的 Key */
export type McpKey = {
  id: number
  name: string
  /** 金鑰的開頭（oym_1a2b3c4d），認得出是哪一把 */
  prefix: string
  created_at: string
  last_used_at: string | null
}

/** 剛建立的金鑰：token 只有這一次拿得到 */
export type CreatedKey = McpKey & { token: string }

export const listKeys = () => api<McpKey[]>('/mcp/keys')
export const createKey = (name: string) =>
  api<CreatedKey>('/mcp/keys', { method: 'POST', body: JSON.stringify({ name }) })
export const deleteKey = (id: number) => api<void>(`/mcp/keys/${id}`, { method: 'DELETE' })

/** 剛建立的金鑰：去測試頁再回來還看得到提詞，按「完成」或重新整理才消失。只放在記憶體 */
let lastCreated: CreatedKey | null = null
export function rememberCreated(key: CreatedKey | null) {
  lastCreated = key
}
export function rememberedCreated() {
  return lastCreated
}

/** 剛建立的金鑰帶到測試頁用；只放在記憶體，重新整理就沒了。測試頁拿到之後清掉 */
let handoff: string | null = null
export function handOffKey(token: string | null) {
  handoff = token
}
export function handedOffKey() {
  return handoff
}

// ---- 測試頁的 MCP 用戶端：照 AI 連 /mcp 的方式送 JSON-RPC ----

/** 每個請求自己帶版本，沒有 initialize */
export const MODERN = '2026-07-28'
/** 先 initialize 的版本 */
export const LEGACY = '2025-11-25'

const CLIENT_INFO = { name: 'ouyang.app MCP 測試頁', version: '1.0.0' }

export type JsonSchema = {
  type?: string | string[]
  description?: string
  enum?: (string | number)[]
  items?: JsonSchema
  minimum?: number
  maximum?: number
  format?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
}

export type McpTool = {
  name: string
  title?: string
  description?: string
  inputSchema: JsonSchema
  annotations?: { readOnlyHint?: boolean }
}

export type ToolResult = {
  content?: { type: string; text?: string }[]
  isError?: boolean
}

/** 一來一回：送了什麼、收到什麼，頁面上可以展開看 */
export type Exchange = {
  method: string
  /** 送出的 header（金鑰只留開頭） */
  headers: Record<string, string>
  body: unknown
  status: number
  /** 回應的 JSON；通知沒有回應（202） */
  response: unknown
  ms: number
}

export type Connection = {
  /** 實際用的協定版本 */
  protocol: string
  server: { name?: string; title?: string; version?: string }
  instructions?: string
  tools: McpTool[]
}

/** 協定錯誤（HTTP 不是 2xx，或回了 JSON-RPC 的 error） */
export class McpError extends Error {
  exchange: Exchange

  constructor(message: string, exchange: Exchange) {
    super(message)
    this.exchange = exchange
  }
}

/** header 放不下的值（非 ASCII 等）用 =?base64?…?= 包起來 */
function headerValue(value: string) {
  if (/^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(value) && !/^=\?base64\?.*\?=$/.test(value)) return value
  const bytes = new TextEncoder().encode(value)
  return `=?base64?${btoa(String.fromCharCode(...bytes))}?=`
}

function errorText(status: number, response: unknown) {
  const body = response as { error?: { code?: number; message?: string } | string; error_description?: string } | null
  if (body && typeof body.error === 'object') return `${body.error.code} ${body.error.message}`
  if (body?.error_description) return body.error_description
  return `HTTP ${status}`
}

export class McpClient {
  private nextId = 1
  /** 舊版 initialize 談好的版本 */
  private negotiated: string | null = null
  private readonly version: string
  private readonly key: string

  /** key 是空的就用登入的身分（只有本站頁面送的才收） */
  constructor(version: string, key: string) {
    this.version = version
    this.key = key.trim()
  }

  private get modern() {
    return this.version === MODERN
  }

  private async post(method: string, body: Record<string, unknown>): Promise<Exchange> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    if (this.key) headers.Authorization = `Bearer ${this.key}`
    if (this.modern) {
      headers['MCP-Protocol-Version'] = MODERN
      headers['Mcp-Method'] = method
      const name = (body.params as { name?: unknown } | undefined)?.name
      if (method === 'tools/call' && typeof name === 'string') headers['Mcp-Name'] = headerValue(name)
    } else if (this.negotiated) {
      headers['MCP-Protocol-Version'] = this.negotiated
    }
    const started = performance.now()
    const res = await fetch('/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      // 帶金鑰就不帶 cookie，才測得出金鑰本身能不能用
      credentials: this.key ? 'omit' : 'same-origin',
    })
    const text = await res.text()
    let response: unknown = null
    if (text) {
      try {
        response = JSON.parse(text)
      } catch {
        response = text
      }
    }
    const shown = { ...headers }
    if (shown.Authorization) shown.Authorization = `Bearer ${this.key.slice(0, 12)}…`
    return { method, headers: shown, body, status: res.status, response, ms: Math.round(performance.now() - started) }
  }

  /** 送一個請求，回傳 result；協定錯誤丟 McpError */
  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<{ result: T; exchange: Exchange }> {
    const meta = this.modern
      ? {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MODERN,
            'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        }
      : {}
    const exchange = await this.post(method, { jsonrpc: '2.0', id: this.nextId++, method, params: { ...params, ...meta } })
    const response = exchange.response as { result?: T } | null
    if (exchange.status >= 400 || !response || response.result === undefined) {
      throw new McpError(errorText(exchange.status, exchange.response), exchange)
    }
    return { result: response.result, exchange }
  }

  private async notify(method: string): Promise<Exchange> {
    const exchange = await this.post(method, { jsonrpc: '2.0', method })
    if (exchange.status !== 202) throw new McpError(errorText(exchange.status, exchange.response), exchange)
    return exchange
  }

  /** 連線：新版問 server/discover，舊版 initialize；再列出工具 */
  async connect(log: (exchange: Exchange) => void): Promise<Connection> {
    type Info = Connection['server']
    let protocol = this.version
    let server: Info = {}
    let instructions: string | undefined
    if (this.modern) {
      const { result, exchange } = await this.request<{ instructions?: string; _meta?: Record<string, Info> }>(
        'server/discover',
      )
      log(exchange)
      server = result._meta?.['io.modelcontextprotocol/serverInfo'] ?? {}
      instructions = result.instructions
    } else {
      const { result, exchange } = await this.request<{ protocolVersion: string; serverInfo?: Info; instructions?: string }>(
        'initialize',
        { protocolVersion: LEGACY, capabilities: {}, clientInfo: CLIENT_INFO },
      )
      log(exchange)
      this.negotiated = protocol = result.protocolVersion
      server = result.serverInfo ?? {}
      instructions = result.instructions
      log(await this.notify('notifications/initialized'))
    }
    const { result, exchange } = await this.request<{ tools: McpTool[] }>('tools/list')
    log(exchange)
    return { protocol, server, instructions, tools: result.tools }
  }

  callTool(name: string, args: Record<string, unknown>) {
    return this.request<ToolResult>('tools/call', { name, arguments: args })
  }
}
