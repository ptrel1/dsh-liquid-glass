// dsh-liquid-glass —— Node host half
// Serves the bundled preview wallpaper without exposing arbitrary filesystem paths.

import { readFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-liquid-glass'
/* 依赖声明放在 apply 内用 ctx.inject() —— 与 dsh-global-prompt 同构。
 * 模块级 inject 会让插件在服务就绪前就被调度，pluginConfig 拿不到已解析的 config。 */

/* 服务端持久化配置(20261027)
 *
 * 背景：插件原本把全部配置放在浏览器 localStorage（9 个键），
 * 导致每个客户端都要各配一遍、换浏览器/清缓存即丢失。
 *
 * 方案：用 Cordis 的 Config 声明 + settings.update 持久化到 profile 配置文件，
 * 所有客户端共享同一份。范式同 dsh-global-prompt（已验证可用）。
 *
 * 分层原则：
 *   - 服务端：effect / skin / blur / opacity 等「统一风格」项
 *   - 本地保留：自定义壁纸图片（background.custom*，体积大且与设备相关）
 */
const configSchema = z.object({
  effect: z.union([z.const('on'), z.const('off'), z.const('')]).default(''),
  skin: z.string().default('ice'),
  wallpaper: z.string().default('ice'),
  glassBlur: z.number().default(20),
  backgroundOpacity: z.number().default(0.88),
})

/* ⚠️ 不要给 schema 标 meta.volatile（20261027 实测踩坑）。
 * 起因：settings.update() 对未标 volatile 的字段报
 *   Plugin entry "dsh-liquid-glass" has no volatile fields
 * 但标法是陷阱 —— volatile 的语义是「整个 schema 作为一个不透明块」，
 * 标在 object schema 根上会让 schemastery 校验返回空对象：
 *   validate({}) = {"value":{}}      ← 默认值全被丢弃
 *   （未标时：{"value":{"a":"x","b":3}}）
 * 结果 apply 收到的 pluginConfig 恒为 {}，配置文件里的值被无声丢弃。
 *
 * ⇒ 放弃 settings.update，改为 host 侧自己管理 JSON 配置文件（见 CONFIG_FILE）。 */
export const Config = configSchema

// PUT 白名单：只接受这些键，防止客户端把响应里附带的服务端字段透传回来。
const CONFIG_KEYS = ['effect', 'skin', 'wallpaper', 'glassBlur', 'backgroundOpacity']
const pickConfigKeys = (input) => {
  const picked = {}
  if (input === null || typeof input !== 'object') return picked
  for (const k of CONFIG_KEYS) if (k in input) picked[k] = input[k]
  return picked
}

const CONFIG_ROUTE = '/api/dsh-liquid-glass/config'

/* 配置持久化：$DSH_HOME/liquid-glass/config.json
 *
 * 为什么不用 settings.update()：见上方 Config 注释 —— volatile 语义会清空
 * object schema 的默认值，导致 pluginConfig 恒为 {}。
 * 这里自己管一个 JSON 文件，不依赖 DSH 内部 API，升级不易坏。
 * 做法与 dsh-global-prompt 管理 AGENTS.md 同构。 */
export function configFilePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'liquid-glass', 'config.json')
}

