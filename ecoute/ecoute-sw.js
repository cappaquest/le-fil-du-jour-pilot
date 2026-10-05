import { resolveLfjScope, cachePrefixes, rangedResponse } from './ecoute-cache.mjs'

const scopeInfo = (() => {
  try {
    const scope = resolveLfjScope(self.registration.scope)
    const script = new URL(self.location.href)
    const registration = new URL(self.registration.scope)
    if (registration.origin !== self.location.origin || script.origin !== self.location.origin
      || script.pathname !== `${scope}ecoute-sw.js` || script.search || script.hash) return null
    return { scope, baseUrl: registration.href, ...cachePrefixes(scope) }
  } catch { return null }
})()
const safeScope = Boolean(scopeInfo)
const baseUrl = scopeInfo?.baseUrl
const insideScope = (url) => safeScope && url.origin === self.location.origin
  && url.pathname.startsWith(scopeInfo.scope)

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    if (!safeScope) throw new Error('LFJ_SCOPE_REQUIRED')
    const inventoryResponse = await fetch(new URL('ecoute-shell.json', baseUrl), { cache: 'no-store' })
    if (inventoryResponse.status !== 200 || inventoryResponse.headers.has('Content-Range')) throw new Error('SHELL_REQUIRED')
    const inventory = await inventoryResponse.clone().json()
    if (inventory.base !== scopeInfo.scope || !/^[a-f0-9]+$/.test(inventory.buildId)
      || !Array.isArray(inventory.urls) || !inventory.urls.length) throw new Error('INVALID_SHELL')
    const urls = inventory.urls.map((path) => {
      const url = new URL(path, baseUrl)
      if (!insideScope(url) || url.search || url.hash) throw new Error('SHELL_OUTSIDE_LFJ')
      return url
    })
    const resources = await Promise.all(urls.map(async (url) => {
      const response = await fetch(url, { cache: 'reload' })
      if (response.status !== 200 || response.headers.has('Content-Range')) throw new Error('INCOMPLETE_SHELL')
      return [url.href, response]
    }))
    const name = `${scopeInfo.shellPrefix}${inventory.buildId}`
    const cache = await caches.open(name)
    try {
      for (const [url, response] of resources) await cache.put(url, response)
      await cache.put(new URL('ecoute-shell.json', baseUrl).href, inventoryResponse)
    } catch (error) {
      await caches.delete(name)
      throw error
    }
  })())
})

self.addEventListener('activate', (event) => {
  if (safeScope) event.waitUntil(self.clients.claim())
  // Retain earlier shells and downloads: older open pages must keep working.
})

self.addEventListener('message', (event) => {
  // Only an explicit, idle-page update action may activate a waiting version.
  if (safeScope && event.data?.type === 'LFJ_ACTIVATE_IDLE_UPDATE') self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (!safeScope || request.method !== 'GET' || !insideScope(url)) return
  event.respondWith((async () => {
    // Integrity checks and repair downloads must see the server, not a damaged cache.
    if (request.cache === 'no-store') return fetch(request)
    const names = await caches.keys()
    if (url.pathname.startsWith(`${scopeInfo.scope}ecoute/`)) {
      for (const name of names.filter((item) => item.startsWith(scopeInfo.packPrefix))) {
        const cache = await caches.open(name)
        const response = await cache.match(url.href)
        if (response?.headers.has('X-LFJ-Verified')) return rangedResponse(response, request.headers.get('Range'))
        if (response?.status === 200 && !request.headers.has('Range')) return response
      }
    }
    try { return await fetch(request) } catch {
      const key = request.mode === 'navigate' ? new URL('index.html', baseUrl).href : url.href
      for (const name of names.filter((item) => item.startsWith(scopeInfo.shellPrefix)).reverse()) {
        const cache = await caches.open(name)
        const response = await cache.match(key)
        if (response) return response
      }
      return new Response('LFJ: dosya bu cihazda yok.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    }
  })())
})
