import { useEffect, useMemo, useRef, useState } from 'react'
import { copyToClipboard } from '../../clipboard'
import {
  formatUnits,
  minTransfers,
  parseMoney,
  splitExpense,
  summarize,
  type Expense,
  type Member,
  type SplitMode,
} from './settle'
import './split-bill.css'

type State = {
  title: string
  members: Member[]
  expenses: Expense[]
  /** 算到元（true）還是算到角分（false） */
  whole: boolean
}

const STORE_KEY = 'tools:split-bill:v1'
const EMPTY: State = { title: '', members: [], expenses: [], whole: true }

const MODES: { value: SplitMode; label: string }[] = [
  { value: 'equal', label: '平均' },
  { value: 'ratio', label: '比例' },
  { value: 'amount', label: '自訂金額' },
]

// http 網站沒有 crypto.randomUUID，自己湊一個夠用的 id
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

const isStr = (v: unknown): v is string => typeof v === 'string'

// 存檔可能是舊版或被改壞，逐欄檢查
function load(): State {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return EMPTY
    const s = JSON.parse(raw) as Partial<State>
    const members = Array.isArray(s.members)
      ? s.members.filter((m): m is Member => !!m && isStr(m.id) && isStr(m.name))
      : []
    const ids = new Set(members.map((m) => m.id))
    const expenses = Array.isArray(s.expenses)
      ? s.expenses
          .filter((e): e is Expense => !!e && isStr(e.id) && isStr(e.amount) && isStr(e.payer))
          .map((e) => ({
            id: e.id,
            title: isStr(e.title) ? e.title : '',
            payer: e.payer,
            amount: e.amount,
            mode: MODES.some((m) => m.value === e.mode) ? e.mode : 'equal',
            participants: Array.isArray(e.participants) ? e.participants.filter((p) => isStr(p) && ids.has(p)) : [],
            shares: e.shares && typeof e.shares === 'object' ? Object.fromEntries(Object.entries(e.shares).filter(([, v]) => isStr(v))) : {},
          }))
      : []
    return { title: isStr(s.title) ? s.title : '', members, expenses, whole: s.whole !== false }
  } catch {
    return EMPTY
  }
}

function save(state: State) {
  try {
    if (state.members.length === 0 && state.expenses.length === 0 && !state.title) localStorage.removeItem(STORE_KEY)
    else localStorage.setItem(STORE_KEY, JSON.stringify(state))
  } catch {
    // 存不了就算了，只是重新整理後要重打
  }
}

