import { isValidElement, memo, useState, type ComponentProps, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { Link } from 'react-router'
import remarkGfm from 'remark-gfm'
import { copyToClipboard } from '../../clipboard'

/** 程式碼區塊右上角的「複製」 */
function CodeBlock({ children, ...props }: ComponentProps<'pre'>) {
  const [copied, setCopied] = useState(false)
  // children 是 <code>，裡面的文字才是要複製的
  const text = extractText(children)

  async function copy() {
    await copyToClipboard(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  // <code className="language-python">：標題列顯示是什麼語言
  const className = isValidElement(children) ? (children.props as { className?: string }).className : undefined
  const language = /language-([\w+#-]+)/.exec(className ?? '')?.[1] ?? ''

  return (
    <div className="md-code">
      <div className="md-code-head">
        <span>{language}</span>
        <button type="button" className="md-copy" onClick={copy}>
          {copied ? '已複製' : '複製'}
        </button>
      </div>
      <pre {...props}>{children}</pre>
    </div>
  )
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    return extractText((node.props as { children?: ReactNode }).children)
  }
  return ''
}

/** 站內的路徑用前端路由切換，外部連結開新分頁 */
function MdLink({ href = '', children }: ComponentProps<'a'>) {
  if (href.startsWith('/') && !href.startsWith('//')) return <Link to={href}>{children}</Link>
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  )
}

const components: Components = {
  pre: CodeBlock,
  a: MdLink,
  // 寬的表格在自己的框裡左右捲，不要把整頁撐開
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
  // AI 給的圖片網址不直接載入（可能是追蹤用的），改成連結
  img: ({ src, alt }) => (
    <MdLink href={typeof src === 'string' ? src : ''}>{alt || '圖片'}</MdLink>
  ),
}

/**
 * AI 回答的 Markdown。react-markdown 預設不會執行原始 HTML，AI 輸出什麼都只會被當成文字或 Markdown。
 * memo：串流時只有最後一段在變，前面的段落不用重新解析
 */
export default memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
