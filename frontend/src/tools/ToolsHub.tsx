import { Link } from 'react-router'
import { TOOLS } from './registry'
import './tools.css'

export default function ToolsHub() {
  return (
    <>
      <h1>小工具</h1>
      <ul className="tools-grid">
        {TOOLS.map((tool) => (
          <li key={tool.id}>
            <Link to={`/tools/${tool.id}`} className="tool-card">
              <span className="tool-card-icon" aria-hidden="true">
                {tool.icon}
              </span>
              <span className="tool-card-body">
                <strong>{tool.name}</strong>
                <span className="muted">{tool.blurb}</span>
                <span className="tool-card-tags">
                  {tool.tags.map((tag) => (
                    <span key={tag} className="chip subtle">
                      {tag}
                    </span>
                  ))}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  )
}
