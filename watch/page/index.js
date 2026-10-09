/**
 * Example app: a full-screen meme feed. Swipe up — next, down — previous
 * (or the crown), tap — pause, long press — quality. UI text is Russian.
 *
 * Clips come from the phone as ready .zv files (the server encodes them, see
 * app-side). While one plays, the phone already transfers the next one. No
 * connection — the demo clip from the app package plays.
 */
import { BasePage } from '@zeppos/zml/base-page'
import { getDeviceInfo } from '@zos/device'
import {
  pauseDropWristScreenOff,
  resetDropWristScreenOff,
  resetPageBrightTime,
  setPageBrightTime,
} from '@zos/display'
import { GESTURE_DOWN, GESTURE_UP, offDigitalCrown, offGesture, onDigitalCrown, onGesture } from '@zos/interaction'
import { LocalStorage } from '@zos/storage'
import * as hmUI from '@zos/ui'

import * as audio from '../lib/audio'
import * as fsx from '../lib/fsx'
import { createPlayer } from '../lib/player'

const { width: SW, height: SH, screenShape } = getDeviceInfo()
const ROUND = screenShape === 1 || SW === SH
const QUALITY = ['low', 'mid', 'high']
const QNAME = { low: 'Эконом', mid: 'Норма', high: 'Чётко' }
const KEEP_FILES = 12
const GET_TIMEOUT = 240000

let store = null
function storage() {
  if (!store) {
    try {
      store = new LocalStorage()
    } catch (e) {
      store = { getItem: () => null, setItem() {} }
    }
  }
  return store
}
function load(key, def) {
  try {
    const v = storage().getItem(key)
    return v === undefined || v === null ? def : JSON.parse(v)
  } catch (e) {
    return def
  }
}
function save(key, value) {
  try {
    storage().setItem(key, JSON.stringify(value))
  } catch (e) {}
}

// The 239x240 picture is scaled 2x (or as much as fits) and centred
const K = Math.max(1, Math.min(SW / 239, SH / 240))
const SCALE = K >= 2 ? Math.floor(K) : K
const VW = Math.round(239 * SCALE)
const VH = Math.round(240 * SCALE)

