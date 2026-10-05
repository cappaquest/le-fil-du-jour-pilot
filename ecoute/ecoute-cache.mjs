export const CACHE_PREFIX = 'lfj-pilot-ecoute-'
export const SHELL_PREFIX = `${CACHE_PREFIX}shell-`
export const PACK_PREFIX = `${CACHE_PREFIX}pack-`
export const LFJ_SCOPE = '/le-fil-du-jour-pilot/'
export const PREVIEW_SCOPE = '/le-fil-du-jour-pilot/ecoute/'

export function resolveLfjScope(baseUrlOrPath = LFJ_SCOPE) {
  if (typeof baseUrlOrPath !== 'string') throw new Error('INVALID_LFJ_SCOPE')
  let path = baseUrlOrPath
  if (!path.startsWith('/')) {
    // Validate the raw path too: URL normalization must not bless a ../ traversal.
    const raw = /^https?:\/\/[^/?#]+(\/[^?#]*)?$/.exec(path)
    if (!raw) throw new Error('INVALID_LFJ_SCOPE')
    const url = new URL(path)
    if (url.username || url.password || url.search || url.hash) throw new Error('INVALID_LFJ_SCOPE')
    path = raw[1] || '/'
  }
  if (![LFJ_SCOPE, PREVIEW_SCOPE].includes(path)) throw new Error('INVALID_LFJ_SCOPE')
  return path
}

export function cachePrefixes(baseUrlOrPath = LFJ_SCOPE) {
  const cachePrefix = resolveLfjScope(baseUrlOrPath) === PREVIEW_SCOPE ? 'lfj-preview-ecoute-' : CACHE_PREFIX
  return { cachePrefix, shellPrefix: `${cachePrefix}shell-`, packPrefix: `${cachePrefix}pack-` }
}

function packageUrl(path, baseUrl) {
  const scope = resolveLfjScope(baseUrl)
  const url = new URL(path, baseUrl)
  if (url.origin !== new URL(baseUrl).origin || !url.pathname.startsWith(scope)
    || url.search || url.hash) throw new Error('ASSET_OUTSIDE_LFJ_SCOPE')
  return url.href
}

export function packCacheName(episodeId, version, sha256, baseUrl = LFJ_SCOPE) {
  if (![episodeId, version].every((part) => /^[A-Za-z0-9-]+$/.test(part))
    || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('INVALID_PACKAGE_KEY')
  return `${cachePrefixes(baseUrl).packPrefix}${episodeId}-${version}-${sha256}`
}

export async function sha256Hex(buffer, cryptoApi = crypto) {
  const digest = await cryptoApi.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function verifyAudioBytes(buffer, asset, cryptoApi) {
  if (buffer.byteLength !== asset.bytes) throw new Error('AUDIO_SIZE_MISMATCH')
  if (await sha256Hex(buffer, cryptoApi) !== asset.sha256) throw new Error('AUDIO_HASH_MISMATCH')
  return buffer
}

export async function readFullResponse(response) {
  if (response.status !== 200 || response.headers.has('Content-Range')) throw new Error('FULL_DOWNLOAD_REQUIRED')
  return response.arrayBuffer()
}

export function receiptUrl(baseUrl, asset) {
  return packageUrl(`ecoute/offline/${asset.episodeId}/${asset.contentVersion}/${asset.sha256}.json`, baseUrl)
}

export async function readVerifiedPack({ cacheStorage, baseUrl, asset, cryptoApi, validate }) {
  const name = packCacheName(asset.episodeId, asset.contentVersion, asset.sha256, baseUrl)
  if (!await cacheStorage.has(name)) return null
  const cache = await cacheStorage.open(name)
  const receiptResponse = await cache.match(receiptUrl(baseUrl, asset))
  const audioResponse = await cache.match(packageUrl(asset.url, baseUrl))
  const cuesResponse = await cache.match(packageUrl(asset.cuesUrl, baseUrl))
  if (!receiptResponse || !audioResponse || !cuesResponse) return null
  try {
    const receipt = await receiptResponse.json()
    validate(receipt.cues)
    const cachedCues = JSON.parse(new TextDecoder().decode(await readFullResponse(cuesResponse)))
    validate(cachedCues)
    if (JSON.stringify(cachedCues) !== JSON.stringify(receipt.cues)) return null
    const buffer = await readFullResponse(audioResponse)
    await verifyAudioBytes(buffer, asset, cryptoApi)
    return { ...receipt, cacheName: name }
  } catch {
    return null
  }
}

export async function downloadVerifiedPack({ cacheStorage, fetcher, baseUrl, asset, episode, cryptoApi, validate, signal }) {
  const existing = await readVerifiedPack({ cacheStorage, baseUrl, asset, cryptoApi, validate })
  if (existing) return existing
  const audioUrl = packageUrl(asset.url, baseUrl)
  const cuesUrl = packageUrl(asset.cuesUrl, baseUrl)
  const audioResponse = await fetcher(audioUrl, { cache: 'no-store', signal })
  const buffer = await readFullResponse(audioResponse)
  await verifyAudioBytes(buffer, asset, cryptoApi)
  const cuesResponse = await fetcher(cuesUrl, { cache: 'no-store', signal })
  const cues = JSON.parse(new TextDecoder().decode(await readFullResponse(cuesResponse)))
  validate(cues)
  const name = packCacheName(asset.episodeId, asset.contentVersion, asset.sha256, baseUrl)
  const cache = await cacheStorage.open(name)
  const receipt = { episode, asset, cues, downloadedAt: new Date().toISOString() }
  try {
    await cache.put(audioUrl, new Response(buffer, { headers: {
      'Content-Type': 'audio/mpeg', 'Content-Length': String(buffer.byteLength),
      'X-LFJ-Verified': asset.sha256,
    } }))
    await cache.put(cuesUrl, new Response(JSON.stringify(cues), { headers: { 'Content-Type': 'application/json' } }))
    // Written last: a partial transaction never advertises readiness.
    await cache.put(receiptUrl(baseUrl, asset), new Response(JSON.stringify(receipt), { headers: { 'Content-Type': 'application/json' } }))
  } catch (error) {
    await cacheStorage.delete(name)
    throw error
  }
  return { ...receipt, cacheName: name }
}

export async function removePack(cacheStorage, asset, baseUrl = LFJ_SCOPE) {
  return cacheStorage.delete(packCacheName(asset.episodeId, asset.contentVersion, asset.sha256, baseUrl))
}

export async function cleanupOwnedCaches(cacheStorage, keep = [], baseUrl = LFJ_SCOPE) {
  const { cachePrefix } = cachePrefixes(baseUrl)
  const names = await cacheStorage.keys()
  for (const name of names) {
    if (name.startsWith(cachePrefix) && !keep.includes(name)) await cacheStorage.delete(name)
  }
}

export async function checkShell(cacheStorage, baseUrl, activeAssets = []) {
  const scope = resolveLfjScope(baseUrl)
  const { shellPrefix } = cachePrefixes(baseUrl)
  const names = (await cacheStorage.keys()).filter((name) => name.startsWith(shellPrefix))
  for (const name of names) {
    const cache = await cacheStorage.open(name)
    const response = await cache.match(new URL('ecoute-shell.json', baseUrl).href)
    if (!response) continue
    try {
      const inventory = await response.json()
      if (inventory.base !== scope || !Array.isArray(inventory.urls) || !inventory.urls.length) continue
      const urls = inventory.urls.map((path) => new URL(path, baseUrl).href)
      if (activeAssets.some((url) => !urls.includes(url))) continue
      if (urls.some((url) => new URL(url).origin !== new URL(baseUrl).origin
        || !new URL(url).pathname.startsWith(scope)
        || new URL(url).search || new URL(url).hash)) continue
      const entries = await Promise.all(urls.map((url) => cache.match(url)))
      if (entries.every((entry) => entry?.status === 200 && !entry.headers.has('Content-Range'))) return { cacheName: name, inventory }
    } catch { /* An incomplete shell is not offline-ready. */ }
  }
  return null
}

export async function rangedResponse(response, range) {
  if (!range) return response
  const buffer = await response.arrayBuffer()
  const length = buffer.byteLength
  const match = /^bytes=(\d*)-(\d*)$/.exec(range)
  let start = match?.[1] ? Number(match[1]) : null
  let end = match?.[2] ? Number(match[2]) : null
  if (start === null && end !== null && end > 0) {
    start = Math.max(0, length - end)
    end = length - 1
  } else if (start !== null && end === null) end = length - 1
  if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || start >= length || end < start) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${length}` } })
  }
  end = Math.min(end, length - 1)
  return new Response(buffer.slice(start, end + 1), { status: 206, headers: {
    'Content-Type': response.headers.get('Content-Type') || 'audio/mpeg',
    'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes',
    'Content-Range': `bytes ${start}-${end}/${length}`,
  } })
}
