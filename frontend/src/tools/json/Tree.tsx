import { useState } from 'react'
import type { JNode } from './parse'

/** 一次最多畫幾個子項目；大陣列再按「顯示更多」 */
const PAGE = 200

/** 點鍵名時的路徑寫法：$.users[0]["first name"] */
function childPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`
}

function Leaf({ node }: { node: JNode }) {
  switch (node.t) {
    case 'string':
      return <span className="jt-str">{JSON.stringify(node.v)}</span>
    case 'number':
      return <span className="jt-num">{node.raw}</span>
    case 'boolean':
      return <span className="jt-bool">{String(node.v)}</span>
    case 'null':
      return <span className="jt-null">null</span>
    default:
      return null
  }
}

type NodeProps = {
  name: string | number | null
  node: JNode
  path: string
  depth: number
  openDepth: number
  selected: string
  onSelect: (path: string) => void
}

function Name({ name, path, selected, onSelect }: Pick<NodeProps, 'name' | 'path' | 'selected' | 'onSelect'>) {
  if (name === null) return null
  return (
    <>
      <button
        type="button"
        className={`jt-key${typeof name === 'number' ? ' index' : ''}${selected === path ? ' selected' : ''}`}
        onClick={(e) => {
          // 在 summary 裡面時不要順便展開／收合
          e.preventDefault()
          onSelect(path)
        }}
        title="點一下顯示路徑"
      >
        {typeof name === 'number' ? name : JSON.stringify(name)}
      </button>
      <span className="jt-colon">: </span>
    </>
  )
}

function TreeNode(props: NodeProps) {
  const { node, path, depth, openDepth } = props
  const [open, setOpen] = useState(depth < openDepth)
  const [limit, setLimit] = useState(PAGE)

  if (node.t !== 'object' && node.t !== 'array') {
    return (
      <li className="jt-leaf">
        <Name {...props} />
        <Leaf node={node} />
      </li>
    )
  }

  const isObj = node.t === 'object'
  const children: [string | number, JNode][] = node.t === 'object' ? node.entries : node.items.map((v, i) => [i, v])
  const size = children.length
  const [l, r] = isObj ? ['{', '}'] : ['[', ']']
  if (!size) {
    return (
      <li className="jt-leaf">
        <Name {...props} />
        <span className="jt-punct">
          {l}
          {r}
        </span>
      </li>
    )
  }

  return (
    <li>
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <Name {...props} />
          <span className="jt-punct">{l}</span>
          <span className="jt-meta">{isObj ? `${size.toLocaleString()} 個鍵` : `${size.toLocaleString()} 項`}</span>
          {!open && <span className="jt-punct">{r}</span>}
        </summary>
        {/* 收合時不畫子節點，大檔案才不會卡 */}
        {open && (
          <>
            <ul className="jt-list">
              {children.slice(0, limit).map(([k, v], i) => (
                // 物件可能有重複的鍵，用位置當 key
                <TreeNode key={i} {...props} name={k} node={v} path={childPath(path, k)} depth={depth + 1} />
              ))}
            </ul>
            {size > limit && (
              <button type="button" className="secondary jt-more" onClick={() => setLimit(limit + PAGE * 5)}>
                再顯示 {Math.min(PAGE * 5, size - limit).toLocaleString()} 項（還有 {(size - limit).toLocaleString()} 項）
              </button>
            )}
            <span className="jt-punct jt-close">{r}</span>
          </>
        )}
      </details>
    </li>
  )
}

export default function Tree({
  node,
  openDepth,
  selected,
  onSelect,
}: {
  node: JNode
  openDepth: number
  selected: string
  onSelect: (path: string) => void
}) {
  return (
    <ul className="jt-list jt-root">
      <TreeNode name={null} node={node} path="$" depth={0} openDepth={openDepth} selected={selected} onSelect={onSelect} />
    </ul>
  )
}
