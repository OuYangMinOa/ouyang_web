/**
 * 四子棋的背景音樂：自己寫的一段輕快、親切又柔和的小曲（C 大調，A、A'、B、A'' 四個短樂句），
 * 不是任何現成的曲子。合成和排程見 `shared/music.ts`；固定 88 BPM，用柔和音色。
 */

import type { Note, Song } from '../shared/music'

// A 段：沿著主和弦往上爬，再輕輕落下
const PART_A: Note[] = [
  ['E4', 2], ['G4', 2], ['C5', 3], ['B4', 1],
  ['A4', 3], ['G4', 1], ['E4', 4],
  ['F4', 2], ['A4', 2], ['C5', 2], ['A4', 2],
  ['G4', 6], [null, 2],
]

// A' 段：同樣開頭，往下走再升到屬和弦
const PART_A2: Note[] = [
  ['E4', 2], ['G4', 2], ['C5', 3], ['B4', 1],
  ['C5', 2], ['B4', 2], ['A4', 4],
  ['F4', 2], ['E4', 2], ['D4', 2], ['F4', 2],
  ['G4', 2], ['A4', 2], ['B4', 4],
]

// B 段：從下屬和弦開出去，像在想下一步
const PART_B: Note[] = [
  ['A4', 3], ['B4', 1], ['C5', 4],
  ['B4', 3], ['A4', 1], ['G4', 4],
  ['A4', 2], ['G4', 2], ['F4', 2], ['A4', 2],
  ['B4', 3], ['A4', 1], ['G4', 2], [null, 2],
]

// A'' 段：回到主題，停在屬和弦接回開頭
const PART_A3: Note[] = [
  ['E4', 2], ['G4', 2], ['C5', 3], ['B4', 1],
  ['A4', 2], ['C5', 2], ['E5', 2], ['C5', 2],
  ['C5', 3], ['A4', 1], ['F4', 4],
  ['G4', 4], ['D4', 2], [null, 2],
]

/** 每小節（8 個八分音符）的低音根音 */
const BASS_A = ['C3', 'A2', 'F2', 'G2']
const BASS_A2 = ['C3', 'A2', 'D3', 'G2']
const BASS_B = ['F2', 'E2', 'D3', 'G2']
const BASS_A3 = ['C3', 'A2', 'F2', 'G2']

const SONG: Song = {
  melody: [...PART_A, ...PART_A2, ...PART_B, ...PART_A3],
  bass: [...BASS_A, ...BASS_A2, ...BASS_B, ...BASS_A3],
  bpm: 88,
  bpmPerLevel: 0,
  maxBpm: 88,
  calm: true,
}

export default SONG
