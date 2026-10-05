import { resolveLfjScope, cachePrefixes, rangedResponse } from './ecoute-cache.mjs'

// Replaced only in the compiled worker, from the original template and shell bundle.
const SHELL_BUILD_ID = 'd1c32fc498e5d586'
const compiledBuild = /^[a-f0-9]{16}$/.test(SHELL_BUILD_ID)
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
const shellName = safeScope && `${scopeInfo.shellPrefix}${SHELL_BUILD_ID}`
// A legacy active worker must not discover a waiting candidate's shell.
const pendingName = safeScope && `${scopeInfo.cachePrefix}pending-shell-${SHELL_BUILD_ID}`
const inventoryUrl = safeScope && new URL('ecoute-shell.json', baseUrl).href
const indexUrl = safeScope && new URL('index.html', baseUrl).href

function inventoryUrls(inventory) {
  if (inventory.base !== scopeInfo.scope || inventory.buildId !== SHELL_BUILD_ID
    || !Array.isArray(inventory.urls) || !inventory.urls.length) throw new Error('INVALID_SHELL')
  const urls = inventory.urls.map((path) => {
    const url = new URL(path, baseUrl)
    if (!insideScope(url) || url.search || url.hash) throw new Error('SHELL_OUTSIDE_LFJ')
    return url.href
  })
  if (!urls.includes(indexUrl) || new Set(urls).size !== urls.length) throw new Error('INVALID_SHELL')
  return urls
}
const fullResponse = (response) => response?.status === 200 && !response.headers.has('Content-Range')
async function readCachedShell(cache) {
  const manifest = await cache.match(inventoryUrl)
  if (!fullResponse(manifest)) throw new Error('INCOMPLETE_SHELL')
  const resources = await Promise.all(inventoryUrls(await manifest.clone().json()).map(async (url) => {
    const response = await cache.match(url)
    if (!fullResponse(response)) throw new Error('INCOMPLETE_SHELL')
    return [url, response]
  }))
  return { manifest, resources }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    if (!safeScope) throw new Error('LFJ_SCOPE_REQUIRED')
    if (!compiledBuild) throw new Error('SHELL_BUILD_ID_REQUIRED')
    const inventoryResponse = await fetch(new URL('ecoute-shell.json', baseUrl), { cache: 'no-store' })
    if (!fullResponse(inventoryResponse)) throw new Error('SHELL_REQUIRED')
    const inventory = await inventoryResponse.clone().json()
    const urls = inventoryUrls(inventory)
    const resources = await Promise.all(urls.map(async (url) => {
      const response = await fetch(url, { cache: 'reload' })
      if (!fullResponse(response)) throw new Error('INCOMPLETE_SHELL')
      return [url, response]
    }))
    await caches.delete(pendingName)
    const cache = await caches.open(pendingName)
    try {
      for (const [url, response] of resources) await cache.put(url, response)
      await cache.put(inventoryUrl, inventoryResponse)
    } catch (error) {
      await caches.delete(pendingName)
      throw error
    }
  })())
})

self.addEventListener('activate', (event) => {
  if (safeScope) event.waitUntil((async () => {
    if (!compiledBuild) throw new Error('SHELL_BUILD_ID_REQUIRED')
    let createdShell = false
    try {
      if (!await caches.has(pendingName)) throw new Error('INCOMPLETE_SHELL')
      const pending = await readCachedShell(await caches.open(pendingName))
      if (await caches.has(shellName)) {
        // Never overwrite or delete a shell that was already present before activation.
        await readCachedShell(await caches.open(shellName))
      } else {
        createdShell = true
        const active = await caches.open(shellName)
        for (const [url, response] of pending.resources) {
          if (url !== indexUrl) await active.put(url, response)
        }
        // Legacy workers can see active shell names: publish navigation only when complete.
        await active.put(inventoryUrl, pending.manifest)
        await active.put(indexUrl, pending.resources.find(([url]) => url === indexUrl)[1])
      }
      await caches.delete(pendingName)
      await self.clients.claim()
    } catch (error) {
      // Only this activation's newly-created candidate can be removed on failure.
      if (createdShell) await caches.delete(shellName)
      await caches.delete(pendingName)
      throw error
    }
  })())
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
      if (request.mode === 'navigate') {
        // A waiting/newer shell never supplies this active worker's offline page.
        if (compiledBuild && await caches.has(shellName)) {
          const active = await caches.open(shellName)
          const response = await active.match(indexUrl)
          if (fullResponse(response)) return response
        }
        return new Response('LFJ: uygulamanın çevrimdışı kopyası henüz hazır değil.', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      }
      const key = url.href
      for (const name of names.filter((item) => item.startsWith(scopeInfo.shellPrefix)).reverse()) {
        const cache = await caches.open(name)
        const response = await cache.match(key)
        if (response) return response
      }
      return new Response('LFJ: dosya bu cihazda yok.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    }
  })())
})
