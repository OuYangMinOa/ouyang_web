import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { errorMessage } from '../api'
import { copyToClipboard } from '../clipboard'
import { formatTime } from '../feedback/util'
import {
  createKey,
  deleteKey,
  handOffKey,
  listKeys,
  rememberCreated,
  rememberedCreated,
  type CreatedKey,
  type McpKey,
} from './api'
import { buildPrompt } from './prompt'
import './mcp.css'

function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    await copyToClipboard(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button type="button" className={className} onClick={copy}>
      {copied ? '已複製 ✓' : label}
    </button>
  )
}

export default function McpPage() {
  const origin = window.location.origin
  const endpoint = `${origin}/mcp`
  const [keys, setKeys] = useState<McpKey[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [created, setCreatedState] = useState<CreatedKey | null>(rememberedCreated)

  function setCreated(key: CreatedKey | null) {
    rememberCreated(key)
    setCreatedState(key)
  }

  useEffect(() => {
    listKeys()
      .then(setKeys)
      .catch((e) => setError(errorMessage(e)))
  }, [])

  async function create(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const key = await createKey(name.trim())
      setCreated(key)
      const { id, prefix, created_at, last_used_at } = key
      setKeys((list) => [{ id, name: key.name, prefix, created_at, last_used_at }, ...(list ?? [])])
      setName('')
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function remove(key: McpKey) {
    if (!confirm(`刪掉「${key.name}」？用這把金鑰的 AI 會馬上連不上。`)) return
    try {
      await deleteKey(key.id)
      setKeys((list) => list?.filter((k) => k.id !== key.id) ?? null)
      if (created?.id === key.id) {
        setCreated(null)
        handOffKey(null)
      }
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <div className="mcp">
      <h1>MCP</h1>
      <p className="muted">
        讓 AI（Claude、ChatGPT、Cursor…）直接查本站的米其林空位。建立一把金鑰，把產生的提詞整段貼給 AI，它就會照著接上。
      </p>
      {error && <p className="error">{error}</p>}

      <section className="card stack">
        <h2>連線資訊</h2>
        <dl className="mcp-facts">
          <div>
            <dt>網址</dt>
            <dd className="mcp-copyable">
              <code>{endpoint}</code>
              <CopyButton text={endpoint} label="複製" className="secondary" />
            </dd>
          </div>
          <div>
            <dt>驗證</dt>
            <dd>
              標頭 <code>Authorization: Bearer 金鑰</code>。不能加標頭的用戶端（claude.ai、ChatGPT 的自訂連接器）改用{' '}
              <code>{endpoint}?key=金鑰</code>
            </dd>
          </div>
          <div>
            <dt>協定</dt>
            <dd>Streamable HTTP。2026-07-28 的每個請求自己帶版本，2025-11-25 以前先 initialize 的用戶端也接。</dd>
          </div>
          <div>
            <dt>工具</dt>
            <dd>
              <code>michelin_availability</code> 查米其林空位 ·{' '}
              <Link className="text-link" to="/mcp/test">
                看參數、試試看
              </Link>
            </dd>
          </div>
        </dl>
      </section>

      <section className="card stack">
        <h2>建立金鑰</h2>
        <p className="muted">金鑰用你的身分查，只能查空位、不能改任何東西。給誰用就取誰的名字，不用了隨時刪掉。</p>
        <form className="inline-form mcp-create" onSubmit={create}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如「小明的 Claude」"
            maxLength={40}
            aria-label="金鑰的名字"
          />
          <button type="submit" disabled={busy || !name.trim()}>
            建立
          </button>
        </form>
        {created && <NewKey created={created} origin={origin} onDone={() => setCreated(null)} />}
      </section>

      <section className="stack mcp-list">
        <h2>我的金鑰</h2>
        {keys === null ? (
          !error && <p className="muted">載入中…</p>
        ) : keys.length === 0 ? (
          <p className="muted">還沒有金鑰。</p>
        ) : (
          <table className="responsive mcp-keys">
            <thead>
              <tr>
                <th>名字</th>
                <th>金鑰</th>
                <th>建立</th>
                <th>最後使用</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td data-label="名字" className="primary">
                    {key.name}
                  </td>
                  <td data-label="金鑰">
                    <code>{key.prefix}…</code>
                  </td>
                  <td data-label="建立">{formatTime(key.created_at)}</td>
                  <td data-label="最後使用">{key.last_used_at ? formatTime(key.last_used_at) : '還沒用過'}</td>
                  <td className="actions">
                    <button type="button" className="danger" onClick={() => remove(key)}>
                      刪除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

/** 剛建立的金鑰和給 AI 的提詞：金鑰只有這時候看得到 */
function NewKey({ created, origin, onDone }: { created: CreatedKey; origin: string; onDone: () => void }) {
  const navigate = useNavigate()
  const prompt = buildPrompt(origin, created.token)
  return (
    <div className="mcp-new stack">
      <p className="success">已建立「{created.name}」。金鑰只會顯示這一次，按完成之後就看不到了。</p>
      <div className="mcp-copyable">
        <code className="mcp-secret">{created.token}</code>
        <CopyButton text={created.token} label="複製金鑰" className="secondary" />
      </div>
      <h3>給 AI 的提詞</h3>
      <p className="muted">
        整段複製給對方，貼進他的 AI（Claude Code、Cursor、ChatGPT…）。AI 做得到就會自己設定好，做不到的會告訴他去哪裡加。
      </p>
      <pre className="mcp-prompt">{prompt}</pre>
      <div className="row">
        <CopyButton text={prompt} label="複製提詞" />
        <button
          type="button"
          className="secondary"
          onClick={() => {
            handOffKey(created.token)
            navigate('/mcp/test')
          }}
        >
          用這把金鑰測試
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          完成
        </button>
      </div>
    </div>
  )
}
