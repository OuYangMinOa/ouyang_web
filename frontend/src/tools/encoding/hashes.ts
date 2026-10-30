// 雜湊計算：hash-wasm 含 wasm，用到才載入；全部在瀏覽器裡算，不會上傳

import type { IHasher } from 'hash-wasm'
import { base64Encode, toHex } from './codecs'

type HashWasm = typeof import('hash-wasm')

export type HashAlgo = {
  id: string
  name: string
  /** 可以搭配 HMAC */
  hmac: boolean
  create: (hw: HashWasm) => Promise<IHasher>
}

export const HASH_ALGOS: HashAlgo[] = [
  { id: 'md5', name: 'MD5', hmac: true, create: (h) => h.createMD5() },
  { id: 'sha1', name: 'SHA-1', hmac: true, create: (h) => h.createSHA1() },
  { id: 'sha224', name: 'SHA-224', hmac: true, create: (h) => h.createSHA224() },
  { id: 'sha256', name: 'SHA-256', hmac: true, create: (h) => h.createSHA256() },
  { id: 'sha384', name: 'SHA-384', hmac: true, create: (h) => h.createSHA384() },
  { id: 'sha512', name: 'SHA-512', hmac: true, create: (h) => h.createSHA512() },
  { id: 'sha3-256', name: 'SHA3-256', hmac: true, create: (h) => h.createSHA3(256) },
  { id: 'sha3-512', name: 'SHA3-512', hmac: true, create: (h) => h.createSHA3(512) },
  { id: 'keccak256', name: 'Keccak-256', hmac: true, create: (h) => h.createKeccak(256) },
  { id: 'ripemd160', name: 'RIPEMD-160', hmac: true, create: (h) => h.createRIPEMD160() },
  { id: 'sm3', name: 'SM3', hmac: true, create: (h) => h.createSM3() },
  { id: 'blake2b', name: 'BLAKE2b-512', hmac: false, create: (h) => h.createBLAKE2b(512) },
  { id: 'blake2s', name: 'BLAKE2s-256', hmac: false, create: (h) => h.createBLAKE2s(256) },
  { id: 'blake3', name: 'BLAKE3', hmac: false, create: (h) => h.createBLAKE3() },
  { id: 'crc32', name: 'CRC32', hmac: false, create: (h) => h.createCRC32() },
  { id: 'crc32c', name: 'CRC32C', hmac: false, create: (h) => h.createCRC32(0x82f63b78) },
  { id: 'xxhash64', name: 'xxHash64', hmac: false, create: (h) => h.createXXHash64() },
  { id: 'xxhash128', name: 'xxHash128', hmac: false, create: (h) => h.createXXHash128() },
]

let loading: Promise<HashWasm> | null = null

export function loadHashWasm(): Promise<HashWasm> {
  // 載入失敗要能重試，所以失敗時清掉快取
  loading ??= import('hash-wasm').catch((e: unknown) => {
    loading = null
    throw e
  })
  return loading
}

export type Digests = Record<string, Uint8Array>

/** key 有值就是 HMAC，只算支援 HMAC 的演算法 */
async function createAll(key: Uint8Array | null) {
  const hw = await loadHashWasm()
  const algos = key ? HASH_ALGOS.filter((a) => a.hmac) : HASH_ALGOS
  return Promise.all(
    algos.map(async (a) => ({ id: a.id, hasher: key ? await hw.createHMAC(a.create(hw), key) : await a.create(hw) })),
  )
}

export async function hashBytes(data: Uint8Array, key: Uint8Array | null): Promise<Digests> {
  const all = await createAll(key)
  const out: Digests = {}
  for (const { id, hasher } of all) out[id] = hasher.update(data).digest('binary')
  return out
}

/** 檔案分段讀取，大檔案也不會一次吃掉記憶體；signal 取消時回傳 null */
export async function hashFile(
  file: Blob,
  key: Uint8Array | null,
  onProgress: (done: number) => void,
  signal: AbortSignal,
): Promise<Digests | null> {
  const CHUNK = 2 * 1024 * 1024
  const all = await createAll(key)
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    const buf = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer())
    if (signal.aborted) return null
    for (const { hasher } of all) hasher.update(buf)
    onProgress(Math.min(offset + CHUNK, file.size))
  }
  if (signal.aborted) return null
  const out: Digests = {}
  for (const { id, hasher } of all) out[id] = hasher.digest('binary')
  return out
}

export type DigestFormat = 'hex' | 'HEX' | 'base64'

export function formatDigest(bytes: Uint8Array, format: DigestFormat): string {
  if (format === 'base64') return base64Encode(bytes)
  return toHex(bytes, '', format === 'HEX')
}

/** 比對貼上的雜湊值：十六進位不分大小寫、可以有 0x 或冒號；也接受 Base64（含網址安全版） */
export function digestMatches(expected: string, digest: Uint8Array): boolean {
  // sha256sum 的輸出是「雜湊 檔名」，只取第一段
  const token = expected.trim().split(/\s+/)[0] ?? ''
  if (!token) return false
  const hex = token.replace(/^0x/i, '').replace(/[:-]/g, '').toLowerCase()
  if (hex === toHex(digest)) return true
  const norm = (s: string) => s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/')
  return norm(token) === norm(base64Encode(digest))
}