async function readConfigFile() {
  try {
    const raw = await readFile(configFilePath(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (_error) {
    return {}  // 文件不存在 / 损坏 → 视为空，走默认值
  }
}

async function writeConfigFile(value) {
  const target = configFilePath()
  await mkdir(dirname(target), { recursive: true })
  const tmp = target + '.' + process.pid + '.' + Date.now() + '.tmp'
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(tmp, target)   // 原子替换
}

export const WALLPAPER_CONTENT_HASH = 'b209a409aea86fd6f572b3ac6025b8370e5e925533215a1414df8e432e5eab31'
export const WALLPAPER_HASH_PREFIX = WALLPAPER_CONTENT_HASH.slice(0, 16)
const WALLPAPER_PATH = new URL('./assets/liquid-glass-deepwater.jpg', import.meta.url)
export const WALLPAPER_ROUTE_LEGACY = '/dsh-liquid-glass/assets/liquid-glass-deepwater.jpg'
export const WALLPAPER_ROUTE = '/dsh-liquid-glass/assets/liquid-glass-deepwater.' + WALLPAPER_HASH_PREFIX + '.jpg'

export const ICE_WALLPAPER_CONTENT_HASH = 'f25a2221e0e8910761b52df1f43b77ec79c8f8b7e917fbdd5ce1696ba921b2eb'
export const ICE_WALLPAPER_HASH_PREFIX = ICE_WALLPAPER_CONTENT_HASH.slice(0, 16)
const ICE_WALLPAPER_PATH = new URL('./assets/liquid-glass-ice.jpg', import.meta.url)
export const ICE_WALLPAPER_ROUTE_LEGACY = '/dsh-liquid-glass/assets/liquid-glass-ice.jpg'
export const ICE_WALLPAPER_ROUTE = '/dsh-liquid-glass/assets/liquid-glass-ice.' + ICE_WALLPAPER_HASH_PREFIX + '.jpg'

export const WALLPAPER_ROUTES = [
  WALLPAPER_ROUTE,
  WALLPAPER_ROUTE_LEGACY,
  ICE_WALLPAPER_ROUTE,
  ICE_WALLPAPER_ROUTE_LEGACY,
]

function createStaticImageHandler({ read, contentHash, hashedRoute }) {
  let cachedBuffer = null
  let inflightRead = null
  const etag = '"' + contentHash + '"'

  function loadImage() {
    if (cachedBuffer !== null) return Promise.resolve(cachedBuffer)
    if (inflightRead !== null) return inflightRead
    inflightRead = Promise.resolve()
      .then(() => read())
      .then((buffer) => {
        cachedBuffer = buffer
        inflightRead = null
        return buffer
      }, (error) => {
        inflightRead = null
        throw error
      })
    return inflightRead
  }

  function requestPath(req) {
    const raw = req && (req.url || req.path) ? String(req.url || req.path) : hashedRoute
    return raw.split('?')[0]
  }

  function cacheControl(path) {
    if (path === hashedRoute) return 'public, max-age=31536000, immutable'
    return 'no-cache, max-age=0, must-revalidate'
  }

  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    try {
      const cached = await loadImage()
      const path = requestPath(req)
      const headers = {
        'content-type': 'image/jpeg',
        'cache-control': cacheControl(path),
        'etag': etag,
        'content-length': String(cached.byteLength),
      }
      const match = req.headers && (req.headers['if-none-match'] || req.headers['If-None-Match'])
      if (match === etag) {
        res.writeHead(304, headers)
        res.end()
        return
      }
      res.writeHead(200, headers)
      res.end(req.method === 'HEAD' ? undefined : cached)
    } catch (_error) {
      cachedBuffer = null
      inflightRead = null
      res.writeHead(404)
      res.end()
    }
  }
}

export function createWallpaperHandler(readWallpaper = () => readFile(WALLPAPER_PATH)) {
  return createStaticImageHandler({
    read: readWallpaper,
    contentHash: WALLPAPER_CONTENT_HASH,
    hashedRoute: WALLPAPER_ROUTE,
  })
}

export function createIceWallpaperHandler(readWallpaper = () => readFile(ICE_WALLPAPER_PATH)) {
  return createStaticImageHandler({
    read: readWallpaper,
    contentHash: ICE_WALLPAPER_CONTENT_HASH,
    hashedRoute: ICE_WALLPAPER_ROUTE,
  })
}

/* Config 字段的代码内默认值。
 * ⚠️ 不能依赖 schema 的 .default() —— 实测：当 profile 配置文件中没有该插件的
 * config 段时，apply 的第二参 pluginConfig 是 undefined，schema 默认值不会注入。
 * 因此这里显式给出默认值，pluginConfig 只作为「用户已配置过」时的覆盖层。 */
const CONFIG_DEFAULTS = {
  effect: '',
  skin: 'ice',
  wallpaper: 'ice',
  glassBlur: 20,
  backgroundOpacity: 0.88,
}

export function apply(ctx, pluginConfig) {
  const initial = { ...CONFIG_DEFAULTS, ...(pluginConfig || {}) }
  ctx.inject(['webServer', 'settings'], (sctx) => {
    install(sctx, initial, pluginConfig)
  })
}

function install(ctx, initial, pluginConfig) {
  let current = { ...initial }
  // 异步载入磁盘配置（不阻塞路由注册；载入完成后覆盖内存值与 initial）
  readConfigFile().then((saved) => {
    const merged = { ...CONFIG_DEFAULTS, ...(pluginConfig || {}) }
    for (const k of CONFIG_KEYS) if (saved[k] !== undefined) merged[k] = saved[k]
    current = merged
  }).catch(() => {})

  /* 配置读写 REST 路由。
   * GET  返回当前生效配置（供 client 初始化）
   * PUT  合并 patch 并持久化到 profile 配置（settings.update）
   * 说明：client 侧仍需保留 localStorage 作为「旧配置迁移」与「读取失败时的回退」。 */
  const configHandler = async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      send(200, current)
      return
    }
    if (req.method !== 'PUT') {
      res.writeHead(405, { allow: 'GET, HEAD, PUT' })
      res.end()
      return
    }
    try {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 64 * 1024) throw new Error('payload too large')
        chunks.push(chunk)
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      const patch = pickConfigKeys(parsed)
      if (Object.keys(patch).length === 0) {
        send(400, { error: 'no recognised config keys' })
        return
      }
      current = { ...current, ...patch }
      await writeConfigFile(current)
      send(200, current)
    } catch (error) {
      send(400, { error: String(error && error.message ? error.message : error) })
    }
  }

  const deepwater = createWallpaperHandler()
  const ice = createIceWallpaperHandler()
  const disposers = [
    ...[WALLPAPER_ROUTE, WALLPAPER_ROUTE_LEGACY].map((path) => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: deepwater,
    })),
    ...[ICE_WALLPAPER_ROUTE, ICE_WALLPAPER_ROUTE_LEGACY].map((path) => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: ice,
    })),
    ctx.webServer.register({ kind: 'exact', path: CONFIG_ROUTE, handler: configHandler }),
  ]
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  })
}
