const ID_BYTES = 16
const HEX_RADIX = 16
const HEX_BYTE_WIDTH = 2

// getRandomValues is available on HTTP LAN pages, unlike randomUUID.
// Keep credentials and occurrence IDs cryptographically random in both contexts.
export function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(ID_BYTES)), byte =>
    byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, '0')).join('')
}