Page(
  BasePage({
    onInit() {
      this.items = []
      this.idx = 0
      this.page = 1
      this.nextPage = 0
      this.q = load('q', 'mid')
      this.files = load('files', {}) // key → { name, at }
      this.seen = load('seen', []) // ids of memes already shown: every launch shows new ones
      this.loops = 0
      this.waiting = null // key we are waiting for from the phone
      this.offline = false
      this.closed = false
    },

    build() {
      try {
        setPageBrightTime({ brightTime: 10 * 60 * 1000 })
      } catch (e) {}
      try {
        pauseDropWristScreenOff({ duration: 0 })
      } catch (e) {}

      hmUI.createWidget(hmUI.widget.FILL_RECT, { x: 0, y: 0, w: SW, h: SH, color: 0x000000 })
      this.img = hmUI.createWidget(hmUI.widget.IMG, {
        x: Math.round((SW - VW) / 2),
        y: Math.round((SH - VH) / 2),
        w: VW,
        h: VH,
        auto_scale: true,
        src: '',
      })
      // dark gradient under the caption
      this.shade = hmUI.createWidget(hmUI.widget.IMG, { x: 0, y: SH - 170, w: SW, h: 170, src: 'shade.png' })
      this.title = hmUI.createWidget(hmUI.widget.TEXT, {
        x: ROUND ? 70 : 16,
        y: SH - (ROUND ? 128 : 96),
        w: SW - (ROUND ? 140 : 32),
        h: 76,
        text: '',
        text_size: 26,
        color: 0xffffff,
        align_h: hmUI.align.CENTER_H,
        align_v: hmUI.align.CENTER_V,
        text_style: hmUI.text_style.WRAP,
      })
      // backdrop for status text: white text is unreadable on a light frame
      this.statusBg = hmUI.createWidget(hmUI.widget.FILL_RECT, {
        x: 50,
        y: SH / 2 - 62,
        w: SW - 100,
        h: 124,
        radius: 28,
        color: 0x111114,
      })
      this.status = hmUI.createWidget(hmUI.widget.TEXT, {
        x: 60,
        y: SH / 2 - 62,
        w: SW - 120,
        h: 124,
        text: 'Загружаю мемы…',
        text_size: 28,
        color: 0xffffff,
        align_h: hmUI.align.CENTER_H,
        align_v: hmUI.align.CENTER_V,
        text_style: hmUI.text_style.WRAP,
      })
      // pause sign — two bars in the centre
      this.pauseMark = [-1, 1].map((side) =>
        hmUI.createWidget(hmUI.widget.FILL_RECT, {
          x: SW / 2 + side * 22 - 12,
          y: SH / 2 - 40,
          w: 24,
          h: 80,
          radius: 6,
          color: 0xffffff,
        }),
      )
      this.markPaused(false)
      if (ROUND) {
        this.ring = hmUI.createWidget(hmUI.widget.ARC, {
          x: 3,
          y: 3,
          w: SW - 6,
          h: SH - 6,
          start_angle: -90,
          end_angle: -90,
          color: 0xff4a6e,
          line_width: 6,
        })
      } else {
        this.bar = hmUI.createWidget(hmUI.widget.FILL_RECT, { x: 0, y: SH - 6, w: 0, h: 6, color: 0xff4a6e })
      }
      this.hideTitle()

      // tap — pause, long press — quality. A transparent full-screen button:
      // the IMG widget itself gets no touch events (checked in the emulator)
      hmUI.createWidget(hmUI.widget.BUTTON, {
        x: 0,
        y: 0,
        w: SW,
        h: SH,
        normal_src: 'px.png',
        press_src: 'px.png',
        click_func: () => {
          if (this.longPressed) {
            this.longPressed = false
            return
          }
          this.togglePause()
        },
        longpress_func: () => {
          this.longPressed = true
          this.cycleQuality()
        },
      })

      onGesture({
        callback: (event) => {
          if (event === GESTURE_UP) {
            this.go(1)
            return true
          }
          if (event === GESTURE_DOWN) {
            this.go(-1)
            return true
          }
          return false
        },
      })
      this.crown = 0
      try {
        onDigitalCrown({
          callback: (key, degree) => {
            this.crown += degree
            if (Math.abs(this.crown) >= 40) {
              this.go(this.crown > 0 ? 1 : -1)
              this.crown = 0
            }
          },
        })
      } catch (e) {}

      this.player = createPlayer(this.img, {
        onStatus: (phase, p) => {
          if (phase === 'prepare') this.say('Готовлю кадры ' + Math.round(p * 100) + '%')
          else if (phase === 'play' || phase === 'wait-audio') this.say('')
        },
        onProgress: (p) => this.progress(p),
        onLoop: () => {
          this.progress(0)
          // watched twice — move to the next new one if it is already on the watch
          if (++this.loops >= 2 && this.nextHere()) this.go(1)
        },
        onError: () => this.say('Видео повреждено'),
      })
      this.loadFeed()
    },

    // ───── feed ─────

    loadFeed() {
      this.say('Загружаю мемы…')
      // the server drops the most recently seen, the rest is filtered here
      const seen = this.seen.slice(-60).join(',')
      this.ask('list', { page: this.page, q: this.q, seen }, 30000)
        .then((res) => {
          const items = ((res && res.items) || []).filter((it) => this.seen.indexOf(it.id) < 0)
          this.nextPage = res.next || 0
          if (!items.length) {
            if (this.nextPage) {
              this.page = this.nextPage
              this.loadFeed()
              return
            }
            throw new Error('Новых мемов пока нет — загляните позже')
          }
          this.items = this.items.concat(items)
          this.open(this.idx)
        })
        .catch((e) => {
          console.log('zv: feed', String(e && e.message))
          this.offline = true
          this.say('Нет связи с сервером мемов:\n' + ((e && e.message) || '') + '\nПоказываю встроенный ролик')
          setTimeout(() => this.playDemo(), 1800)
        })
    },

    playDemo() {
      if (this.closed) return
      this.current = 'demo'
      this.showTitle('Демо: ролик из пакета приложения')
      try {
        this.player.load('demo.zv', true, 'demo')
      } catch (e) {
        this.say('Не открыть демо: ' + e.message)
      }
    },

    go(step) {
      if (this.offline) {
        this.loadFeed()
        return
      }
      const i = this.idx + step
      if (i < 0 || !this.items.length) return
      if (i >= this.items.length) {
        if (this.nextPage) {
          this.page = this.nextPage
          this.nextPage = 0
          this.idx = i
          this.player.unload()
          this.loadFeed()
        }
        return
      }
      this.idx = i
      this.open(i)
    },

    key(item) {
      return item.id + '-' + this.q
    },

    open(i) {
      const item = this.items[i]
      if (!item) return
      const key = this.key(item)
      this.current = key
      this.player.unload()
      this.markPaused(false)
      this.progress(0)
      this.loops = 0
      this.img.setProperty(hmUI.prop.SRC, '')
      this.showTitle(item.title)
      if (this.playIfHere(key)) return
      this.say('Сервер сжимает ролик…')
      this.fetchVideo(item, key)
    },

    /** Ask the phone to deliver a clip; the answer comes once the file is on the watch. */
    fetchVideo(item, key) {
      if (this.requested && this.requested[key]) return
      this.requested = this.requested || {}
      this.requested[key] = true
      this.ask('get', { id: item.id, q: this.q }, GET_TIMEOUT).then(
        (res) => {
          delete this.requested[key]
          if (res && res.file) this.remember(key, res.file)
          if (this.current === key) this.whenArrived(key, 0)
        },
        (e) => {
          delete this.requested[key]
          if (this.current === key) this.say((e && e.message) || 'Не получилось загрузить')
        },
      )
    },

    /** The file may not be closed yet when the phone answers — retry a few times. */
    whenArrived(key, tries) {
      if (this.closed || this.current !== key) return
      if (this.playIfHere(key)) return
      if (tries < 20) setTimeout(() => this.whenArrived(key, tries + 1), 500)
      else this.say('Ролик не дошёл — свайпните ещё раз')
    },

    playIfHere(key) {
      const f = this.files[key]
      if (!f || !fsx.size('download/' + f.name)) return false
      f.at = Date.now()
      save('files', this.files)
      this.markSeen(key.replace(/-(low|mid|high)$/, ''))
      try {
        this.player.load('download/' + f.name, false, key)
      } catch (e) {
        console.log('zv: open', String(e))
        delete this.files[key]
        return false
      }
      this.prefetch()
      return true
    },

    markSeen(id) {
      if (this.seen.indexOf(id) >= 0) return
      this.seen.push(id)
      if (this.seen.length > 400) this.seen = this.seen.slice(-400)
      save('seen', this.seen)
    },

    /** Is the next clip already on the watch? */
    nextHere() {
      const next = this.items[this.idx + 1]
      if (!next) return false
      const f = this.files[this.key(next)]
      return !!(f && fsx.size('download/' + f.name))
    },

    /** The next clip travels to the watch while this one plays. */
    prefetch() {
      const next = this.items[this.idx + 1]
      if (!next) return
      const key = this.key(next)
      const f = this.files[key]
      if (f && fsx.size('download/' + f.name)) return
      this.fetchVideo(next, key)
    },

    remember(key, name) {
      this.files[key] = { name, at: Date.now() }
      // old clips are deleted from the watch: keep the last KEEP_FILES
      const keys = Object.keys(this.files).sort((a, b) => this.files[b].at - this.files[a].at)
      for (let i = KEEP_FILES; i < keys.length; i++) {
        fsx.remove('download/' + this.files[keys[i]].name)
        delete this.files[keys[i]]
      }
      save('files', this.files)
    },

    // ───── phone link ─────

    ask(method, params, timeout) {
      return new Promise((resolve, reject) => {
        let done = false
        const timer = setTimeout(() => {
          if (done) return
          done = true
          reject(new Error('Телефон не отвечает. Откройте Zepp на телефоне'))
        }, timeout)
        let pending
        try {
          pending = this.request({ method, params }, { timeout })
        } catch (e) {
          clearTimeout(timer)
          reject(new Error('Нет связи с телефоном'))
          return
        }
        pending.then(
          (res) => {
            if (done) return
            done = true
            clearTimeout(timer)
            const out = res && res.data !== undefined && !res.items && !res.file ? res.data : res
            if (!out || out.error) reject(new Error((out && out.error) || 'Пустой ответ'))
            else resolve(out)
          },
          () => {
            if (done) return
            done = true
            clearTimeout(timer)
            reject(new Error('Нет связи с телефоном'))
          },
        )
      })
    },

    onCall(msg) {
      const m = msg && msg.params && !msg.ev ? msg.params : msg
      if (!m || m.ev !== 'prog') return
      const item = this.items[this.idx]
      if (!item || item.id !== m.id || this.player.phase !== 'idle') return
      const pct = Math.round((m.p || 0) * 100)
      if (m.stage === 'server') this.say('Сервер сжимает ролик ' + pct + '%')
      else if (m.stage === 'load') this.say('Телефон скачивает…')
      else if (m.stage === 'send') {
        const speed = m.bps ? '\n' + Math.round(m.bps / 1024) + ' КБ/с' : ''
        this.say('Передаю на часы ' + pct + '%' + speed)
      }
    },

    onReceivedFile(file) {
      if (!file) return
      let params = file.params || {}
      if (typeof params === 'string') {
        try {
          params = JSON.parse(params)
        } catch (e) {
          params = {}
        }
      }
      const key = params.k
      if (!key) return
      const name = String(file.fileName || file.filePath || '').replace(/^.*\//, '') || 'zv_' + key + '.zv'
      const done = () => {
        this.remember(key, name)
        if (this.current === key && this.player.phase === 'idle') this.whenArrived(key, 0)
      }
      if (file.readyState === 'transferred') {
        done()
        return
      }
      try {
        file.on('change', (e) => {
          if (e && e.data && e.data.readyState === 'transferred') done()
        })
      } catch (e) {}
    },

    // ───── screen ─────

    togglePause() {
      this.markPaused(this.player.togglePause())
    },

    markPaused(on) {
      this.pauseMark.forEach((w) => w.setProperty(hmUI.prop.VISIBLE, !!on))
    },

    cycleQuality() {
      const i = QUALITY.indexOf(this.q)
      this.q = QUALITY[(i + 1) % QUALITY.length]
      save('q', this.q)
      this.showTitle('Качество: ' + QNAME[this.q] + '\n(со следующего ролика)')
    },

    say(text) {
      if (this.closed) return
      if (text === this.statusText) return
      this.statusText = text
      this.status.setProperty(hmUI.prop.TEXT, text || '')
      this.status.setProperty(hmUI.prop.VISIBLE, !!text)
      this.statusBg.setProperty(hmUI.prop.VISIBLE, !!text)
    },

    showTitle(text) {
      if (this.titleTimer) clearTimeout(this.titleTimer)
      this.title.setProperty(hmUI.prop.TEXT, text || '')
      this.title.setProperty(hmUI.prop.VISIBLE, !!text)
      this.shade.setProperty(hmUI.prop.VISIBLE, !!text)
      this.titleTimer = setTimeout(() => this.hideTitle(), 3500)
    },

    hideTitle() {
      this.titleTimer = null
      if (this.closed) return
      this.title.setProperty(hmUI.prop.VISIBLE, false)
      this.shade.setProperty(hmUI.prop.VISIBLE, false)
    },

    progress(p) {
      const v = Math.max(0, Math.min(1, p || 0))
      if (this.ring) {
        const end = -90 + Math.round(360 * v)
        if (end === this.ringEnd) return
        this.ringEnd = end
        this.ring.setProperty(hmUI.prop.MORE, { start_angle: -90, end_angle: end })
      } else if (this.bar) {
        this.bar.setProperty(hmUI.prop.W, Math.round(SW * v))
      }
    },

    onDestroy() {
      this.closed = true
      if (this.titleTimer) clearTimeout(this.titleTimer)
      if (this.player) this.player.unload()
      audio.stopNow()
      try {
        offGesture()
      } catch (e) {}
      try {
        offDigitalCrown()
      } catch (e) {}
      try {
        resetDropWristScreenOff()
      } catch (e) {}
      try {
        resetPageBrightTime()
      } catch (e) {}
    },
  }),
)
