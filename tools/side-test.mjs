// Test the phone side service without a watch: node tools/side-test.mjs [server]
// Mocks zml and the phone system APIs, runs list and get against a server
// (local http://127.0.0.1:8791 by default; for the PHP proxy pass ".../zv/?p=").
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const server = process.argv[2] || 'http://127.0.0.1:8791'
const src = readFileSync(new URL('../watch/app-side/index.js', import.meta.url), 'utf8').replace(/^import .*$/m, '')
const dir = mkdtempSync(join(tmpdir(), 'zv-side-'))
const calls = []
let svc = null
const settingsLib = { getItem: (k) => (k === 'server' ? server : null) }
function BaseSideService(def) {
  return Object.assign({}, def, {
    call: (m) => calls.push(m),
    download(url, { filePath }) {
      const task = {}
      fetch(url).then(async (r) => {
        if (!r.ok) return task.onFail && task.onFail({ status: r.status })
        writeFileSync(join(dir, filePath), Buffer.from(await r.arrayBuffer()))
        task.onSuccess && task.onSuccess({ filePath: 'data://download/' + filePath })
      })
      return task
    },
  })
}
function AppSideService(o) {
  svc = o
}
// Zepp side-service fetch: object → {status, body}
const zfetch = async (o) => {
  const r = await fetch(o.url, { method: o.method })
  return { status: r.status, body: await r.text() }
}
const transferFile = {
  getOutbox: () => ({
    enqueueFile(path, params) {
      const handlers = {}
      setTimeout(() => {
        handlers.progress && handlers.progress({ data: { loadedSize: 50, fileSize: 100 } })
        handlers.change && handlers.change({ data: { readyState: 'transferred' } })
      }, 50)
      return { on: (ev, fn) => (handlers[ev] = fn) }
    },
  }),
}
new Function('BaseSideService', 'settingsLib', 'AppSideService', 'fetch', 'transferFile', src)(
  BaseSideService,
  settingsLib,
  AppSideService,
  zfetch,
  transferFile,
)
svc.onInit()
const ask = (method, params) => new Promise((res) => svc.onRequest({ method, params }, (e, d) => res(d)))
const list = await ask('list', { page: 1 })
console.log('list:', list.error || list.items.length + ' clips, first ' + JSON.stringify(list.items[0]))
const t = Date.now()
const got = await ask('get', { id: list.items[0].id, q: 'mid' })
console.log('get:', JSON.stringify(got), Date.now() - t, 'ms')
console.log('messages to the watch:', calls.map((c) => c.stage + ':' + Math.round((c.p || 0) * 100)).join(' '))
