import { Suspense } from 'react'
import { Link, useParams } from 'react-router'
import { findTool } from './registry'
import './tools.css'

export default function ToolPage() {
  const { id } = useParams()
  const tool = findTool(id)

  if (!tool) {
    return (
      <>
        <p className="muted">找不到這個工具。</p>
        <Link to="/tools">← 回到小工具</Link>
      </>
    )
  }

  const Tool = tool.component
  return (
    <>
      <div className="tool-title">
        <Link to="/tools" className="tool-back" aria-label="回到小工具">
          ←
        </Link>
        <h1>
          <span aria-hidden="true">{tool.icon}</span> {tool.name}
        </h1>
      </div>
      <Suspense fallback={<p className="muted">載入中…</p>}>
        {/* key：從一個工具切到另一個時整個重來，不沿用狀態 */}
        <Tool key={tool.id} />
      </Suspense>
    </>
  )
}
