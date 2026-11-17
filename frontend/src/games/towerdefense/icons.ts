import { Box3, DirectionalLight, Group, HemisphereLight, Mesh, PerspectiveCamera, Scene, Vector3, WebGLRenderer, type BufferGeometry, type Material } from 'three'
import { createContext, useContext } from 'react'
import { TOWER_LOOK } from './models'
import type { Spec } from './online'

/**
 * 介面上的小圖：把塔和怪物真正的 3D 模型各拍一張（透明背景的 PNG），商店、下一波的預告、圖鑑用的都是它，
 * 看到圖就認得出場上是哪一隻，不用另外找表情符號湊。
 *
 * 只在開頁面時拍一次：另外開一個小小的 WebGL 畫面，拍完就關掉。瀏覽器不讓開第二個的話回傳 null，介面退回用表情符號。
 */

export type Icons = {
  /** 每種塔 1～4 級各一張（索引是等級 − 1） */
  towers: Record<string, string[]>
  monsters: Record<string, string>
}

export const IconsContext = createContext<Icons | null>(null)

export function useIcons(): Icons | null {
  return useContext(IconsContext)
}

type Parts = {
  /** [塔的種類][等級 − 1] */
  bases: BufferGeometry[][]
  heads: BufferGeometry[][]
  bodies: BufferGeometry[]
  solid: Material
  glow: Material
  misty: Material
  /** 哪幾種怪是半透明的（索引和 `spec.monsters` 一樣） */
  ghosts: boolean[]
}

const SIZE = 144

export function renderIcons(spec: Spec, parts: Parts): Icons | null {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIZE
  let renderer: WebGLRenderer
  try {
    renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true })
  } catch {
    return null
  }
  renderer.setPixelRatio(1)
  renderer.setSize(SIZE, SIZE, false)
  renderer.setClearColor(0x000000, 0)
  const scene = new Scene()
  const sun = new DirectionalLight(0xfff4e0, 2.7)
  sun.position.set(-2.2, 3.4, 2.6)
  scene.add(new HemisphereLight(0xffffff, 0x8a8478, 1.45), sun)
  const camera = new PerspectiveCamera(26, 1, 0.1, 60)
  const box = new Box3()
  const part = new Box3()
  const center = new Vector3()
  const size = new Vector3()

  /** 拍一張：把這幾塊（幾何、材質、裝在多高）擺好，鏡頭從右前方斜斜地往下看，剛好把整個模型放進畫面 */
  const shoot = (pieces: [BufferGeometry, Material, number][]): string => {
    const group = new Group()
    box.makeEmpty()
    for (const [geometry, material, y] of pieces) {
      const mesh = new Mesh(geometry, material)
      mesh.position.y = y
      group.add(mesh)
      geometry.computeBoundingBox()
      if (geometry.boundingBox) box.union(part.copy(geometry.boundingBox).translate(mesh.position))
    }
    box.getCenter(center)
    box.getSize(size)
    const radius = Math.max(size.x, size.y, size.z) * 0.5 * 1.16 + 0.02
    const distance = radius / Math.sin((camera.fov * Math.PI) / 360)
    const [yaw, pitch] = [0.62, 0.44]
    camera.position.set(
      center.x + Math.sin(yaw) * Math.cos(pitch) * distance,
      center.y + Math.sin(pitch) * distance,
      center.z + Math.cos(yaw) * Math.cos(pitch) * distance,
    )
    camera.lookAt(center)
    scene.add(group)
    renderer.render(scene, camera)
    scene.remove(group)
    return canvas.toDataURL('image/png')
  }

  const icons: Icons = { towers: {}, monsters: {} }
  try {
    spec.towers.forEach((t, k) => {
      const look = TOWER_LOOK[t.id]
      icons.towers[t.id] = parts.bases[k].map((base, i) =>
        shoot([
          [base, parts.solid, 0],
          [parts.heads[k][i], look.glow ? parts.glow : parts.solid, look.headY],
        ]),
      )
    })
    spec.monsters.forEach((m, k) => {
      icons.monsters[m.id] = shoot([[parts.bodies[k], parts.ghosts[k] ? parts.misty : parts.solid, 0]])
    })
  } catch {
    return null
  } finally {
    renderer.dispose()
    renderer.forceContextLoss()
  }
  return icons
}
