/**
 * Video sound: mp3 on the watch speaker.
 *
 * @zos/media rules learned on a real Balance 2:
 *
 * 1. stop() always goes with release(): a stopped but not released player
 *    stays mute forever, a released one can take the next file.
 * 2. The player is created once per process: the watch has one media session,
 *    a second create() fails. It is released when the app exits (app.js).
 * 3. The player is never touched from its own event handler: the event sets a
 *    flag, drive() does the work from a timer.
 * 4. The duration the watch reports can be half the real one — the known clip
 *    length wins.
 */
import { create, id } from '@zos/media'

let player = null
let phase = 'none' // none | idle | preparing | playing
let want = null // { file, owner } | 'stop'
let current = null // { file, owner, started, duration }
let prepared = 0
let completed = false
let timer = null
let preparedAt = 0

function emit(state, extra) {
  const owner = current && current.owner
  if (owner && owner.onAudio) {
    try {
      owner.onAudio(state, extra || {})
    } catch (e) {}
  }
}

function schedule(ms) {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    drive()
  }, ms || 0)
}

function ensure() {
  if (player) return player
  try {
    player = create(id.PLAYER)
  } catch (e) {
    player = null
  }
  if (!player) return null
  phase = 'idle'
  try {
    player.addEventListener(player.event.PREPARE, (ok) => {
      if (phase !== 'preparing') return
      prepared = ok === false ? -1 : 1
      schedule(0)
    })
    player.addEventListener(player.event.COMPLETE, () => {
      if (phase !== 'playing') return
      completed = true
      schedule(0)
    })
  } catch (e) {}
  return player
}

function letGo() {
  if (player && phase !== 'idle' && phase !== 'none') {
    try {
      player.stop()
    } catch (e) {}
    try {
      if (player.release) player.release()
    } catch (e) {}
  }
  if (player) phase = 'idle'
  prepared = 0
  completed = false
}

function finish(state) {
  letGo()
  const was = current
  current = null
  if (was && was.owner && was.owner.onAudio) {
    try {
      was.owner.onAudio(state, {})
    } catch (e) {}
  }
}

function drive() {
  if (want) {
    const next = want
    want = null
    if (current) finish('stopped')
    if (next === 'stop') return
    const p = ensure()
    if (!p) {
      if (next.owner && next.owner.onAudio) next.owner.onAudio('error', {})
      return
    }
    letGo()
    current = { file: next.file, owner: next.owner, started: 0, duration: 0 }
    try {
      p.setSource(p.source.FILE, { file: next.file })
      phase = 'preparing'
      preparedAt = Date.now()
      p.prepare()
    } catch (e) {
      finish('error')
      return
    }
    schedule(60)
    return
  }
  if (!current) return

  if (phase === 'preparing') {
    if (prepared === 1) {
      try {
        player.start()
      } catch (e) {
        finish('error')
        return
      }
      phase = 'playing'
      current.started = Date.now()
      emit('playing', {})
      schedule(250)
      return
    }
    if (prepared === -1 || Date.now() - preparedAt > 8000) {
      finish('error')
      return
    }
    schedule(40)
    return
  }

  if (phase === 'playing') {
    const known = (current.owner && current.owner.duration) || 0
    const elapsed = (Date.now() - current.started) / 1000
    // COMPLETE does not arrive on every firmware — fall back to the clip length
    if (completed || (known > 0 && elapsed > known + 1.5)) {
      finish('done')
      return
    }
    schedule(250)
  }
}

/** Play a file. owner.onAudio(state): playing → done/stopped/error; owner.duration — clip length. */
export function play(file, owner) {
  want = { file, owner }
  schedule(0)
}

export function stop() {
  if (!current && !want) return
  want = 'stop'
  schedule(0)
}

/** Immediately, without a timer: when leaving the page. */
export function stopNow() {
  want = null
  if (current) finish('stopped')
}

/** App exit: give the media session back to the system. */
export function releaseAll() {
  want = null
  if (current) finish('stopped')
  letGo()
}