export default function SplitBill() {
  const [state, setState] = useState<State>(load)
  const [editing, setEditing] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [memberError, setMemberError] = useState('')
  const [copied, setCopied] = useState<'idle' | 'done' | 'fail'>('idle')
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const { title, members, expenses, whole } = state
  const unit = whole ? 1 : 0.01

  useEffect(() => save(state), [state])
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const nameOf = (id: string) => members.find((m) => m.id === id)?.name || '（未命名）'
  const money = (units: number) => formatUnits(units, unit)

  const summary = useMemo(() => summarize(members, expenses, unit), [members, expenses, unit])
  const transfers = useMemo(() => minTransfers(summary.rows), [summary])
  const badCount = expenses.length - summary.counted

  /* ---- 成員 ---- */

  const addMember = () => {
    const name = newName.trim()
    if (!name) return
    if (members.some((m) => m.name === name)) {
      setMemberError(`已經有「${name}」了`)
      return
    }
    const m = { id: newId(), name }
    // 新成員預設加入每一筆「平均」分攤的支出
    setState((s) => ({
      ...s,
      members: [...s.members, m],
      expenses: s.expenses.map((e) => (e.mode === 'equal' ? { ...e, participants: [...e.participants, m.id] } : e)),
    }))
    setNewName('')
    setMemberError('')
  }

  const renameMember = (id: string, name: string) =>
    setState((s) => ({ ...s, members: s.members.map((m) => (m.id === id ? { ...m, name } : m)) }))

  const removeMember = (id: string) => {
    const paidFor = expenses.filter((e) => e.payer === id)
    if (paidFor.length) {
      setMemberError(`${nameOf(id)} 是「${paidFor[0].title || '未命名支出'}」的付款人，請先改掉付款人再移除。`)
      return
    }
    setState((s) => ({
      ...s,
      members: s.members.filter((m) => m.id !== id),
      expenses: s.expenses.map((e) => ({ ...e, participants: e.participants.filter((p) => p !== id) })),
    }))
    setMemberError('')
  }

  /* ---- 支出 ---- */

  const addExpense = () => {
    const e: Expense = {
      id: newId(),
      title: '',
      payer: members[0]?.id ?? '',
      amount: '',
      mode: 'equal',
      participants: members.map((m) => m.id),
      shares: {},
    }
    setState((s) => ({ ...s, expenses: [...s.expenses, e] }))
    setEditing(e.id)
  }
  const updateExpense = (id: string, patch: Partial<Expense>) =>
    setState((s) => ({ ...s, expenses: s.expenses.map((e) => (e.id === id ? { ...e, ...patch } : e)) }))
  const removeExpense = (id: string) => {
    setState((s) => ({ ...s, expenses: s.expenses.filter((e) => e.id !== id) }))
    if (editing === id) setEditing(null)
  }

  const clearAll = () => {
    if (!confirm('確定要清除所有成員和支出嗎？')) return
    setState(EMPTY)
    setEditing(null)
    setMemberError('')
  }

  /* ---- 複製成文字 ---- */

  const buildText = () => {
    const lines = [`【分帳結果】${title.trim()}`.trimEnd()]
    lines.push(`總支出 $${money(summary.total)}（${summary.counted} 筆），${members.length} 人`)
    lines.push('', '— 支出明細 —')
    for (const e of expenses) {
      const r = splitExpense(e, members, unit)
      if (!r.ok) continue
      const who = [...r.shares.entries()].filter(([, v]) => v > 0).map(([id]) => nameOf(id))
      lines.push(`・${e.title.trim() || '支出'} $${money(r.amount)}，${nameOf(e.payer)} 付，${who.length === members.length ? '全員' : who.join('、')}分`)
    }
    lines.push('', '— 每人 —')
    for (const r of summary.rows) {
      const diff = r.net > 0 ? `應收 $${money(r.net)}` : r.net < 0 ? `應付 $${money(-r.net)}` : '剛好'
      lines.push(`・${nameOf(r.id)}：分攤 $${money(r.owe)}，已付 $${money(r.paid)}，${diff}`)
    }
    lines.push('', '— 轉帳 —')
    if (transfers.length === 0) lines.push('不用轉帳')
    for (const t of transfers) lines.push(`・${nameOf(t.from)} → ${nameOf(t.to)}　$${money(t.amount)}`)
    return lines.join('\n')
  }

  const copy = async () => {
    try {
      await copyToClipboard(buildText())
      setCopied('done')
    } catch {
      setCopied('fail')
    }
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied('idle'), 1500)
  }

  return (
    <div className="sb">
      <section className="card sb-card">
        <label>
          活動名稱（選填）
          <input type="text" value={title} placeholder="例如：墾丁三天兩夜" onChange={(e) => setState((s) => ({ ...s, title: e.target.value }))} />
        </label>

        <h2>成員</h2>
        {members.length === 0 && <p className="muted">先加入一起分帳的人。</p>}
        <ul className="sb-members">
          {members.map((m) => (
            <li key={m.id}>
              <input type="text" aria-label="成員名稱" value={m.name} onChange={(e) => renameMember(m.id, e.target.value)} />
              <button type="button" className="secondary sb-icon" onClick={() => removeMember(m.id)} aria-label={`移除 ${m.name}`} title="移除">
                ✕
              </button>
            </li>
          ))}
        </ul>
        <form
          className="sb-add"
          onSubmit={(e) => {
            e.preventDefault()
            addMember()
          }}
        >
          <input type="text" aria-label="新成員名稱" placeholder="名字" value={newName} enterKeyHint="done" onChange={(e) => setNewName(e.target.value)} />
          <button type="submit" disabled={!newName.trim()}>
            加入
          </button>
        </form>
        {memberError && <p className="error">{memberError}</p>}
      </section>

      <section className="card sb-card">
        <div className="sb-head">
          <h2>支出</h2>
          <label className="sb-check">
            <input type="checkbox" checked={whole} onChange={(e) => setState((s) => ({ ...s, whole: e.target.checked }))} />
            <span>算到整數元</span>
          </label>
        </div>
        {expenses.length === 0 && <p className="muted">{members.length < 2 ? '至少要有兩位成員才能分帳。' : '還沒有支出，按下面的按鈕新增。'}</p>}
        <ul className="sb-expenses">
          {expenses.map((e) => (
            <ExpenseItem
              key={e.id}
              expense={e}
              members={members}
              unit={unit}
              open={editing === e.id}
              onToggle={() => setEditing(editing === e.id ? null : e.id)}
              onChange={(patch) => updateExpense(e.id, patch)}
              onRemove={() => removeExpense(e.id)}
              nameOf={nameOf}
            />
          ))}
        </ul>
        <button type="button" className="sb-add-expense" onClick={addExpense} disabled={members.length === 0}>
          ＋ 新增支出
        </button>
      </section>

      {members.length > 0 && (
        <section className="card sb-card">
          <h2>結果</h2>
          <p className="muted">
            總支出 ${money(summary.total)}（{summary.counted} 筆）
            {badCount > 0 && <span className="sb-warn">，有 {badCount} 筆還沒填完整，沒有算進來</span>}
          </p>
          <div className="table-wrap">
            <table className="responsive sb-table">
              <thead>
                <tr>
                  <th>成員</th>
                  <th>應付（分攤）</th>
                  <th>已付</th>
                  <th>差額</th>
                </tr>
              </thead>
              <tbody>
                {summary.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="primary">{nameOf(r.id)}</td>
                    <td data-label="應付">${money(r.owe)}</td>
                    <td data-label="已付">${money(r.paid)}</td>
                    <td data-label="差額" className={r.net > 0 ? 'sb-pos' : r.net < 0 ? 'sb-neg' : ''}>
                      {r.net > 0 ? `應收 $${money(r.net)}` : r.net < 0 ? `應付 $${money(-r.net)}` : '剛好'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="sb-sub">轉帳（共 {transfers.length} 次）</h3>
          {transfers.length === 0 ? (
            <p className="muted">大家都剛好，不用轉帳。</p>
          ) : (
            <ol className="sb-transfers">
              {transfers.map((t, i) => (
                <li key={i}>
                  <span className="sb-who">{nameOf(t.from)}</span>
                  <span className="sb-arrow" aria-label="轉給">
                    →
                  </span>
                  <span className="sb-who">{nameOf(t.to)}</span>
                  <strong className="sb-amt">${money(t.amount)}</strong>
                </li>
              ))}
            </ol>
          )}

          <div className="sb-actions">
            <button type="button" onClick={copy} aria-live="polite">
              {copied === 'done' ? '✓ 已複製' : copied === 'fail' ? '複製失敗' : '複製結果（貼到 LINE）'}
            </button>
            <button type="button" className="danger" onClick={clearAll}>
              全部清除
            </button>
          </div>
          <p className="muted sb-note">資料只存在這台裝置的瀏覽器裡。轉帳方式已盡量減少次數。</p>
        </section>
      )}
    </div>
  )
}

function ExpenseItem({
  expense: e,
  members,
  unit,
  open,
  onToggle,
  onChange,
  onRemove,
  nameOf,
}: {
  expense: Expense
  members: Member[]
  unit: number
  open: boolean
  onToggle: () => void
  onChange: (patch: Partial<Expense>) => void
  onRemove: () => void
  nameOf: (id: string) => string
}) {
  const result = splitExpense(e, members, unit)
  const amount = parseMoney(e.amount)
  const toggle = (id: string, on: boolean) => {
    const set = new Set(e.participants)
    if (on) set.add(id)
    else set.delete(id)
    // 依成員順序存
    onChange({ participants: members.filter((m) => set.has(m.id)).map((m) => m.id) })
  }
  const allOn = members.every((m) => e.participants.includes(m.id))

  return (
    <li className={`sb-expense${open ? ' open' : ''}${result.ok ? '' : ' bad'}`}>
      <button type="button" className="sb-summary" onClick={onToggle} aria-expanded={open}>
        <span className="sb-summary-title">
          <strong>{e.title.trim() || '未命名支出'}</strong>
          <span className="muted">
            {result.ok
              ? `${nameOf(e.payer)} 付，${e.participants.length} 人${MODES.find((m) => m.value === e.mode)!.label}分`
              : result.error}
          </span>
        </span>
        <span className="sb-summary-amt">{amount !== null ? `$${formatUnits(Math.round(amount / unit), unit)}` : '—'}</span>
        <span className="sb-caret" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open && (
        <div className="sb-editor">
          <div className="sb-grid">
            <label>
              項目
              <input type="text" value={e.title} placeholder="例如：晚餐" onChange={(ev) => onChange({ title: ev.target.value })} />
            </label>
            <label>
              金額
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={e.amount}
                placeholder="0"
                onChange={(ev) => onChange({ amount: ev.target.value })}
                aria-invalid={e.amount.trim() !== '' && amount === null}
              />
            </label>
            <label>
              付款人
              <select value={e.payer} onChange={(ev) => onChange({ payer: ev.target.value })}>
                {!members.some((m) => m.id === e.payer) && <option value="">請選擇</option>}
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || '（未命名）'}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="sb-seg" role="radiogroup" aria-label="分攤方式">
            {MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={e.mode === m.value}
                className={e.mode === m.value ? 'active' : undefined}
                onClick={() => onChange({ mode: m.value })}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div className="sb-people-head">
            <span>分攤的人</span>
            <button
              type="button"
              className="link sb-all"
              onClick={() => onChange({ participants: allOn ? [] : members.map((m) => m.id) })}
            >
              {allOn ? '全部取消' : '全選'}
            </button>
          </div>
          <ul className="sb-people">
            {members.map((m) => {
              const on = e.participants.includes(m.id)
              const share = result.ok ? result.shares.get(m.id) : undefined
              return (
                <li key={m.id} className={on ? 'on' : undefined}>
                  <label className="sb-check">
                    <input type="checkbox" checked={on} onChange={(ev) => toggle(m.id, ev.target.checked)} />
                    <span>{m.name || '（未命名）'}</span>
                  </label>
                  {on && e.mode !== 'equal' && (
                    <input
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      className="sb-share"
                      aria-label={`${m.name} 的${e.mode === 'ratio' ? '比例' : '金額'}`}
                      placeholder={e.mode === 'ratio' ? '1' : '平分剩下'}
                      value={e.shares[m.id] ?? ''}
                      onChange={(ev) => onChange({ shares: { ...e.shares, [m.id]: ev.target.value } })}
                    />
                  )}
                  <span className="sb-share-val">{on && share !== undefined ? `$${formatUnits(share, unit)}` : ''}</span>
                </li>
              )
            })}
          </ul>
          {e.mode === 'ratio' && <p className="muted sb-note">比例沒填當作 1，例如大人填 2、小孩填 1。</p>}
          {e.mode === 'amount' && <p className="muted sb-note">沒填金額的人平分剩下的部分。</p>}
          {!result.ok && <p className="error">{result.error}</p>}

          <div className="sb-actions">
            <button type="button" className="secondary" onClick={onToggle}>
              完成
            </button>
            <button type="button" className="danger" onClick={onRemove}>
              刪除這筆
            </button>
          </div>
        </div>
      )}
    </li>
  )
}
