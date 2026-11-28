import { useEffect, useState, type FormEvent } from 'react'
import { errorMessage } from '../api'
import {
  LEGACY,
  MODERN,
  McpClient,
  McpError,
  handOffKey,
  handedOffKey,
  type Connection,
  type Exchange,
  type JsonSchema,
  type McpTool,
  type ToolResult,
} from './api'
import './mcp.css'

type Values = Record<string, string | string[]>

type Connected = { client: McpClient; connection: Connection; withKey: boolean }

type Failure = { message: string; exchange?: Exchange }

function failure(e: unknown): Failure {
  return { message: errorMessage(e), exchange: e instanceof McpError ? e.exchange : undefined }
}

type Attempt = { connected: Connected | null; error: Failure | null; exchanges: Exchange[] }

/** 連一次：連上了、或錯在哪，加上過程中送的每個請求 */
async function attempt(version: string, key: string): Promise<Attempt> {
  const client = new McpClient(version, key)
  const exchanges: Exchange[] = []
  try {
    const connection = await client.connect((exchange) => exchanges.push(exchange))
    return { connected: { client, connection, withKey: !!key.trim() }, error: null, exchanges }
  } catch (e) {
    return { connected: null, error: failure(e), exchanges }
  }
}

export default function McpTest() {
  // 從「用這把金鑰測試」過來的帶著剛建立的金鑰，其他時候用登入的身分
  const [initialKey] = useState(() => handedOffKey() ?? '')
  const [version, setVersion] = useState(MODERN)
  const [key, setKey] = useState(initialKey)
  const [connected, setConnected] = useState<Connected | null>(null)
  const [exchanges, setExchanges] = useState<Exchange[]>([])
  const [error, setError] = useState<Failure | null>(null)
  // 一進來就連線
  const [busy, setBusy] = useState(true)

  function show(result: Attempt) {
    setConnected(result.connected)
    setError(result.error)
    setExchanges(result.exchanges)
    setBusy(false)
  }

  useEffect(() => {
    let active = true
    handOffKey(null)
    attempt(MODERN, initialKey).then((result) => {
      if (!active) return
      setConnected(result.connected)
      setError(result.error)
      setExchanges(result.exchanges)
      setBusy(false)
    })
    return () => {
      active = false
    }
  }, [initialKey])

  function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setConnected(null)
    attempt(version, key).then(show)
  }

  const connection = connected?.connection
  return (
    <div className="mcp">
      <h1>測試 MCP</h1>
      <p className="muted">
        照 AI 連上 /mcp 的方式送 JSON-RPC：先看有哪些工具，再填參數呼叫，看 AI 會拿到什麼。每個請求和回應都可以展開來看。
      </p>

      <section className="card stack">
        <h2>連線</h2>
        <form className="mcp-connect" onSubmit={submit}>
          <label>
            協定版本
            <select value={version} onChange={(e) => setVersion(e.target.value)}>
              <option value={MODERN}>{MODERN}（每個請求自己帶版本）</option>
              <option value={LEGACY}>{LEGACY}（先 initialize）</option>
            </select>
          </label>
          <label>
            金鑰（選填）
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="留空就用你的登入身分"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? '連線中…' : '重新連線'}
          </button>
        </form>
        {connected && (
          <p className="success">
            已連上 {connected.connection.server.title ?? connected.connection.server.name ?? '伺服器'}
            {connected.connection.server.version && `（版本 ${connected.connection.server.version.slice(0, 7)}）`} · 協定{' '}
            {connected.connection.protocol} · {connected.connection.tools.length} 個工具 ·{' '}
            {connected.withKey ? '用金鑰' : '用登入的身分'}
          </p>
        )}
        {error && <p className="error">連不上：{error.message}</p>}
        {connection?.instructions && <p className="muted">給 AI 的說明：{connection.instructions}</p>}
        {exchanges.length > 0 && (
          <details className="mcp-exchanges">
            <summary>連線時送了 {exchanges.length} 個請求</summary>
            {exchanges.map((exchange, i) => (
              <ExchangeView key={i} exchange={exchange} />
            ))}
          </details>
        )}
      </section>

      {connected?.connection.tools.map((tool) => (
        <ToolCard key={`${connected.connection.protocol}-${tool.name}`} tool={tool} client={connected.client} />
      ))}
    </div>
  )
}

function primaryType(schema: JsonSchema | undefined) {
  const type = schema?.type
  return Array.isArray(type) ? type.find((t) => t !== 'null') : type
}

function cast(schema: JsonSchema | undefined, value: string): unknown {
  const type = primaryType(schema)
  if (type === 'integer' || type === 'number') {
    const number = Number(value)
    return Number.isFinite(number) ? number : value
  }
  if (type === 'boolean') return value === 'true'
  return value
}

/** 表單填的值 → 送出的 arguments：沒填的不送 */
function buildArgs(schema: JsonSchema, values: Values) {
  const args: Record<string, unknown> = {}
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const value = values[name]
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) continue
    args[name] = Array.isArray(value) ? value.map((v) => cast(property.items, v)) : cast(property, value)
  }
  return args
}

type Outcome = { result?: ToolResult; error?: Failure; exchange?: Exchange }

