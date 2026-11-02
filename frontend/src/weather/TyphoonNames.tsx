import { useState } from 'react'
import { Link } from 'react-router'
import { useRemote, type TyphoonNameTable, type TyphoonReport } from './data'
import './weather.css'

const GROUPS = [1, 2, 3, 4, 5]

/** 各家拼法不一樣（IN-FA、In-fa），比對時只看英數字 */
function nameKey(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export default function TyphoonNames() {
  const { data, error } = useRemote<TyphoonNameTable>('/weather/typhoon-names', 24 * 60 * 60 * 1000)
  const { data: typhoons } = useRemote<TyphoonReport>('/weather/typhoons', 10 * 60 * 1000)
  const [query, setQuery] = useState('')

  const active = new Set((typhoons?.storms ?? []).flatMap((s) => (s.name_en ? [nameKey(s.name_en)] : [])))
  const q = query.trim().toLowerCase()
  const matches = (zh: string, en: string) => q === '' || zh.includes(q) || en.toLowerCase().includes(q)
  const rows = (data?.rows ?? []).filter((row) => row.member.includes(q) || row.names.some((n) => matches(n.zh, n.en)))
  const [year, month] = (data?.updated ?? '').split('-')

  return (
    <div className="weather-page">
      <div className="weather-head">
        <h1>颱風名稱表</h1>
        <Link className="work-link" to="/weather/typhoon">
          ← 回颱風路徑
        </Link>
      </div>
      <p className="muted weather-lead">
        {'西北太平洋和南海的颱風由颱風委員會的 14 個成員各提供 10 個名字，共 140 個，分成 5 組。'}
        {'從第 1 組第一個（丹瑞）開始，每組由上往下依序使用，用完一組換下一組，第 5 組用完再回到第 1 組。'}
        {'造成重大災害的名字會被除名，換上新名字。'}
      </p>

      {error && !data && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">載入中…</p>}

      {data && (
        <>
          <div className="name-search">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜尋中文、英文名稱或提供的國家"
              aria-label="搜尋颱風名稱"
            />
          </div>

          {rows.length === 0 ? (
            <p className="muted">找不到「{query}」。</p>
          ) : (
            <div className="table-wrap">
              <table className="responsive name-table">
                <caption className="sr-only">颱風中文譯名及國際命名對照表</caption>
                <thead>
                  <tr>
                    <th>提供成員</th>
                    {GROUPS.map((g) => (
                      <th key={g}>第 {g} 組</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={`${row.member}-${i}`}>
                      <td data-label="提供成員" className="primary">
                        {row.member}
                      </td>
                      {row.names.map((name, g) => {
                        const isActive = active.has(nameKey(name.en))
                        const hit = q !== '' && matches(name.zh, name.en)
                        return (
                          <td
                            key={name.en}
                            data-label={`第 ${g + 1} 組`}
                            className={`${isActive ? 'name-active' : ''} ${hit ? 'name-hit' : ''}`}
                          >
                            <span className="name-zh">{name.zh}</span>
                            <span className="name-en">{name.en}</span>
                            {isActive && <span className="chip subtle">活動中</span>}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="muted fineprint">
            資料來源：中央氣象署〈颱風中文譯名及國際命名對照表〉（{year} 年 {Number(month)}{' '}
            月更新）。「活動中」是目前正在活動的颱風。
          </p>
        </>
      )}
    </div>
  )
}
