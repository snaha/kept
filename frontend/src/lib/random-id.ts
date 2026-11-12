// getRandomValues also works on LAN HTTP pages, where randomUUID is unavailable.
const ID_BYTES = 16
const HEX_RADIX = 16
const HEX_BYTE_WIDTH = 2
export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_BYTES))
  return Array.from(bytes, byte => byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, '0')).join('')
}
