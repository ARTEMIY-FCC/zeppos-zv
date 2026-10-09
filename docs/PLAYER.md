# Playing .zv on the watch

The player lives in `watch/lib/` and has no dependencies besides Zepp OS
APIs (`@zos/ui`, `@zos/fs`, `@zos/media`). Requires API level 3.0+
(`auto_scale` on `IMG`); tested in the Balance 2 emulator (API 4.2).

| File | Role |
| --- | --- |
| `zv.js` | decoder: header parsing, rANS, frame reconstruction into PNG bytes |
| `player.js` | playback on an `IMG` widget: decode-ahead, frame files, timing, sound, loop |
| `audio.js` | MP3 playback with the `@zos/media` lifecycle rules |
| `fsx.js` | small file helpers (open/read/write/list/remove) |

## Setup

`app.json` needs the media permission for sound:

```json
"permissions": ["device:media"]
```

Release the media session when the app exits (the watch has only one, and an
unreleased session leaves sound dead until reboot):

```js
// app.js
import { releaseAll } from './lib/audio'

App({
  onDestroy() {
    releaseAll()
  },
})
```

## Usage

```js
import * as hmUI from '@zos/ui'
import { getDeviceInfo } from '@zos/device'
import { createPlayer } from '../lib/player'

const { width, height } = getDeviceInfo()
// 239×240 picture, scaled by an integer factor when it fits (2× on 480×480), centred
const k = Math.min(width / 239, height / 240)
const scale = k >= 2 ? Math.floor(k) : k
const w = Math.round(239 * scale)
const h = Math.round(240 * scale)

Page({
  build() {
    hmUI.createWidget(hmUI.widget.FILL_RECT, { x: 0, y: 0, w: width, h: height, color: 0 })
    const img = hmUI.createWidget(hmUI.widget.IMG, {
      x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), w, h,
      auto_scale: true, src: '',
    })
    this.player = createPlayer(img, {
      onStatus: (phase, p) => {},   // 'prepare' (p = share of frames decoded) | 'wait-audio' | 'play' | 'pause'
      onProgress: (p) => {},        // playback position 0..1
      onLoop: () => {},             // the clip starts over
      onError: (message) => {},     // corrupted file
    })
    this.player.load('clip.zv', true, 'clip')
  },
  onDestroy() {
    this.player.unload()
  },
})
```

### API

`createPlayer(img, events)` returns:

| Member | Description |
| --- | --- |
| `load(path, asset, id)` | Open a clip and start decoding. `asset = true` reads `path` from the app package (`assets/<target>/`), otherwise from the data folder (e.g. `download/x.zv` for a file received from the phone). `id` names the frame files — use a short stable name per clip. Returns `{ n, fps, dur }`. Throws if the file is missing or not a ZV file. |
| `togglePause()` | Pause, or resume from the start of the loop (sound and picture stay in sync). Returns `true` when paused. |
| `unload()` | Stop decoding, playback and sound; close the file. Frame files stay on disk. |
| `phase` | `idle`, `prepare`, `wait-audio`, `play`, `pause` or `error`. |

`cleanFrames(keep)` deletes frame files of all clips except `keep`; `load()`
calls it for you.

## What happens inside

1. `load()` reads the header (one `readSync`), creates the decoder, writes the
   MP3 part of the file to `zvf/<id>.mp3` and starts a timer loop.
2. Each tick decodes as many frames as fit before the next frame is due and
   writes them as `zvf/<id>_<n>.png` (~58 KB each; a 10-second clip uses ~7 MB
   of flash while it is the current clip).
3. Playback starts as soon as, at the measured decoding speed, the remaining
   frames will be ready in time; until then frame 0 is shown and `onStatus`
   reports progress. A fast watch starts after a few frames, a slow one (or the
   emulator) decodes most of the clip first.
4. Sound starts, and the video clock is taken from the moment the player
   reports `playing`; frame `k` is shown at `k / fps` by changing the `IMG`
   source. If sound fails within 1.5 s, the video plays on its own clock.
5. At the end the clip loops: sound restarts and frames are reused.
   A `<id>_done` marker lets a later `load()` of the same clip skip decoding.

Frame names are unique per clip on purpose: Zepp OS caches images by file
name, so rewriting a file under a name that was already shown would display
the old picture.

## Using the decoder directly

```js
import { headerSize, parseHeader, createDecoder } from '../lib/zv'
import { openSync, readSync, writeSync, closeSync, O_RDONLY, O_RDWR, O_CREAT, O_TRUNC } from '@zos/fs'

const fd = openSync({ path: 'download/clip.zv', flag: O_RDONLY })
const read = (pos, len) => {
  const b = new Uint8Array(len)
  readSync({ fd, buffer: b.buffer, options: { position: pos, length: len } })
  return b
}
const v = parseHeader(read(0, headerSize(read(0, 26))))   // { S, H, fps, n, offs, audioAt, audioLen, ... }
const dec = createDecoder(v)
for (let i = 0; i < v.n; i++) {
  dec.decode(read(v.offs[i], v.offs[i + 1] - v.offs[i]))  // frames strictly in order
  const out = openSync({ path: 'f' + i + '.png', flag: O_RDWR | O_CREAT | O_TRUNC })
  writeSync({ fd: out, buffer: dec.buffer, options: { offset: dec.fileAt, length: dec.fileLen } })
  closeSync({ fd: out })
  dec.commit()                                           // this frame becomes the reference
}
closeSync({ fd })
// show with IMG src: 'data://f0.png', 'data://f1.png', ...
```

`dec.reset()` rewinds the decoder to the initial all-zero state (decode from
frame 0 again).

## Performance notes

- Per frame, decoding is ~0.7–0.9 ms in QuickJS on a desktop CPU; the Zepp OS
  emulator is ~700× slower than that. Real watches are expected to be in
  between; measure your changes with `qjs --std tools/zvbench.mjs`.
- JavaScript on the watch has a heap of a few MB: never read a whole video
  into memory. The decoder needs ~350 KB.
- Swapping the source of a full-screen scaled `IMG` takes ~38 ms in the
  emulator, which limits playback to ~25 fps there.
