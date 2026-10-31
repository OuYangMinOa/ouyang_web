import { useRef } from 'react'
import { intensityClass, taipeiTime, windText, type Storm, type TrackPoint } from './data'
import { L, TAIWAN_CENTER, unwrapLongitudes, useLayers, useLeafletMap } from './map'

type Props = {
  storms: Storm[]
  selectedId?: string
  /** 要畫哪些官方單位的路徑 */
  agencies: string[]
  /** 也畫 AI 系集（成員路徑壓在官方路徑底下，平均路徑疊在最上面） */
  ai?: boolean
  className?: string
}

function pointTooltip(title: string, point: TrackPoint) {
  const rows = [
    `<strong>${title}</strong>`,
    point.time ? taipeiTime(point.time) : '',
    point.wind_kt !== undefined ? `${intensityClass(point.wind_kt).label}・${windText(point.wind_kt)}` : '',
    point.pressure_hpa !== undefined ? `${point.pressure_hpa} hPa` : '',
    point.radius_km !== undefined ? `70% 機率半徑 ${point.radius_km} km` : '',
  ]
  return rows.filter(Boolean).join('<br>')
}

/** 沒有風速的點（JTWC 經 GDACS 的預報點）畫成預報單位顏色的空心圓 */
function levelClass(point: TrackPoint) {
  const { level } = intensityClass(point.wind_kt)
  return level < 0 ? 'tc-level-none' : `tc-level-${level}`
}

/** 颱風路徑圖：所有颱風都畫，選到的那個比較明顯，並把視野移到它（西北太平洋的會連台灣一起框進來） */
export default function TyphoonMap({ storms, selectedId, agencies, ai = false, className = '' }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const map = useLeafletMap(container, TAIWAN_CENTER, 4)

  useLayers(
    map,
    (group) => {
      const bounds = L.latLngBounds([])
      for (const storm of storms) {
        const selected = !selectedId || storm.id === selectedId
        const dim = selected ? '' : ' tc-dim'
        const add = (layer: L.Layer, inBounds?: L.LatLngExpression[]) => {
          layer.addTo(group)
          if (selected && inBounds) inBounds.forEach((p) => bounds.extend(p))
        }

        const drawOfficial = (agency: string) => {
          const forecast = storm.agencies[agency]
          if (!forecast) return
          const cls = `agency-${agency}${dim}`
          const past = unwrapLongitudes(forecast.past.map((p) => [p.lat, p.lon]))
          const ahead = unwrapLongitudes(
            [forecast.past[forecast.past.length - 1], ...forecast.forecast].map((p) => [p.lat, p.lon]),
          )
          if (forecast.cone) {
            add(
              L.polygon(forecast.cone, {
                className: `tc-cone ${cls}`,
                interactive: false,
              }),
            )
          }
          for (const point of forecast.forecast) {
            if (point.radius_km) {
              add(
                L.circle([point.lat, point.lon], {
                  radius: point.radius_km * 1000,
                  className: `tc-prob ${cls}`,
                  interactive: false,
                }),
              )
            }
          }
          add(
            L.polyline(past, {
              className: `tc-past ${cls}`,
              interactive: false,
            }),
            past,
          )
          add(
            L.polyline(ahead, {
              className: `tc-forecast ${cls}`,
              interactive: false,
            }),
            ahead,
          )
          const name = storm.name_zh ?? storm.name_en ?? '颱風'
          for (const point of forecast.forecast) {
            add(
              L.circleMarker([point.lat, point.lon], {
                radius: 5,
                className: `tc-point ${levelClass(point)} agency-${agency}${dim}`,
              }).bindTooltip(pointTooltip(`${name}・預報`, point)),
            )
          }
        }

        const ensemble = ai ? storm.ai : undefined
        if (ensemble) {
          for (const member of ensemble.members) {
            const path = unwrapLongitudes(member.map(([, lat, lon]) => [lat, lon]))
            add(
              L.polyline(path, {
                className: `tc-member${dim}`,
                interactive: false,
              }),
              path,
            )
          }
        }
        agencies.forEach(drawOfficial)
        if (ensemble) {
          const mean = unwrapLongitudes(ensemble.mean.map((p) => [p.lat, p.lon]))
          add(
            L.polyline(mean, {
              className: `tc-ai-mean${dim}`,
              interactive: false,
            }),
            mean,
          )
          ensemble.mean.forEach((point, i) => {
            // 每 12 小時一個點就夠
            if (i % 2 !== 0) return
            add(
              L.circleMarker([point.lat, point.lon], {
                radius: 4,
                className: `tc-point tc-ai-point ${levelClass(point)}${dim}`,
              }).bindTooltip(pointTooltip('AI 系集平均', point)),
            )
          })
        }

        // 目前位置與暴風圈
        const { current } = storm
        if (current.storm_radius_km && agencies.length > 0) {
          add(
            L.circle([current.lat, current.lon], {
              radius: current.storm_radius_km * 1000,
              className: `tc-storm-radius${dim}`,
              interactive: false,
            }),
          )
        }
        const eye = L.marker([current.lat, current.lon], {
          icon: L.divIcon({
            className: `tc-eye ${levelClass(current)}${dim}`,
            html: '<span></span>',
            iconSize: [28, 28],
          }),
          keyboard: false,
        }).bindTooltip(pointTooltip(storm.name_zh ?? storm.name_en ?? '熱帶擾動', current))
        add(eye, [[current.lat, current.lon]])
        if (selected && storm.west_pacific) bounds.extend(TAIWAN_CENTER)
      }

      if (bounds.isValid()) map?.fitBounds(bounds, { padding: [24, 24], maxZoom: 7 })
    },
    [storms, selectedId, agencies.join(','), ai],
  )

  return <div ref={container} className={`weather-map ${className}`} role="region" aria-label="颱風路徑圖" />
}
