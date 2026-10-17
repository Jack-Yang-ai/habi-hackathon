/**
 * A v4 UUID for ids the page creates itself.
 *
 * `crypto.randomUUID` is only defined in a secure context. The app is legitimately opened over a
 * plain HTTP LAN address (`http://192.168.x.x:8787`) for the Mac mini, and in that context the
 * method is absent — every manual photo upload and every chat send then failed with
 * "crypto.randomUUID is not a function". `crypto.getRandomValues` *is* available in insecure
 * contexts, so build the same v4 layout from it; Math.random is only the last resort for a host
 * with no crypto object at all.
 */
export function randomUuid(): string {
  const cryptoObject = (globalThis as { crypto?: Crypto }).crypto
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') return cryptoObject.randomUUID()
  const bytes = new Uint8Array(16)
  if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') cryptoObject.getRandomValues(bytes)
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
