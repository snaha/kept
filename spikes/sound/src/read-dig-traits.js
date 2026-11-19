// Counts hand-set Dig traits in a COPY of the app's localStorage LevelDB (never the live profile).
// Usage: cp -R "<profile>/Local Storage/leveldb" /tmp/copy && rm /tmp/copy/LOCK
//        node src/read-dig-traits.js /tmp/copy [out.json]
import { writeFile } from 'node:fs/promises'
import { ClassicLevel } from 'classic-level'

const CATALOG_KEY = 'music.catalog.v1:'
const UTF16_PREFIX = 0
const [dir, outFile] = process.argv.slice(2)
const db = new ClassicLevel(dir, { keyEncoding: 'buffer', valueEncoding: 'buffer', createIfMissing: false })
await db.open()
const traits = {}
let stores = 0
for await (const [key, value] of db.iterator()) {
  const name = key.toString('latin1')
  if (!name.includes(CATALOG_KEY) || name.endsWith(':colors')) continue
  stores++
  // Chromium prefixes each value with its encoding: 0 = UTF-16LE, 1 = Latin-1.
  const text = new TextDecoder(value[0] === UTF16_PREFIX ? 'utf-16le' : 'latin1').decode(value.subarray(1))
  for (const [id, item] of Object.entries(JSON.parse(text))) if (item.traits) traits[id] = item.traits
}
await db.close()
console.log(`catalog stores: ${stores}, albums with hand-set traits: ${Object.keys(traits).length}`)
if (outFile) await writeFile(outFile, JSON.stringify(traits))
