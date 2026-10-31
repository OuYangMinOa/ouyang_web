import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from 'react'
import { hexDecode, utf8 } from './codecs'
import { HASH_ALGOS, digestMatches, formatDigest, hashBytes, hashFile, type DigestFormat, type Digests } from './hashes'
import { Check, CopyButton, Segmented } from './ui'
import { formatSize, load, save } from './util'

type Source = 'text' | 'file'

const SOURCES: { value: Source; label: string }[] = [
  { value: 'text', label: '📝 文字' },
  { value: 'file', label: '📄 檔案' },
]
const FORMATS: { value: DigestFormat; label: string }[] = [
  { value: 'hex', label: 'hex' },
  { value: 'HEX', label: 'HEX' },
  { value: 'base64', label: 'Base64' },
]

const LOAD_ERROR = '雜湊模組載入失敗，請檢查網路後重新整理頁面。'

/** HMAC 金鑰：null 代表不用 HMAC */
type Key = { bytes: Uint8Array | null; error?: string }

type FileRun = { file: File; key: Key; done: number; digests: Digests | null; error: string | null }

export default function HashPanel() {
  const id = useId()
  const [source, setSource] = useState<Source>('text')
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [useHmac, setUseHmac] = useState(false)
  const [keyText, setKeyText] = useState('')
  const [keyHex, setKeyHex] = useState(false)
  const [format, setFormat] = useState<DigestFormat>(() => {
    const f = load<string>('hashFormat', 'hex')
    return FORMATS.find((x) => x.value === f)?.value ?? 'hex'
  })
  const [expected, setExpected] = useState('')
  const [textResult, setTextResult] = useState<{ key: Key | null; digests: Digests | null; error: string | null }>({
    key: null,
    digests: null,
    error: null,
  })
  const [run, setRun] = useState<FileRun | null>(null)
  const picker = useRef<HTMLInputElement>(null)

  const key = useMemo<Key>(() => {
    if (!useHmac) return { bytes: null }
    if (!keyHex) return { bytes: utf8(keyText) }
    const r = hexDecode(keyText)
    return r instanceof Uint8Array ? { bytes: r } : { bytes: null, error: r.error.replace('不是有效的十六進位', '金鑰不是有效的十六進位') }
  }, [useHmac, keyText, keyHex])

  // 文字：停手一下再算，避免每個字都重算
  useEffect(() => {
    if (source !== 'text' || key.error) return
    let cancelled = false
    const timer = setTimeout(() => {
      hashBytes(utf8(text), key.bytes).then(
        (digests) => !cancelled && setTextResult({ key, digests, error: null }),
        () => !cancelled && setTextResult({ key, digests: null, error: LOAD_ERROR }),
      )
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [source, text, key])

  // 檔案：分段讀取並回報進度；換檔案、改金鑰或取消時中止
  useEffect(() => {
    if (!file || key.error) return
    const ac = new AbortController()
    const report = (patch: Partial<FileRun>) => {
      if (!ac.signal.aborted) setRun({ file, key, done: 0, digests: null, error: null, ...patch })
    }
    hashFile(file, key.bytes, (done) => report({ done }), ac.signal).then(
      (digests) => digests && report({ done: file.size, digests }),
      () => report({ error: LOAD_ERROR }),
    )
    return () => ac.abort()
  }, [file, key])

  // 舊的計算結果（別的檔案或金鑰）不算數
  const current = run && run.file === file && run.key === key ? run : null
  const hashing = source === 'file' && !!file && !key.error && !current?.digests && !current?.error
  // 文字的結果打字時先沿用舊的，不閃爍；但金鑰換了就不能沿用
  const textDigests = textResult.key === key ? textResult.digests : null
  const digests = key.error ? null : source === 'text' ? textDigests : (current?.digests ?? null)
  const error = key.error ?? (source === 'text' ? textResult.error : (current?.error ?? null))
  const pending = !key.error && !digests && !error

  const algos = useMemo(() => (key.bytes ? HASH_ALGOS.filter((a) => a.hmac) : HASH_ALGOS), [key])
  const matched = useMemo(() => {
    if (!expected.trim() || !digests) return null
    return new Set(algos.filter((a) => digests[a.id] && digestMatches(expected, digests[a.id])).map((a) => a.id))
  }, [algos, digests, expected])
  const matchNames = algos.filter((a) => matched?.has(a.id)).map((a) => a.name)

  function pick(f: File | undefined) {
    if (f) setFile(f)
  }

  function drop(e: DragEvent) {
    e.preventDefault()
    setDragging(false)
    pick(e.dataTransfer.files[0])
  }

  const pct = file && file.size ? Math.floor(((current?.done ?? 0) / file.size) * 100) : 0

  return (
    <div className="enc">
      <Segmented label="來源" value={source} options={SOURCES} onChange={setSource} />

      {source === 'text' ? (
        <div className="enc-field">
          <label htmlFor={`${id}-text`}>要計算雜湊的文字（UTF-8）</label>
          <textarea
            id={`${id}-text`}
            className="enc-textarea"
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="輸入文字…"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
          />
        </div>
      ) : (
        <div
          className={`enc-drop${dragging ? ' over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={(e) => {
            // 移到裡面的按鈕上也會觸發，真的離開才取消
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
          }}
          onDrop={drop}
        >
          <p className="muted">把檔案拖到這裡，或</p>
          <button type="button" onClick={() => picker.current?.click()}>
            選擇檔案
          </button>
          <input
            ref={picker}
            type="file"
            hidden
            onChange={(e) => {
              pick(e.target.files?.[0])
              // 清掉才能重選同一個檔案
              e.target.value = ''
            }}
          />
          {file && (
            <div className="enc-file">
              <span className="enc-file-name">{file.name}</span>
              <span className="muted">{formatSize(file.size)}</span>
            </div>
          )}
          {hashing && (
            <div className="enc-file">
              <div className="enc-progress" role="progressbar" aria-label="計算進度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                <div style={{ width: `${pct}%` }} />
              </div>
              <span className="muted">
                計算中 {pct}%（{formatSize(current?.done ?? 0)} / {formatSize(file.size)}）
              </span>
              <button type="button" className="secondary" onClick={() => setFile(null)}>
                取消
              </button>
            </div>
          )}
        </div>
      )}

      <div className="enc-options">
        <Check checked={useHmac} onChange={setUseHmac}>
          HMAC
        </Check>
        {useHmac && (
          <>
            <input
              className="enc-key"
              value={keyText}
              onChange={(e) => setKeyText(e.target.value)}
              placeholder={keyHex ? '金鑰（十六進位）' : '金鑰'}
              aria-label="HMAC 金鑰"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
            />
            <Check checked={keyHex} onChange={setKeyHex}>
              金鑰是十六進位
            </Check>
          </>
        )}
      </div>
      {useHmac && <p className="muted">BLAKE、CRC 和 xxHash 不是用 HMAC 加金鑰，開啟時先隱藏。</p>}

      <Segmented
        label="輸出格式"
        value={format}
        options={FORMATS}
        onChange={(f) => {
          setFormat(f)
          save('hashFormat', f)
        }}
      />

      <div className="enc-field">
        <label htmlFor={`${id}-cmp`}>比對</label>
        <input
          id={`${id}-cmp`}
          value={expected}
          onChange={(e) => setExpected(e.target.value)}
          placeholder="貼上預期的雜湊值（hex 或 Base64）"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
        />
        {matched && (
          <p className={`enc-msg ${matched.size ? 'success' : 'error'}`} role="status">
            {matched.size ? `✓ 相符：${matchNames.join('、')}` : '✗ 沒有相符的雜湊值'}
          </p>
        )}
      </div>

      {error && (
        <p className="error enc-msg" role="alert">
          {error}
        </p>
      )}

      {source === 'file' && !file ? (
        <p className="muted">選好檔案後，這裡會列出各種雜湊值。</p>
      ) : (
        <ul className="enc-rows">
          {algos.map((a) => {
            const bytes = digests?.[a.id]
            const value = bytes ? formatDigest(bytes, format) : ''
            const hit = matched?.has(a.id)
            return (
              <li key={a.id} className={`enc-row${hit ? ' match' : ''}`}>
                <span className="enc-row-name">
                  {key.bytes ? `HMAC-${a.name}` : a.name}
                  {hit && <span className="enc-hit"> ✓ 相符</span>}
                </span>
                <span className="enc-row-value">{value || <span className="muted">{pending ? '計算中…' : '—'}</span>}</span>
                <CopyButton text={value} />
              </li>
            )
          })}
        </ul>
      )}

      <p className="muted enc-note">全部在瀏覽器裡計算，文字和檔案都不會上傳。</p>
    </div>
  )
}
