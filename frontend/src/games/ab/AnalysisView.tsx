import type { StepAnalysis, Summary, Verdict } from './logic'

const VERDICT: Record<Verdict, { label: string; tone: string }> = {
  first: { label: '第一步', tone: '' },
  best: { label: '最佳', tone: 'ok' },
  good: { label: '不錯', tone: 'ok' },
  fair: { label: '可以更好', tone: 'warn' },
  probe: { label: '好的探測', tone: 'ok' },
  wasted: { label: '浪費一步', tone: 'danger' },
}

export function AnalysisView({ steps, summary }: { steps: StepAnalysis[]; summary: Summary }) {
  return (
    <section className="ab-analysis" aria-label="賽後分析">
      <div className="card ab-summary">
        <h3>賽後分析</h3>
        <p className="ab-stars" aria-label={`評等 ${summary.stars} 顆星（滿分 5）`}>
          {'★'.repeat(summary.stars)}
          <span className="ab-stars-off">{'★'.repeat(5 - summary.stars)}</span>
        </p>
        <dl className="ab-stats">
          <div>
            <dt>總次數</dt>
            <dd>{summary.total}</dd>
          </div>
          <div>
            <dt>池外猜測</dt>
            <dd>{summary.outOfPool.length}</dd>
          </div>
          <div>
            <dt>浪費步數</dt>
            <dd>{summary.wasted.length}</dd>
          </div>
          <div>
            <dt>好的探測</dt>
            <dd>{summary.probes.length}</dd>
          </div>
        </dl>
        <ul className="ab-tips">
          {summary.tips.map((tip) => (
            <li key={tip}>{tip}</li>
          ))}
        </ul>
        <p className="muted">
          「池」是當下仍符合所有提示的組合；「期望剩餘」是猜完後平均還剩幾種可能（猜中算 0），越小越好。
        </p>
      </div>

      <ol className="ab-steps">
        {steps.map((s) => (
          <StepCard key={s.step} s={s} />
        ))}
      </ol>
    </section>
  )
}

function StepCard({ s }: { s: StepAnalysis }) {
  const v = VERDICT[s.verdict]
  const won = s.result === '4A0B'
  return (
    <li className="ab-step">
      <div className="ab-step-head">
        <span className="ab-step-no">第 {s.step} 次</span>
        <strong className="ab-code">{s.guess}</strong>
        <span>→ {s.result}</span>
        <span className={`ab-tag ${v.tone}`}>{v.label}</span>
      </div>
      <p className="ab-step-line">
        池 {s.before} → {won ? '猜中' : s.after}
        {' · '}
        {s.inPool ? (
          <span className="ab-in">在池中（可能是答案）</span>
        ) : (
          <span className="ab-out">不在池中（不可能是答案）</span>
        )}
      </p>

      {s.violations.map((x) => (
        <p key={x.step} className="ab-step-line ab-violation">
          如果答案是 {s.guess}，第 {x.step} 次猜 {x.guess} 應該得到 {x.expected}，但實際是 {x.actual}。
        </p>
      ))}
      {!s.inPool && s.excluded.length > 0 && (
        <p className="ab-step-line muted">其中 {s.excluded.join('、')} 當時已確定不在答案裡。</p>
      )}

      {s.verdict === 'first' ? (
        <p className="ab-step-line muted">第一次猜什麼都一樣（每組數字的地位對稱），不評分。</p>
      ) : (
        s.best &&
        s.bestIn && (
          <p className="ab-step-line muted">
            這步期望剩 <b>{s.mine}</b> 種（最壞 {s.worst}）。
            {s.best.guess === s.bestIn.guess || s.best.expected === s.bestIn.expected ? (
              <>
                當時最佳是猜 <span className="ab-code">{s.bestIn.guess}</span>，期望剩 {s.bestIn.expected} 種（最壞{' '}
                {s.bestIn.worst}）。
              </>
            ) : (
              <>
                全部 5040 組中最佳是 <span className="ab-code">{s.best.guess}</span>（池外探測），期望剩{' '}
                {s.best.expected}；池內最佳是 <span className="ab-code">{s.bestIn.guess}</span>，期望剩{' '}
                {s.bestIn.expected}。
              </>
            )}
            {s.verdict === 'probe' && ' 雖然不可能猜中，但切分效果不輸池內的任何猜測。'}
          </p>
        )
      )}
    </li>
  )
}
