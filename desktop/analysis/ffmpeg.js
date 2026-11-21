import { accessSync, constants } from 'node:fs'
import path from 'node:path'

// Which ffmpeg decodes for the analyser. The bundled LGPL build comes first (scripts/build-ffmpeg.mjs).
// A development checkout that has not built it may use the ffmpeg of the system; a packaged app never
// does, because what it ships is what its notices declare.

const EXECUTABLE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
const SYSTEM_FOLDERS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
const isExecutable = file => { try { accessSync(file, constants.X_OK); return true } catch { return false } }

// packaged: app.isPackaged. resources: process.resourcesPath. desktop: the folder of main.js.
// Returns { file, bundled } or undefined when there is no decoder.
export function resolveFfmpeg({ packaged, resources, desktop, env = process.env, exists = isExecutable }) {
  const bundled = packaged ? path.join(resources, EXECUTABLE) : path.join(desktop, 'bin', EXECUTABLE)
  if (exists(bundled)) return { file: bundled, bundled: true }
  if (packaged) return undefined
  const folders = [...(env.PATH ?? '').split(path.delimiter).filter(Boolean), ...SYSTEM_FOLDERS]
  const system = [env.KEPT_FFMPEG, ...folders.map(folder => path.join(folder, EXECUTABLE))].find(file => file && exists(file))
  return system ? { file: system, bundled: false } : undefined
}

// The models folder: next to the app when packaged, desktop/models in a checkout (scripts/fetch-openl3.mjs).
export const resolveModelDir = ({ packaged, resources, desktop }) => (packaged ? path.join(resources, 'models') : path.join(desktop, 'models'))
