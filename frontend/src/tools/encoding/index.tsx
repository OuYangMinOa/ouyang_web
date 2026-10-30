import { useState } from 'react'
import AllFormats from './AllFormats'
import { DEFAULT_OPTIONS, findCodec, type CodecOptions } from './codecs'
import ConvertPanel, { type Direction } from './ConvertPanel'
import HashPanel from './HashPanel'
import NumberPanel from './NumberPanel'
import { Segmented } from './ui'
import { load, save } from './util'
import './encoding.css'

type Tab = 'convert' | 'all' | 'number' | 'hash'

const TABS: { value: Tab; label: string }[] = [
  { value: 'convert', label: '編碼轉換' },
  { value: 'all', label: '全部格式' },
  { value: 'number', label: '進位換算' },
  { value: 'hash', label: '雜湊' },
]

function loadTab(): Tab {
  const t = load<string>('tab', 'convert')
  return TABS.some((x) => x.value === t) ? (t as Tab) : 'convert'
}

/** 存檔的選項可能是舊版或被改壞，型別或值不對的就用預設值 */
function loadOptions(): CodecOptions {
  const saved = load<Record<string, unknown>>('options', {})
  const out: CodecOptions = { ...DEFAULT_OPTIONS }
  const valid: Partial<Record<keyof CodecOptions, unknown[]>> = { hexSep: ['', ' ', ':'], urlMode: ['component', 'uri', 'form'] }
  for (const k of Object.keys(DEFAULT_OPTIONS) as (keyof CodecOptions)[]) {
    const v = saved?.[k]
    const ok = valid[k] ? valid[k].includes(v) : typeof v === typeof DEFAULT_OPTIONS[k]
    if (ok) Object.assign(out, { [k]: v })
  }
  return out
}

export default function EncodingTool() {
  const [tab, setTab] = useState(loadTab)
  // 編碼轉換和全部格式共用同一段輸入
  const [text, setText] = useState('')
  const [codecId, setCodecId] = useState(() => findCodec(load('codec', 'base64')).id)
  const [dir, setDir] = useState<Direction>(() => (load<string>('dir', 'encode') === 'decode' ? 'decode' : 'encode'))
  const [options, setOptions] = useState(loadOptions)

  // 換分頁、格式、方向和選項都記下來，下次打開還是一樣
  const remember =
    <T,>(key: string, set: (v: T) => void) =>
    (v: T) => {
      set(v)
      save(key, v)
    }

  return (
    <div className="enc">
      <Segmented className="enc-tabs" value={tab} options={TABS} onChange={remember('tab', setTab)} />

      {tab === 'convert' && (
        <ConvertPanel
          text={text}
          onText={setText}
          codecId={codecId}
          onCodec={remember('codec', setCodecId)}
          dir={dir}
          onDir={remember('dir', setDir)}
          options={options}
          onOptions={remember('options', setOptions)}
        />
      )}
      {tab === 'all' && <AllFormats text={text} onText={setText} options={options} onOptions={remember('options', setOptions)} />}
      {tab === 'number' && <NumberPanel />}
      {/* 雜湊會載入 wasm，切到這頁才掛上去 */}
      {tab === 'hash' && <HashPanel />}
    </div>
  )
}