function ToolCard({ tool, client }: { tool: McpTool; client: McpClient }) {
  const [values, setValues] = useState<Values>({})
  const [running, setRunning] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const properties = Object.entries(tool.inputSchema.properties ?? {})
  const required = tool.inputSchema.required ?? []
  const args = buildArgs(tool.inputSchema, values)

  async function run(e: FormEvent) {
    e.preventDefault()
    setRunning(true)
    try {
      const { result, exchange } = await client.callTool(tool.name, args)
      setOutcome({ result, exchange })
    } catch (err) {
      const error = failure(err)
      setOutcome({ error, exchange: error.exchange })
    } finally {
      setRunning(false)
    }
  }

  return (
    <section className="card stack">
      <div className="mcp-tool-head">
        <h2>{tool.title ?? tool.name}</h2>
        <code>{tool.name}</code>
        {tool.annotations?.readOnlyHint && <span className="badge ok">只讀</span>}
      </div>
      {tool.description && <p className="mcp-description">{tool.description}</p>}
      <form className="stack" onSubmit={run}>
        {properties.length > 0 ? (
          <div className="mcp-fields">
            {properties.map(([name, schema]) => (
              <Field
                key={name}
                name={name}
                schema={schema}
                required={required.includes(name)}
                value={values[name]}
                onChange={(value) => setValues((old) => ({ ...old, [name]: value }))}
              />
            ))}
          </div>
        ) : (
          <p className="muted">這個工具沒有參數。</p>
        )}
        <div className="stack mcp-args">
          <p className="muted">送出的 arguments</p>
          <pre className="mcp-json">{JSON.stringify(args, null, 2)}</pre>
        </div>
        <div className="row">
          <button type="submit" disabled={running}>
            {running ? '執行中…' : '執行'}
          </button>
          <button type="button" className="secondary" onClick={() => setValues({})}>
            清除參數
          </button>
        </div>
      </form>
      {outcome && <OutcomeView outcome={outcome} />}
    </section>
  )
}

/** 依 JSON Schema 產生一個欄位：選項是下拉、多選是勾選、數字、日期、時間，其他是文字 */
function Field({
  name,
  schema,
  required,
  value,
  onChange,
}: {
  name: string
  schema: JsonSchema
  required: boolean
  value: string | string[] | undefined
  onChange: (value: string | string[]) => void
}) {
  const type = primaryType(schema)
  const heading = (
    <>
      <code>{name}</code>
      {required && <span className="mcp-required">必填</span>}
    </>
  )
  const help = schema.description && <span className="muted mcp-help">{schema.description}</span>

  if (type === 'array' && schema.items?.enum) {
    const selected = Array.isArray(value) ? value : []
    return (
      <fieldset className="mcp-field">
        <legend>{heading}</legend>
        <div className="checks">
          {schema.items.enum.map((option) => {
            const text = String(option)
            return (
              <label key={text}>
                <input
                  type="checkbox"
                  checked={selected.includes(text)}
                  onChange={(e) => onChange(e.target.checked ? [...selected, text] : selected.filter((v) => v !== text))}
                />
                {text}
              </label>
            )
          })}
        </div>
        {help}
      </fieldset>
    )
  }

  const text = typeof value === 'string' ? value : ''
  let control
  if (schema.enum || type === 'boolean') {
    const options = schema.enum?.map(String) ?? ['true', 'false']
    control = (
      <select value={text} onChange={(e) => onChange(e.target.value)}>
        <option value="">（不指定）</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    )
  } else if (type === 'integer' || type === 'number') {
    control = (
      <input
        type="number"
        inputMode={type === 'integer' ? 'numeric' : 'decimal'}
        min={schema.minimum}
        max={schema.maximum}
        step={type === 'integer' ? 1 : 'any'}
        value={text}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  } else {
    // 說明寫 HH:MM 的是時刻（例如 18:30）
    const inputType = schema.format === 'date' ? 'date' : schema.description?.includes('HH:MM') ? 'time' : 'text'
    control = <input type={inputType} value={text} onChange={(e) => onChange(e.target.value)} />
  }
  return (
    <label className="mcp-field">
      <span>{heading}</span>
      {control}
      {help}
    </label>
  )
}

/** 工具結果的文字是 JSON 就排好給人看 */
function pretty(item: { type: string; text?: string }) {
  if (item.type !== 'text' || item.text === undefined) return JSON.stringify(item, null, 2)
  try {
    return JSON.stringify(JSON.parse(item.text), null, 2)
  } catch {
    return item.text
  }
}

function OutcomeView({ outcome }: { outcome: Outcome }) {
  const { result, error, exchange } = outcome
  return (
    <div className="mcp-outcome stack">
      <h3>結果</h3>
      {error ? (
        <p className="error">協定錯誤：{error.message}</p>
      ) : result?.isError ? (
        <p className="error">工具回報錯誤（isError）：AI 會看到這段文字，改了參數再試。</p>
      ) : (
        <p className="success">完成{exchange && ` · ${exchange.ms} ms`}</p>
      )}
      {result?.content?.map((item, i) => (
        <pre key={i} className="mcp-json mcp-result">
          {pretty(item)}
        </pre>
      ))}
      {exchange && <ExchangeView exchange={exchange} />}
    </div>
  )
}

function ExchangeView({ exchange }: { exchange: Exchange }) {
  const headers = Object.entries(exchange.headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')
  const response =
    exchange.response === null
      ? '（沒有內容）'
      : typeof exchange.response === 'string'
        ? exchange.response
        : JSON.stringify(exchange.response, null, 2)
  return (
    <details className="mcp-exchange">
      <summary>
        <code>{exchange.method}</code> · HTTP {exchange.status} · {exchange.ms} ms
      </summary>
      <p className="muted">送出：POST /mcp</p>
      <pre className="mcp-json">{`${headers}\n\n${JSON.stringify(exchange.body, null, 2)}`}</pre>
      <p className="muted">收到</p>
      <pre className="mcp-json">{response}</pre>
    </details>
  )
}
