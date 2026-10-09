/**
 * Files on the watch. Firmwares accept paths with and without data://, so both
 * are tried. A video is never read into memory whole: JS on the watch only has
 * a couple of megabytes.
 */
import {
  O_CREAT,
  O_RDONLY,
  O_RDWR,
  O_TRUNC,
  closeSync,
  mkdirSync,
  openAssetsSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from '@zos/fs'
import { writeSync } from '@zos/fs'

function variants(path) {
  const name = String(path).replace(/^data:\/\//, '')
  return [name, 'data://' + name]
}

export function size(path) {
  const vs = variants(path)
  for (let i = 0; i < vs.length; i++) {
    try {
      const st = statSync({ path: vs[i] })
      if (st && st.size) return st.size
    } catch (e) {}
  }
  return 0
}

/** Open a file from the app data folder for reading (or from the package: asset = true). */
export function openRead(path, asset) {
  let fd = -1
  if (asset) {
    fd = openAssetsSync({ path, flag: O_RDONLY })
  } else {
    const vs = variants(path)
    for (let i = 0; i < vs.length && !(fd >= 0); i++) {
      try {
        fd = openSync({ path: vs[i], flag: O_RDONLY })
      } catch (e) {
        fd = -1
      }
    }
  }
  // firmwares return the fd as a number-like object: compare it, do not check typeof
  if (!(fd >= 0)) return null
  return {
    read(pos, len, into) {
      const buf = into || new Uint8Array(len)
      readSync({ fd, buffer: buf.buffer, options: { offset: buf.byteOffset, length: len, position: pos } })
      return buf
    },
    close() {
      try {
        closeSync({ fd })
      } catch (e) {}
    },
  }
}

/** Write a slice of an ArrayBuffer to a file (replacing it). */
export function writeFile(path, buffer, offset, length) {
  const fd = openSync({ path, flag: O_RDWR | O_CREAT | O_TRUNC })
  try {
    writeSync({ fd, buffer, options: { offset: offset || 0, length: length == null ? buffer.byteLength : length } })
  } finally {
    closeSync({ fd })
  }
}

export function remove(path) {
  const vs = variants(path)
  for (let i = 0; i < vs.length; i++) {
    try {
      if (rmSync({ path: vs[i] }) === 0) return true
    } catch (e) {}
  }
  return false
}

export function ensureDir(path) {
  try {
    mkdirSync({ path })
  } catch (e) {}
}

export function list(dir) {
  try {
    const r = readdirSync({ path: dir })
    return Array.isArray(r) ? r : []
  } catch (e) {
    return []
  }
}
