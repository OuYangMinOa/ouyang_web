import { useState } from 'react'
import Generate from './Generate'
import Scan from './Scan'
import { Segmented } from './ui'
import './qrcode.css'

type Tab = 'make' | 'scan'

export default function QrCode() {
  const [tab, setTab] = useState<Tab>('make')
  return (
    <div className="qr">
      <Segmented<Tab>
        className="qr-tabs"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'make', label: '產生' },
          { value: 'scan', label: '掃描' },
        ]}
      />
      {/* 兩邊各自保留輸入的內容，切換分頁不會清掉 */}
      <div hidden={tab !== 'make'}>
        <Generate />
      </div>
      {tab === 'scan' && <Scan />}

      <section className="qr-notes">
        <h2>說明</h2>
        <ul className="muted">
          <li>產生和掃描都在瀏覽器裡處理，內容（包括 Wi-Fi 密碼）不會送到伺服器。</li>
          <li>
            Wi-Fi QR Code 用手機相機掃描就能直接連線；聯絡人用 vCard 3.0 格式，掃描後可以加入通訊錄。中文用 UTF-8
            編碼，新的手機都讀得懂。
          </li>
          <li>容錯等級越高，越能容忍髒污或中間放 Logo，但同樣的內容格子會變多、變密。印出來的話建議至少 2 公分寬。</li>
          <li>
            掃描在支援 BarcodeDetector 的瀏覽器（Android Chrome 等）直接辨識相機畫面，其他瀏覽器（iPhone、Firefox）用
            ZXing 解碼。相機只在 HTTPS 網站能用。
          </li>
        </ul>
      </section>
    </div>
  )
}
