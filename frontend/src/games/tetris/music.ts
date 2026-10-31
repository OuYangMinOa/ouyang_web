/**
 * 背景音樂：Korobeiniki（俄羅斯民謠，就是大家熟悉的俄羅斯方塊主題）。
 * 合成和排程見 `shared/music.ts`；等級 1 是 120 BPM，每升一級快一點，最快 180。
 */

import { useMusic as useSongMusic, type Note, type Song } from '../shared/music'

// A 段：大家最熟的那段
const PART_A: Note[] = [
  ['E5', 2], ['B4', 1], ['C5', 1], ['D5', 2], ['C5', 1], ['B4', 1],
  ['A4', 2], ['A4', 1], ['C5', 1], ['E5', 2], ['D5', 1], ['C5', 1],
  ['B4', 3], ['C5', 1], ['D5', 2], ['E5', 2],
  ['C5', 2], ['A4', 2], ['A4', 4],
  [null, 1], ['D5', 2], ['F5', 1], ['A5', 2], ['G5', 1], ['F5', 1],
  ['E5', 3], ['C5', 1], ['E5', 2], ['D5', 1], ['C5', 1],
  ['B4', 2], ['B4', 1], ['C5', 1], ['D5', 2], ['E5', 2],
  ['C5', 2], ['A4', 2], ['A4', 2], [null, 2],
]

// B 段：慢下來的那段
const PART_B: Note[] = [
  ['E5', 4], ['C5', 4], ['D5', 4], ['B4', 4],
  ['C5', 4], ['A4', 4], ['G#4', 4], ['B4', 2], [null, 2],
  ['E5', 4], ['C5', 4], ['D5', 4], ['B4', 4],
  ['C5', 2], ['E5', 2], ['A5', 4], ['G#5', 8],
]

/** 每小節（8 個八分音符）的低音根音 */
const BASS_A = ['E2', 'A2', 'E2', 'A2', 'D2', 'C2', 'E2', 'A2']
const BASS_B = ['A2', 'E2', 'A2', 'E2', 'A2', 'E2', 'A2', 'E2']

const KOROBEINIKI: Song = {
  melody: [...PART_A, ...PART_A, ...PART_B],
  bass: [...BASS_A, ...BASS_A, ...BASS_B],
  bpm: 120,
  bpmPerLevel: 4,
  maxBpm: 180,
}

/** 在遊戲進行中（`playing`）播放背景音樂；開關記在 localStorage */
export function useMusic(playing: boolean, level: number) {
  return useSongMusic('tetris', KOROBEINIKI, playing, level)
}
