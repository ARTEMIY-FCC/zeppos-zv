/**
 * Phone side service: the meme feed and delivery of clips to the watch.
 *
 * The watch asks:
 *   list {page, q}  → {items: [{id, title, dur}], next}
 *   get  {id, q}    → {file}  — once the .zv file is on the watch
 *   (params.cur = 0 marks a prefetch of the next clip; a new current request
 *   cancels every other clip that has not reached the Bluetooth queue yet)
 * Along the way the phone sends {ev: 'prog', id, q, stage, p}: stage = queue
 * (waiting for a free encoder), server (encoding), load (the phone downloads),
 * send (Bluetooth transfer).
 *
 * Videos are encoded by the server (server/app.py): the phone side has neither
 * ffmpeg nor file writing — a file reaches the watch only as "download a URL →
 * transfer". The watch asks for the next clip in advance while the current one
 * plays.
 * Error messages are shown on the watch, so they are in Russian.
 */
import { BaseSideService, settingsLib } from '@zeppos/zml/base-side'

// Default server; another one can be set in the app settings (key "server")
const DEFAULT_SERVER = 'https://5dev.ru/zv/?p='
const TRANSFER_TIMEOUT = 180000

function log() {
  try {
    console.log.apply(console, ['[zv]'].concat(Array.prototype.slice.call(arguments)))
  } catch (e) {}
}

