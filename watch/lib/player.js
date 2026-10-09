/**
 * ZV player on an IMG widget.
 *
 * lib/zv.js builds the frames and stores them as ready PNG files in the app
 * folder (zvf/<clip>_<n>.png); the system displays them: IMG with auto_scale
 * stretches 239x240 to the full screen. Showing a frame is one src change.
 *
 * Frame names are unique per clip: the system caches images by name, and a
 * file rewritten under the same name would still show the old picture
 * (checked in the emulator). For the same clip the content behind a name never
 * changes, so replays and loops reuse the ready files.
 *
 * Decoding runs ahead of playback. Playback starts once, at the measured
 * decoding speed, the last frames will be ready in time; until then the first
 * frame and a percentage are shown. Sound is the mp3 stored in the same file,
 * the video clock follows its start. The clip loops.
 */
import * as hmUI from '@zos/ui'

import * as audio from './audio'
import * as fsx from './fsx'
import { createDecoder, headerSize, parseHeader } from './zv'

export const DIR = 'zvf'

/** Delete frames of other clips (all but keep). Called when a clip is loaded. */
export function cleanFrames(keep) {
  const names = fsx.list(DIR)
  for (let i = 0; i < names.length; i++) {
    const name = String(names[i])
    if (keep && name.indexOf(keep + '_') === 0) continue
    if (keep && name === keep + '.mp3') continue
    fsx.remove(DIR + '/' + name)
  }
}

