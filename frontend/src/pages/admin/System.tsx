import { Fragment, useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../../api'
import { usePolling } from '../../feedback/util'
import LineChart from './LineChart'
import type { MonitorGroup, MonitorHistory, MonitorPoint, MonitorSnapshot, MonitorStatus, MonitorTarget } from './types'

const REFRESH_MS = 5000
/** 24 小時的圖每分鐘才多一點 */
const DAY_REFRESH_MS = 60_000
const RECENT_POINTS = 720

const RANGES = [
  { id: '1h', label: '1 小時' },
  { id: '24h', label: '24 小時' },
] as const

type Range = (typeof RANGES)[number]['id']

const KIND_LABELS: Record<MonitorGroup['kind'], string> = {
  service: 'systemd',
  container: 'Docker',
  session: '工作階段',
  self: '這個網站',
  other: '其他',
}

function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

const formatRate = (bps: number) => `${formatBytes(bps)}/s`
const formatPercent = (value: number) => `${value < 10 && value > 0 ? value.toFixed(1) : Math.round(value)}%`

function duration(secs: number) {
  const minutes = Math.floor(secs / 60)
  if (minutes < 1) return `${Math.max(0, Math.floor(secs))} 秒`
  if (minutes < 60) return `${minutes} 分`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小時 ${minutes % 60} 分`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小時`
}

/** 指令列的第一段只留檔名，例如 `/usr/bin/python3 main.py` → `python3 main.py` */
function shortCmd(cmd: string) {
  const [exe, ...rest] = cmd.split(' ')
  return [exe.split('/').pop(), ...rest].join(' ')
}

function groupTitle(group: MonitorGroup) {
  if (group.kind === 'self') return '這個網站（目前的容器）'
  if (group.kind === 'service') return group.name
  return shortCmd(group.processes[0]?.cmd ?? group.name)
}

/** 「加入監控」預先填的關鍵字：systemd 用服務名稱；容器 id 每次部署都會換，所以用指令列 */
function suggestPattern(group: MonitorGroup) {
  if (group.kind === 'service') return `${group.name}.service`
  return (group.processes[0]?.cmd ?? group.name).slice(0, 100)
}

/** 從目前的快照接一點到 1 小時的圖後面，不用每 5 秒重抓整段歷史 */
function pointFrom(status: MonitorStatus): MonitorPoint | null {
  const s = status.snapshot
  if (!s?.cpu) return null
  return {
    t: s.sampled_at,
    cpu: s.cpu.busy,
    mem_used: s.memory.total - s.memory.available,
    rx_bps: s.net?.rx_bps ?? 0,
    tx_bps: s.net?.tx_bps ?? 0,
    read_bps: s.disk_io?.read_bps ?? 0,
    write_bps: s.disk_io?.write_bps ?? 0,
    targets: status.targets.map((t) => ({
      id: t.id,
      cpu: t.cpu,
      rss: t.rss,
      processes: t.processes,
    })),
  }
}

function Meter({ percent }: { percent: number }) {
  return (
    <div className="sys-meter" aria-hidden="true">
      <div className={percent >= 90 ? 'is-high' : undefined} style={{ width: `${Math.min(100, percent)}%` }} />
    </div>
  )
}

function Tiles({ snapshot }: { snapshot: MonitorSnapshot }) {
  const { cpu, memory, disk } = snapshot
  const memUsed = memory.total - memory.available
  const memPercent = memory.total ? (memUsed / memory.total) * 100 : 0
  const diskPercent = disk ? (disk.used / (disk.used + disk.available)) * 100 : 0
  const swapUsed = memory.swap_total - memory.swap_free

  return (
    <div className="sys-tiles">
      <div className="card sys-tile">
        <span className="muted">CPU</span>
        <strong>{cpu ? formatPercent(cpu.busy) : '—'}</strong>
        <Meter percent={cpu?.busy ?? 0} />
        <small className="muted">
          {cpu ? `iowait ${formatPercent(cpu.iowait)} · steal ${formatPercent(cpu.steal)}` : '取樣中…'}
        </small>
      </div>
      <div className="card sys-tile">
        <span className="muted">記憶體</span>
        <strong>{formatPercent(memPercent)}</strong>
        <Meter percent={memPercent} />
        <small className="muted">
          {formatBytes(memUsed)} / {formatBytes(memory.total)}
          {memory.swap_total > 0 && ` · swap ${formatBytes(swapUsed)}`}
        </small>
      </div>
      <div className="card sys-tile">
        <span className="muted">磁碟</span>
        <strong>{disk ? formatPercent(diskPercent) : '—'}</strong>
        <Meter percent={diskPercent} />
        <small className="muted">
          {disk
            ? `剩 ${formatBytes(disk.available)} / ${formatBytes(disk.total)} · 資料庫 ${formatBytes(disk.data_bytes)}`
            : '讀不到'}
        </small>
      </div>
      <div className="card sys-tile">
        <span className="muted">負載（1 / 5 / 15 分）</span>
        <strong>{snapshot.load[0].toFixed(2)}</strong>
        <Meter percent={(snapshot.load[0] / snapshot.cpus) * 100} />
        <small className="muted">
          {snapshot.load[1].toFixed(2)} · {snapshot.load[2].toFixed(2)} · {snapshot.cpus} 核
        </small>
      </div>
    </div>
  )
}

function Charts({
  points,
  memTotal,
  range,
  onRange,
}: {
  points: MonitorPoint[]
  memTotal: number
  range: Range
  onRange: (r: Range) => void
}) {
  const times = points.map((p) => p.t)
  const charts = [
    {
      title: 'CPU',
      max: 100,
      format: formatPercent,
      series: [{ label: 'CPU', tone: 1 as const, values: points.map((p) => p.cpu) }],
    },
    {
      title: '記憶體',
      max: memTotal || undefined,
      format: formatBytes,
      series: [
        {
          label: '已使用',
          tone: 1 as const,
          values: points.map((p) => p.mem_used),
        },
      ],
    },
    {
      title: '網路',
      format: formatRate,
      series: [
        {
          label: '下載',
          tone: 1 as const,
          values: points.map((p) => p.rx_bps),
        },
        {
          label: '上傳',
          tone: 2 as const,
          values: points.map((p) => p.tx_bps),
        },
      ],
    },
    {
      title: '磁碟讀寫',
      format: formatRate,
      series: [
        {
          label: '讀',
          tone: 1 as const,
          values: points.map((p) => p.read_bps),
        },
        {
          label: '寫',
          tone: 2 as const,
          values: points.map((p) => p.write_bps),
        },
      ],
    },
  ]

  return (
    <section>
      <div className="sys-section-head">
        <h2>趨勢</h2>
        <div className="access-tabs">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              className={range === r.id ? undefined : 'secondary'}
              aria-pressed={range === r.id}
              onClick={() => onRange(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="sys-charts">
        {charts.map((chart) => (
          <div key={chart.title} className="card sys-chart">
            <header>
              <h3>{chart.title}</h3>
              {chart.series.length > 1 && (
                <span className="sys-legend">
                  {chart.series.map((s) => (
                    <span key={s.label}>
                      <i className={`sys-swatch is-${s.tone}`} />
                      {s.label}
                    </span>
                  ))}
                </span>
              )}
            </header>
            <LineChart times={times} series={chart.series} format={chart.format} max={chart.max} label={chart.title} />
          </div>
        ))}
      </div>
    </section>
  )
}

function TargetCard({
  target,
  points,
  now,
  onDelete,
}: {
  target: MonitorTarget
  points: MonitorPoint[]
  now: number
  onDelete: () => void
}) {
  const up = target.processes > 0
  const history = points.map((p) => ({ t: p.t, v: p.targets.find((x) => x.id === target.id) })).filter((p) => p.v)
  // 這段時間裡有沒有停過
  const downs = history.filter((p) => p.v!.processes < 0.5).length

  return (
    <article className={up ? 'card sys-target' : 'card sys-target is-down'}>
      <header>
        <span className={up ? 'live-dot is-online' : 'live-dot'} />
        <strong>{target.label}</strong>
        <span className={up ? 'badge ok' : 'badge bad'}>{up ? '運作中' : '沒在跑'}</span>
        <button
          type="button"
          className="link sys-remove"
          onClick={onDelete}
          aria-label={`從監控清單移除 ${target.label}`}
        >
          移除
        </button>
      </header>
      <p className="muted sys-pattern">
        關鍵字 <code>{target.pattern}</code>
      </p>
      {up ? (
        <p className="sys-target-stats">
          <span>
            CPU <strong>{formatPercent(target.cpu)}</strong>
          </span>
          <span>
            記憶體 <strong>{formatBytes(target.rss)}</strong>
          </span>
          <span>
            行程 <strong>{target.processes}</strong>
          </span>
          {target.started_at !== null && (
            <span>
              已運作 <strong>{duration(now / 1000 - target.started_at)}</strong>
            </span>
          )}
        </p>
      ) : (
        <p className="error">找不到符合的行程</p>
      )}
      {history.length > 1 && (
        <>
          <LineChart
            compact
            label={`${target.label} 的記憶體`}
            times={history.map((p) => p.t)}
            series={[
              {
                label: '記憶體',
                tone: 1,
                values: history.map((p) => p.v!.rss),
              },
            ]}
            format={formatBytes}
          />
          {downs > 0 && <p className="error sys-downs">這段時間有 {downs} 個取樣點沒在跑</p>}
        </>
      )}
    </article>
  )
}

function TargetForm({ draft, onDraft, onAdded }: { draft: Draft; onDraft: (d: Draft) => void; onAdded: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api('/admin/system/targets', {
        method: 'POST',
        body: JSON.stringify(draft),
      })
      onDraft({ label: '', pattern: '' })
      setError(null)
      onAdded()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card sys-form" onSubmit={submit} id="sys-target-form">
      <input
        value={draft.label}
        onChange={(e) => onDraft({ ...draft, label: e.target.value })}
        placeholder="名稱，例如：歐陽小俠"
        aria-label="名稱"
        maxLength={40}
        required
      />
      <input
        value={draft.pattern}
        onChange={(e) => onDraft({ ...draft, pattern: e.target.value })}
        placeholder="關鍵字：服務名稱或指令列的一部分"
        aria-label="關鍵字"
        maxLength={100}
        required
      />
      <button type="submit" disabled={busy}>
        加入監控
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  )
}

type Draft = { label: string; pattern: string }

function GroupTable({
  groups,
  now,
  onWatch,
}: {
  groups: MonitorGroup[]
  now: number
  onWatch: (g: MonitorGroup) => void
}) {
  const [open, setOpen] = useState<string | null>(null)

  return (
    <div className="table-wrap">
      <table className="responsive">
        <thead>
          <tr>
            <th>服務</th>
            <th>類型</th>
            <th>CPU</th>
            <th>記憶體</th>
            <th>行程</th>
            <th>已運作</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.cgroup}>
              <tr>
                <td data-label="服務" className="primary sys-group-name" title={g.cgroup}>
                  <span>{groupTitle(g)}</span>
                  {g.kind !== 'service' && g.name && <code className="muted">{g.name}</code>}
                </td>
                <td data-label="類型">
                  <span className="chip subtle">{KIND_LABELS[g.kind]}</span>
                </td>
                <td data-label="CPU">{formatPercent(g.cpu)}</td>
                <td data-label="記憶體">{formatBytes(g.rss)}</td>
                <td data-label="行程">{g.processes.length}</td>
                <td data-label="已運作">{duration(now / 1000 - g.started_at)}</td>
                <td className="actions">
                  <button
                    type="button"
                    className="secondary"
                    aria-expanded={open === g.cgroup}
                    onClick={() => setOpen(open === g.cgroup ? null : g.cgroup)}
                  >
                    {open === g.cgroup ? '收起' : '行程'}
                  </button>
                  {g.kind !== 'self' && (
                    <button type="button" className="secondary" onClick={() => onWatch(g)}>
                      監控
                    </button>
                  )}
                </td>
              </tr>
              {open === g.cgroup && (
                <tr className="visit-open">
                  <td colSpan={7}>
                    <ol className="visit-events sys-procs">
                      {g.processes.map((p) => (
                        <li key={p.pid}>
                          <code>{p.pid}</code>
                          <span className="visit-detail" title={p.cmd}>
                            {p.cmd}
                          </span>
                          <span className="muted">
                            {formatPercent(p.cpu)} · {formatBytes(p.rss)} · {p.threads} 執行緒 ·{' '}
                            {duration(now / 1000 - p.started_at)}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function AdminSystem() {
  const [status, setStatus] = useState<MonitorStatus | null>(null)
  const [points, setPoints] = useState<MonitorPoint[]>([])
  const [range, setRange] = useState<Range>('1h')
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>({ label: '', pattern: '' })
  const [filter, setFilter] = useState('')

  const loadHistory = useCallback(() => {
    api<MonitorHistory>(`/admin/system/history?range=${range}`)
      .then((h) => setPoints(h.points))
      .catch((e) => setError(errorMessage(e)))
  }, [range])

  const load = useCallback(() => {
    api<MonitorStatus>('/admin/system')
      .then((s) => {
        setStatus(s)
        setError(null)
        const point = pointFrom(s)
        if (range === '1h' && point) {
          setPoints((prev) =>
            prev.length && prev[prev.length - 1].t >= point.t ? prev : [...prev, point].slice(-RECENT_POINTS),
          )
        }
      })
      .catch((e) => setError(errorMessage(e)))
  }, [range])

  useEffect(load, [load])
  useEffect(loadHistory, [loadHistory])
  usePolling(load, REFRESH_MS)
  usePolling(() => range === '24h' && loadHistory(), DAY_REFRESH_MS)

  const remove = async (target: MonitorTarget) => {
    if (!confirm(`從監控清單移除「${target.label}」？`)) return
    try {
      await api(`/admin/system/targets/${target.id}`, { method: 'DELETE' })
      load()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const watch = (group: MonitorGroup) => {
    setDraft({
      label: groupTitle(group).slice(0, 40),
      pattern: suggestPattern(group),
    })
    document.getElementById('sys-target-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const snapshot = status?.snapshot
  // 「已運作」以取樣的時間算，沒有快照時用不到
  const now = snapshot?.sampled_at ?? 0
  const keyword = filter.trim().toLowerCase()
  const groups = (snapshot?.groups ?? []).filter(
    (g) =>
      !keyword ||
      g.cgroup.toLowerCase().includes(keyword) ||
      g.processes.some((p) => p.cmd.toLowerCase().includes(keyword)),
  )

  return (
    <>
      <h1>主機監控</h1>
      <p className="muted">
        整台主機的 CPU、記憶體、磁碟和網路，以及上面每個服務（systemd、Docker 容器）用了多少，每 5 秒更新一次。 CPU
        一律是佔整台主機的比例。歷史只放在記憶體，網站重啟或換版後重新累積。
      </p>
      {snapshot && (
        <p className="muted sys-host">
          {[snapshot.cpu_model, snapshot.kernel && `Linux ${snapshot.kernel}`, `開機 ${duration(snapshot.uptime_secs)}`]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}

      {error && <p className="error">{error}</p>}
      {status && !snapshot && <p className="error">{status.error ?? '還沒取樣，等幾秒再看。'}</p>}

      {snapshot && (
        <>
          <Tiles snapshot={snapshot} />
          <Charts points={points} memTotal={snapshot.memory.total} range={range} onRange={setRange} />
        </>
      )}

      {status && (
        <section>
          <div className="sys-section-head">
            <h2>監控清單</h2>
          </div>
          <p className="muted">
            Discord bot 之類想盯著的服務。服務名稱或指令列含有關鍵字（不分大小寫）的行程都算，一個都沒有就是沒在跑。
            也可以在下面的服務列表按「監控」。
          </p>
          {status.targets.length > 0 && (
            <div className="sys-targets">
              {status.targets.map((t) => (
                <TargetCard key={t.id} target={t} points={points} now={now} onDelete={() => remove(t)} />
              ))}
            </div>
          )}
          <TargetForm draft={draft} onDraft={setDraft} onAdded={load} />
        </section>
      )}

      {snapshot && (
        <section>
          <div className="sys-section-head">
            <h2>所有服務</h2>
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="篩選名稱或指令"
              aria-label="篩選服務"
            />
          </div>
          {groups.length ? (
            <GroupTable groups={groups} now={now} onWatch={watch} />
          ) : (
            <p className="muted">沒有符合的服務。</p>
          )}
        </section>
      )}
    </>
  )
}