function parseBody(body) {
  if (body === undefined || body === null) return null
  if (typeof body === 'string') {
    try {
      return JSON.parse(body)
    } catch (e) {
      return null
    }
  }
  return body
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

AppSideService(
  BaseSideService({
    onInit() {
      this.jobs = {} // id-q → { id, q, key, cur, cancelled, sending, promise }
      log('side init')
    },

    serverBase() {
      let s = ''
      try {
        s = settingsLib.getItem('server') || ''
      } catch (e) {}
      return String(s || DEFAULT_SERVER).trim()
    },

    /** API URL: both a direct server (…/v1/list?…) and the PHP proxy (…?p=/v1/list&…). */
    apiUrl(path, query) {
      const base = this.serverBase()
      const q = Object.keys(query || {})
        .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(query[k]))
        .join('&')
      // path left unencoded: Zepp on iPhone encodes the URL once more, turning %2F into %252F
      if (base.indexOf('?p=') >= 0) return base + path + (q ? '&' + q : '')
      return base.replace(/\/+$/, '') + path + (q ? '?' + q : '')
    },

    async api(path, query, timeout) {
      let res
      const opts = { url: this.apiUrl(path, query), method: 'GET', timeout: timeout || 20000 }
      try {
        res = typeof fetch === 'function' ? await fetch(opts) : await this.fetch(opts)
      } catch (e) {
        throw new Error('Сервер не отвечает')
      }
      const data = parseBody(res && res.body)
      if (!data) throw new Error('Сервер ответил непонятно')
      if (data.state === 'error' || (data.err && !data.items)) throw new Error(data.err || 'Ошибка сервера')
      return data
    },

    tell(msg) {
      try {
        this.call(msg)
      } catch (e) {}
    },

    fetchFile(url, fileName) {
      return new Promise((resolve, reject) => {
        let task = null
        try {
          task = this.download(url, { filePath: fileName, timeout: 60000 })
        } catch (e) {
          reject(e)
          return
        }
        if (!task) {
          reject(new Error('Телефон не смог скачать'))
          return
        }
        // the downloader may never call back: do not let a delivery hang forever
        const timer = setTimeout(() => reject(new Error('Телефон не смог скачать ролик')), 90000)
        task.onSuccess = (data) => {
          clearTimeout(timer)
          resolve((data && data.filePath) || 'data://download/' + fileName)
        }
        task.onFail = () => {
          clearTimeout(timer)
          reject(new Error('Телефон не смог скачать ролик'))
        }
      })
    },

    /**
     * zml 0.0.38+ uses transferFile.outbox, while firmwares expose it via
     * getOutbox(): try both, and only then zml's sendFile.
     */
    enqueueFile(path, params) {
      if (typeof transferFile !== 'undefined' && transferFile) {
        if (typeof transferFile.getOutbox === 'function') return transferFile.getOutbox().enqueueFile(path, params)
        if (transferFile.outbox && typeof transferFile.outbox.enqueueFile === 'function') {
          return transferFile.outbox.enqueueFile(path, params)
        }
      }
      return this.sendFile(path, params)
    },

    sendToWatch(path, params, onProgress) {
      return new Promise((resolve, reject) => {
        let file
        try {
          file = this.enqueueFile(path, params)
        } catch (e) {
          reject(e)
          return
        }
        const timer = setTimeout(() => resolve(), TRANSFER_TIMEOUT)
        if (!file || typeof file.on !== 'function') {
          clearTimeout(timer)
          resolve()
          return
        }
        try {
          file.on('progress', (event) => {
            const d = (event && event.data) || {}
            if (d.fileSize && onProgress) onProgress(d.loadedSize || 0, d.fileSize)
          })
        } catch (e) {}
        file.on('change', (event) => {
          const state = event && event.data && event.data.readyState
          if (state === 'transferred') {
            clearTimeout(timer)
            resolve()
          } else if (state === 'error') {
            clearTimeout(timer)
            reject(new Error('Не получилось передать на часы'))
          }
        })
      })
    },

    /**
     * One clip to the watch: server encodes → phone downloads → Bluetooth.
     * Jobs run side by side (most of the time is spent waiting for the server);
     * a job the watch no longer needs stops at the next checkpoint, so stale
     * clips never get into the Bluetooth queue.
     */
    async deliver(job) {
      const { id, q, key } = job
      const check = () => {
        if (job.cancelled) throw new Error('отменено')
      }
      let last = ''
      for (let i = 0; ; i++) {
        check()
        const st = await this.api('/v1/prepare', { id, q, prio: job.cur ? 0 : 1 }, 15000)
        if (st.state === 'ready') break
        const mark = (st.queued ? 'q' : 's') + (st.p || 0)
        if (mark !== last && job.cur) {
          last = mark
          this.tell({ ev: 'prog', id, q, stage: st.queued ? 'queue' : 'server', p: (st.p || 0) / 100 })
        }
        if (i > 400) throw new Error('Сервер сжимает слишком долго')
        await sleep(1000)
      }
      check()
      if (job.cur) this.tell({ ev: 'prog', id, q, stage: 'load', p: 0 })
      const name = 'zv_' + key + '.zv'
      const path = await this.fetchFile(this.apiUrl('/v1/f/' + key + '.zv'), name)
      check()
      job.sending = true
      this.tell({ ev: 'prog', id, q, stage: 'send', p: 0 })
      let at = 0
      const t0 = Date.now()
      await this.sendToWatch(path, { k: key, id, q }, (done, total) => {
        const now = Date.now()
        if (now - at < 400) return
        at = now
        this.tell({ ev: 'prog', id, q, stage: 'send', p: done / total, bps: (done / Math.max(1, now - t0)) * 1000 })
      })
      log('delivered', key, Date.now() - t0, 'ms')
      return { file: name, key }
    },

    /** cur — the clip the watch is waiting for right now (not a prefetch). */
    getVideo(id, q, cur) {
      const key = id + '-' + q
      if (cur) {
        // the person moved on: every other clip not yet on its way is stale
        for (const k in this.jobs) if (k !== key && !this.jobs[k].sending) this.jobs[k].cancelled = true
      }
      let job = this.jobs[key]
      if (job) {
        // asked again (e.g. swiped back) before the stale job noticed — keep it running
        if (cur) {
          job.cur = true
          job.cancelled = false
        }
        return job.promise
      }
      job = this.jobs[key] = { id, q, key, cur: !!cur, cancelled: false, sending: false }
      const done = () => {
        if (this.jobs[key] === job) delete this.jobs[key]
      }
      job.promise = this.deliver(job)
      job.promise.then(done, done)
      return job.promise
    },

    onRequest(req, res) {
      const method = req && req.method
      const params = (req && req.params) || {}
      const q = ['low', 'mid', 'high'].indexOf(params.q) >= 0 ? params.q : 'mid'
      let job
      if (method === 'list') job = this.api('/v1/list', { page: params.page || 1, q, seen: String(params.seen || '') })
      else if (method === 'get') job = this.getVideo(String(params.id || ''), q, params.cur !== 0)
      else job = Promise.reject(new Error('unknown method'))
      job.then(
        (out) => res(null, out),
        (e) => res(null, { error: String((e && e.message) || e) }),
      )
    },

    onRun() {},
    onDestroy() {},
  }),
)