export function createPlayer(img, events) {
  let file = null
  let v = null
  let dec = null
  let tag = ''
  let n = 0
  let fps = 12
  let dur = 0
  let decoded = 0
  let shown = -1
  let phase = 'idle' // idle | prepare | wait-audio | play | pause | error
  let t0 = 0
  let waitSince = 0
  let timer = null
  let decMs = 0
  let decCount = 0
  let frameBuf = null
  let audioPath = ''
  let audioOff = false
  let gen = 0

  fsx.ensureDir(DIR)

  const owner = {
    duration: 0,
    onAudio(state) {
      if (owner.gen !== gen) return
      if (state === 'playing') {
        if (phase === 'wait-audio') {
          phase = 'play'
          t0 = Date.now()
          schedule(0)
        }
      } else if (state === 'error') {
        audioOff = true
        if (phase === 'wait-audio') {
          phase = 'play'
          t0 = Date.now()
          schedule(0)
        }
      }
    },
  }

  function src(i) {
    return 'data://' + DIR + '/' + tag + '_' + i + '.png'
  }

  function show(i) {
    if (i === shown || i >= decoded) return
    shown = i
    try {
      img.setProperty(hmUI.prop.SRC, src(i))
    } catch (e) {}
  }

  function schedule(ms) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(tick, ms > 0 ? ms : 0)
  }

  function status() {
    if (events.onStatus) events.onStatus(phase, n ? decoded / n : 0)
  }

  function decodeOne() {
    const i = decoded
    const a = v.offs[i]
    const len = v.offs[i + 1] - a
    const t = Date.now()
    file.read(a, len, frameBuf)
    dec.decode(frameBuf)
    fsx.writeFile(DIR + '/' + tag + '_' + i + '.png', dec.buffer, dec.fileAt, dec.fileLen)
    dec.commit()
    decoded++
    decMs += Date.now() - t
    decCount++
    if (decoded === n) {
      console.log('zv: decoded ' + n + ' frames, ' + Math.round(decMs / decCount) + ' ms per frame')
      // "all frames ready" marker: showing this clip again needs no decoding
      fsx.writeFile(DIR + '/' + tag + '_done', new ArrayBuffer(1), 0, 1)
    }
  }

  /** Will the remaining frames be ready in time if playback starts now. */
  function canStart() {
    if (decoded >= n) return true
    if (decoded < 3 || decCount < 2) return false
    // during playback decoding gets only part of the time: 0.7 margin
    const rate = (decCount / Math.max(1, decMs)) * 1000 * 0.7
    if (rate >= fps) return true
    return (n - decoded) / rate <= (n - 1) / fps
  }

  function begin() {
    shown = -1
    show(0)
    if (audioPath && !audioOff) {
      phase = 'wait-audio'
      waitSince = Date.now()
      owner.gen = gen
      audio.play(audioPath, owner)
    } else {
      phase = 'play'
      t0 = Date.now()
    }
    status()
  }

  function tick() {
    timer = null
    if (!dec) return
    let now = Date.now()
    if (phase === 'wait-audio' && now - waitSince > 1500) {
      // sound did not start — play without it
      audioOff = true
      phase = 'play'
      t0 = now
    }
    if (phase === 'play') {
      const t = (now - t0) / 1000
      if (t >= dur) {
        // loop: restart the sound, frames are ready
        if (events.onLoop) events.onLoop()
        begin()
        schedule(10)
        return
      }
      show(Math.min(n - 1, Math.floor(t * fps)))
      if (events.onProgress) events.onProgress(t / dur)
    }
    if (decoded < n && phase !== 'error') {
      // decode while there is time before the next frame (at least one frame per tick)
      const until = phase === 'play' ? t0 + ((Math.floor(((now - t0) / 1000) * fps) + 1) * 1000) / fps - 8 : now + 60
      try {
        do {
          decodeOne()
        } while (decoded < n && Date.now() < until)
      } catch (e) {
        console.log('zv: decoding frame', decoded, String(e))
        phase = 'error'
        if (events.onError) events.onError('corrupted video')
        return
      }
      now = Date.now()
    }
    if (phase === 'prepare') {
      if (shown < 0) show(0)
      if (canStart()) begin()
      else status()
    }
    if (phase === 'play') {
      // wake up for the next frame; while decoding is unfinished — right away, it yields by itself
      const due = t0 + ((Math.floor(((now - t0) / 1000) * fps) + 1) * 1000) / fps - now
      schedule(decoded < n ? Math.min(due, 1) : Math.max(4, due))
    } else if (phase === 'wait-audio') {
      schedule(decoded < n ? 0 : 30)
    } else if (decoded < n && phase !== 'error') {
      schedule(0) // preparing or paused: decoding goes on
    }
  }

  function unload() {
    gen++
    if (timer) clearTimeout(timer)
    timer = null
    if (phase === 'play' || phase === 'wait-audio' || phase === 'pause') audio.stop()
    if (file) file.close()
    file = null
    dec = null
    v = null
    phase = 'idle'
  }

  return {
    /**
     * Open a clip. path — a .zv file (asset = true — from the app package),
     * id — short clip name (used for frame file names).
     */
    load(path, asset, id) {
      unload()
      tag = String(id).replace(/[^A-Za-z0-9]/g, '').slice(0, 24) || 'v'
      cleanFrames(tag)
      file = fsx.openRead(path, asset)
      if (!file) throw new Error('video file not found')
      const h26 = file.read(0, 26)
      const head = file.read(0, headerSize(h26))
      v = parseHeader(head)
      dec = createDecoder(v)
      n = v.n
      fps = v.fps || 12
      dur = n / fps
      owner.duration = dur
      let max = 0
      for (let i = 0; i < n; i++) max = Math.max(max, v.offs[i + 1] - v.offs[i])
      frameBuf = new Uint8Array(max + 8)
      decoded = 0
      decMs = 0
      decCount = 0
      shown = -1
      audioOff = false
      audioPath = ''
      if (v.audioLen) {
        const mp3 = DIR + '/' + tag + '.mp3'
        if (fsx.size(mp3) !== v.audioLen) {
          const bytes = file.read(v.audioAt, v.audioLen)
          fsx.writeFile(mp3, bytes.buffer, 0, v.audioLen)
        }
        audioPath = 'data://' + mp3
      }
      if (fsx.size(DIR + '/' + tag + '_done') > 0) decoded = n // frames were decoded earlier
      phase = 'prepare'
      status()
      schedule(0)
      return { n, fps, dur }
    },

    togglePause() {
      if (phase === 'play' || phase === 'wait-audio') {
        phase = 'pause'
        audio.stop()
        status()
        return true
      }
      if (phase === 'pause') {
        // resume from the start of the loop: keeps sound and picture together
        begin()
        schedule(0)
        return false
      }
      return false
    },

    unload,
    get phase() {
      return phase
    },
  }
}
