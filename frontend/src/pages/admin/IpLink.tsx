/** 點 IP 到 ipinfo.io 查來源；本機開發沒有 X-Forwarded-For，IP 會是 local */
export function IpLink({ ip }: { ip: string }) {
  if (ip === 'local') return <code>{ip}</code>
  return (
    <a href={`https://ipinfo.io/${encodeURIComponent(ip)}`} target="_blank" rel="noreferrer" title="在 ipinfo.io 查詢">
      <code>{ip}</code>
    </a>
  )
}
