import { useCallback, useRef, useState } from 'react'
import { context2d, decodeImage } from '../image-kit/files'
import { useFileDrop, useFilePicker, usePasteImages } from '../image-kit/hooks'
import { DropVeil, DropZone } from '../image-kit/ImageDrop'
import Editor, { type Source } from './Editor'
import { useMatting } from './useMatting'
import './id-photo.css'

/** 編輯解析度的最長邊：300 DPI 的證件照只要幾百像素，2048 綽綽有餘，去背模型也比較快 */
const MAX_EDIT = 2048

export default function IdPhoto() {
  const [source, setSource] = useState<Source | null>(null)
  const [loadError, setLoadError] = useState('')
  const matting = useMatting()
  const nextId = useRef(0)
  const { run, cancel } = matting

  const openFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return
      setLoadError('')
      let bitmap: ImageBitmap
      try {
        bitmap = await decodeImage(file)
      } catch (err) {
        setLoadError((err as Error).message)
        return
      }
      const s = Math.min(1, MAX_EDIT / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * s))
      canvas.height = Math.max(1, Math.round(bitmap.height * s))
      try {
        const ctx = context2d(canvas, true)
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
        const id = ++nextId.current
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
        setSource({ id, name: file.name, canvas, pixels })
        void run(id, pixels)
      } catch (err) {
        setLoadError((err as Error).message)
      } finally {
        bitmap.close()
      }
    },
    [run],
  )

  const startOver = () => {
    cancel()
    setSource(null)
  }

  const picker = useFilePicker((files) => void openFile(files[0]))
  usePasteImages((files) => void openFile(files[0]))
  const { dragging, handlers } = useFileDrop(
    (files) => void openFile(files[0]),
    () => setLoadError('請放入圖片檔。'),
  )

  return (
    <div className="ik idp" {...handlers}>
      {picker.input}
      {source ? (
        <>
          <Editor key={source.id} source={source} matting={matting} onRetry={() => void run(source.id, source.pixels)} onNew={startOver} onPick={picker.open} />
          {loadError && <p className="error">{loadError}</p>}
          {dragging && <DropVeil text="放開就換成這張照片" />}
        </>
      ) : (
        <DropZone dragging={dragging} onPick={picker.open} icon="🪪" title="把照片拖到這裡" dropTitle="放開就開始製作" button="選擇照片">
          {loadError && <p className="error">{loadError}</p>}
        </DropZone>
      )}

      <section className="ik-notes">
        <h2>說明</h2>
        <ul className="muted">
          <li>
            選一張正面、光線均勻的照片，AI 會自動去背並換成你選的背景色，再依頭頂位置大致對齊；之後用拖曳、滾輪或兩指縮放微調，讓頭頂落在上方色帶、下巴落在下方色帶。
          </li>
          <li>
            去背模型跟「圖片去背」共用（ISNet，第一次使用要下載 46–88 MB，之後留在瀏覽器快取）。髮絲邊緣若殘留原本背景的顏色，可以在「去背微調」調整強度與邊緣。
          </li>
          <li>
            單張與排版圖都是 300 DPI 的 JPG，檔案裡標好解析度，拿到超商或相片沖印店選「原尺寸」列印，印出來就是正確大小。排版圖每張外圍有淺灰色的裁切線。
          </li>
          <li>
            規格以各機關公告為準：護照與身分證要求近六個月內、正面脫帽、露出眉毛與耳朵、不戴有色眼鏡、表情自然不露齒，背景白色或淺色素色。
          </li>
          <li>全部在瀏覽器本機處理，照片不會送到伺服器。</li>
        </ul>
      </section>
    </div>
  )
}
