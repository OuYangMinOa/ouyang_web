import { createContext, useContext } from 'react'
import type { Politics, Quote, Vote } from './quotes'

export type FuncSay = {
  /** 還在載入是 null */
  quotes: Quote[] | null
  loadError: string
  reload: () => void
  signedIn: boolean
  /** 自己按過的讚／倒讚 */
  votes: Map<number, Vote>
  /** 收藏的編號，新收藏的在前 */
  favorites: number[]
  politics: Politics
  setPolitics: (value: Politics) => void
  /** 讚和倒讚只能選一個；按已經選的那個是收回（傳 null） */
  vote: (id: number, vote: Vote | null) => void
  toggleFavorite: (id: number) => void
  copy: (quote: Quote) => void
  /** 沒登入時要登入的提示 */
  askLogin: (message: string) => void
}

export const FuncSayContext = createContext<FuncSay | null>(null)

export function useFuncSay(): FuncSay {
  const value = useContext(FuncSayContext)
  if (!value) throw new Error('useFuncSay 要在 <FuncSayApp> 裡面用')
  return value
}
