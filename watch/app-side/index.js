/**
 * Phone side service: the meme feed and delivery of clips to the watch.
 *
 * The watch asks:
 *   list {page, q}  → {items: [{id, title, dur}], next}
 *   get  {id, q}    → {file}  — once the .zv file is on the watch
 * Along the way the phone sends {ev: 'prog', id, stage, p}: stage = server
 * (the server encodes), load (the phone downloads), send (Bluetooth transfer).
 *
 * Videos are encoded by the server (server/app.py): the phone side has neither
 * ffmpeg nor file writing — a file reaches the watch only as "download a URL →
 * transfer". Deliveries go one at a time: there is one Bluetooth link, and the
 * watch asks for the next clip in advance while the current one plays.
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
      this.queue = Promise.resolve()
      this.inflight = {} // id-q → Promise
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
        task.onSuccess = (data) => resolve((data && data.filePath) || 'data://download/' + fileName)
        task.onFail = () => reject(new Error('Телефон не смог скачать ролик'))
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

    /** One clip to the watch: server encodes → phone downloads → Bluetooth. */
    async deliver(id, q) {
      const key = id + '-' + q
      let last = -1
      for (let i = 0; ; i++) {
        const st = await this.api('/v1/prepare', { id, q }, 15000)
        if (st.state === 'ready') break
        if (st.p !== last) {
          last = st.p
          this.tell({ ev: 'prog', id, stage: 'server', p: (st.p || 0) / 100 })
        }
        if (i > 150) throw new Error('Сервер сжимает слишком долго')
        await sleep(1000)
      }
      this.tell({ ev: 'prog', id, stage: 'load', p: 0 })
      const name = 'zv_' + key + '.zv'
      const path = await this.fetchFile(this.apiUrl('/v1/f/' + key + '.zv'), name)
      this.tell({ ev: 'prog', id, stage: 'send', p: 0 })
      let at = 0
      const t0 = Date.now()
      await this.sendToWatch(path, { k: key, id, q }, (done, total) => {
        const now = Date.now()
        if (now - at < 400) return
        at = now
        this.tell({ ev: 'prog', id, stage: 'send', p: done / total, bps: (done / Math.max(1, now - t0)) * 1000 })
      })
      log('delivered', key, Date.now() - t0, 'ms')
      return { file: name, key }
    },

    getVideo(id, q) {
      const key = id + '-' + q
      if (this.inflight[key]) return this.inflight[key]
      // one delivery at a time
      const p = (this.queue = this.queue.catch(() => {}).then(() => this.deliver(id, q)))
      this.inflight[key] = p
      p.then(
        () => delete this.inflight[key],
        () => delete this.inflight[key],
      )
      return p
    },

    onRequest(req, res) {
      const method = req && req.method
      const params = (req && req.params) || {}
      const q = ['low', 'mid', 'high'].indexOf(params.q) >= 0 ? params.q : 'mid'
      let job
      if (method === 'list') job = this.api('/v1/list', { page: params.page || 1, q, seen: String(params.seen || '') })
      else if (method === 'get') job = this.getVideo(String(params.id || ''), q)
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
