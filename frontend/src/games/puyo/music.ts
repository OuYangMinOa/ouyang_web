/**
 * 魔法氣泡的背景音樂：自己寫的一段輕快小曲（C 大調，A 段兩次、B 段一次），不是原作的配樂。
 * 合成和排程見 `shared/music.ts`；等級 1 是 132 BPM，每升一級快一點，最快 180。
 */

import { useMusic as useSongMusic, type Note, type Song } from '../shared/music'

// A 段：跳上跳下的主題
const PART_A: Note[] = [
  ['C5', 1], ['E5', 1], ['G5', 2], ['E5', 1], ['G5', 1], ['A5', 2],
  ['G5', 2], ['E5', 2], ['C5', 2], ['D5', 2],
  ['E5', 1], ['F5', 1], ['G5', 2], ['F5', 1], ['E5', 1], ['D5', 2],
  ['C5', 2], ['D5', 1], ['E5', 1], ['D5', 4],
  ['C5', 1], ['E5', 1], ['G5', 2], ['E5', 1], ['G5', 1], ['C6', 2],
  ['B5', 2], ['A5', 2], ['G5', 2], ['A5', 2],
  ['F5', 1], ['E5', 1], ['D5', 2], ['G5', 1], ['F5', 1], ['E5', 1], ['D5', 1],
  ['C5', 4], [null, 2], ['G4', 2],
]

// B 段：轉到小調再爬回來
const PART_B: Note[] = [
  ['A4', 2], ['C5', 1], ['E5', 1], ['A5', 2], ['G5', 2],
  ['F5', 2], ['E5', 1], ['D5', 1], ['E5', 4],
  ['F4', 2], ['A4', 1], ['C5', 1], ['F5', 2], ['E5', 2],
  ['D5', 2], ['C5', 1], ['B4', 1], ['C5', 2], ['G4', 2],
  ['A4', 2], ['C5', 1], ['E5', 1], ['A5', 2], ['B5', 2],
  ['C6', 2], ['B5', 1], ['A5', 1], ['G5', 2], ['E5', 2],
  ['F5', 1], ['G5', 1], ['A5', 2], ['G5', 1], ['F5', 1], ['E5', 1], ['D5', 1],
  ['C5', 4], ['G4', 2], [null, 2],
]

/** 每小節（8 個八分音符）的低音根音 */
const BASS_A = ['C3', 'A2', 'F2', 'G2', 'C3', 'F2', 'G2', 'C3']
const BASS_B = ['A2', 'A2', 'F2', 'G2', 'A2', 'E2', 'F2', 'G2']

const SONG: Song = {
  melody: [...PART_A, ...PART_A, ...PART_B],
  bass: [...BASS_A, ...BASS_A, ...BASS_B],
  bpm: 132,
  bpmPerLevel: 3,
  maxBpm: 180,
}

/** 在遊戲進行中（`playing`）播放背景音樂；開關記在 localStorage */
export function useMusic(playing: boolean, level: number) {
  return useSongMusic('puyo', SONG, playing, level)
}
