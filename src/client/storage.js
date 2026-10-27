    // Layer: 服务端配置优先 + localStorage 回退；以及 apply rollback。
    //
    // 背景(20261027)：原本全部配置存 localStorage，导致每个客户端都要各配一遍、
    // 换浏览器/清缓存即丢失。改为服务端持久化（host.js 的 Config + settings.update），
    // 所有客户端共享同一份。
    //
    // 三层优先级：
    //   1. serverConfig  —— GET /api/dsh-liquid-glass/config 拉到的服务端值
    //   2. localStorage  —— 服务端不可用/字段缺失时的回退（同时承载旧配置迁移）
    //   3. 代码默认值    —— 由调用方提供
    //
    // ⚠️ 自定义壁纸图片(background.custom*)**仍留本地**：体积大且与设备相关。
    var serverConfig = null
    var CONFIG_ENDPOINT = '/api/dsh-liquid-glass/config'

    var SERVER_KEY_MAP = {
      'dsh-liquid-glass:effect': 'effect',
      'dsh-liquid-glass:skin': 'skin',
      'dsh-liquid-glass:wallpaper': 'wallpaper',
      'dsh-liquid-glass.glass.blur': 'glassBlur',
      'dsh-liquid-glass.background.opacity': 'backgroundOpacity',
    }
    var KEY_TO_SERVER = {}
    Object.keys(SERVER_KEY_MAP).forEach(function (k) { KEY_TO_SERVER[k] = SERVER_KEY_MAP[k] })

    function serverValueOf(key) {
      if (serverConfig === null) return undefined
      var field = KEY_TO_SERVER[key]
      if (field === undefined) return undefined
      var v = serverConfig[field]
      if (v === undefined || v === null) return undefined
      if (field === 'effect' && v === '') return undefined
      return String(v)
    }

    function storageGet(key) {
      var fromServer = serverValueOf(key)
      if (fromServer !== undefined) return fromServer
      try { return window.localStorage.getItem(key) }
      catch (_error) { return null }
    }

    function storageSet(key, value) {
      try {
        if (value === null) window.localStorage.removeItem(key)
        else window.localStorage.setItem(key, value)
      } catch (_error) { /* 本地写失败不阻塞上报 */ }
      pushServerConfig(key, value)
      return true
    }

    function pushServerConfig(key, value) {
      var field = KEY_TO_SERVER[key]
      if (field === undefined) return
      if (serverConfig === null) return
      var patch = {}
      if (field === 'glassBlur' || field === 'backgroundOpacity') {
        var num = Number(value)
        if (!Number.isFinite(num)) return
        patch[field] = num
      } else {
        patch[field] = value === null ? '' : String(value)
      }
      serverConfig[field] = patch[field]
      try {
        fetch(CONFIG_ENDPOINT, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        }).catch(function () {})
      } catch (_error) { /* 离线时静默，本地值仍生效 */ }
    }

    /* 拉取服务端配置；服务端全空时把本地配置上报一次（旧配置迁移）。 */
    function loadServerConfig() {
      return fetch(CONFIG_ENDPOINT, { headers: { accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null })
        .then(function (cfg) {
          if (cfg === null || typeof cfg !== 'object') return
          serverConfig = cfg
          var empty = Object.keys(SERVER_KEY_MAP).every(function (k) {
            var v = cfg[SERVER_KEY_MAP[k]]
            return v === undefined || v === null || v === ''
          })
          if (!empty) return
          var patch = {}
          Object.keys(SERVER_KEY_MAP).forEach(function (localKey) {
            var raw
            try { raw = window.localStorage.getItem(localKey) } catch (_e) { return }
            if (raw === null) return
            var field = SERVER_KEY_MAP[localKey]
            if (field === 'glassBlur' || field === 'backgroundOpacity') {
              var num = Number(raw)
              if (Number.isFinite(num)) patch[field] = num
            } else patch[field] = raw
          })
          if (Object.keys(patch).length === 0) return
          Object.keys(patch).forEach(function (f) { serverConfig[f] = patch[f] })
          try {
            fetch(CONFIG_ENDPOINT, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(patch),
            }).catch(function () {})
          } catch (_e) {}
        })
        .catch(function () {})
    }

        /* ===== 图库同步(20261027) =====
     *
     * 自定义壁纸图片存服务端，跨设备共享。为免每次全量下载：
     *   ① 先拉索引（很小），拿到 { id: { hash, ext, url } }
     *   ② url 内含内容哈希 ⇒ 浏览器强缓存，第二次起零网络
     *   ③ 本地 localStorage 保留一份副本：服务端不可达时仍能渲染，
     *      且命中本地副本时无需等网络
     */
    var GALLERY_INDEX_ENDPOINT = '/api/dsh-liquid-glass/wallpapers/index'
    var GALLERY_UPLOAD_ENDPOINT = '/api/dsh-liquid-glass/wallpapers/upload'
    var CUSTOM_LIBRARY_KEY = 'dsh-liquid-glass.background.customs'
    var CUSTOM_SINGLE_KEY = 'dsh-liquid-glass.background.custom'
    var galleryIndex = null

    function readLocalLibrary() {
      var raw
      try { raw = window.localStorage.getItem(CUSTOM_LIBRARY_KEY) } catch (_e) { return [] }
      if (!raw) return []
      try {
        var parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed : []
      } catch (_e) { return [] }
    }

    function writeLocalLibrary(list) {
      try {
        if (!list || list.length === 0) window.localStorage.removeItem(CUSTOM_LIBRARY_KEY)
        else window.localStorage.setItem(CUSTOM_LIBRARY_KEY, JSON.stringify(list))
      } catch (_e) {}
    }

    /* 图库双向同步。
     *
     * ⚠️ 20261027 修正：原实现只做「服务端 → 本地」单向下载，
     * 导致改造前就存在的本地图片永远传不上去（服务端索引恒为空，
     * 于是看起来"没同步"）。现改为双向：
     *
     *   ① 拉服务端索引
     *   ② 服务端有、本地无（或 hash 不同）→ 下载到本地
     *   ③ 本地有、服务端无 → 上传到服务端   ← 原先缺失的一步
     *   ④ 两边都有且 hash 相同 → 跳过（避免重复传输）
     */
    function syncGallery() {
      return fetch(GALLERY_INDEX_ENDPOINT, { headers: { accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null })
        .then(function (index) {
          if (index === null || typeof index !== 'object') return
          galleryIndex = index
          var local = readLocalLibrary()
          var byId = {}
          local.forEach(function (item) { if (item && item.id) byId[item.id] = item })

          var downloads = []
          Object.keys(index).forEach(function (id) {
            var entry = index[id]
            if (!entry || !entry.url) return
            var existing = byId[id]
            // 已有同 hash 的本地副本 → 跳过下载
            if (existing && existing.hash === entry.hash && existing.data) return
            downloads.push(
              fetch(entry.url).then(function (r) { return r.ok ? r.blob() : null }).then(function (blob) {
                if (blob === null) return
                return new Promise(function (resolve) {
                  var reader = new FileReader()
                  reader.onload = function () { resolve(String(reader.result || '')) }
                  reader.onerror = function () { resolve(null) }
                  reader.readAsDataURL(blob)
                }).then(function (dataUrl) {
                  if (!dataUrl) return
                  var idx = local.findIndex(function (x) { return x && x.id === id })
                  var item = { id: id, data: dataUrl, hash: entry.hash }
                  if (idx === -1) local.push(item)
                  else local[idx] = item
                })
              }).catch(function () {})
            )
          })

          // ③ 本地有、服务端没有的条目 → 上传（存量迁移的关键一步）
          var uploads = local.filter(function (item) {
            return item && typeof item.id === 'string' && typeof item.data === 'string'
              && item.data.indexOf('data:image/') === 0
              && index[item.id] === undefined
          })

          return Promise.all(downloads)
            .then(function () { writeLocalLibrary(local) })
            .then(function () {
              if (uploads.length === 0) return
              return pushGalleryItems(uploads)
            })
        })
        .catch(function () {})
    }

    /* 把本地新增的图片上传服务端。仅在用户新导入时调用。 */
    /* 逐张上传（20261027）。
     * 图库上限 6 张 / 4MB，整体上传虽在服务端 12MB 限制内，但逐张更稳：
     * 单张失败不影响其余，且能即时回填每张的 hash。 */
    function pushOneGalleryItem(item) {
      if (!item || typeof item.id !== 'string' || typeof item.data !== 'string') return Promise.resolve()
      if (item.data.indexOf('data:image/') !== 0) return Promise.resolve()
      var payload = {}
      payload[item.id] = item.data
      return fetch(GALLERY_UPLOAD_ENDPOINT, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function (r) { return r.ok ? r.json() : null })
        .then(function (changed) {
          if (!changed || typeof changed !== 'object' || !changed[item.id]) return
          // 回填 hash，供下次启动时跳过下载
          var local = readLocalLibrary()
          var idx = local.findIndex(function (x) { return x && x.id === item.id })
          if (idx !== -1 && local[idx].hash !== changed[item.id].hash) {
            local[idx].hash = changed[item.id].hash
            writeLocalLibrary(local)
          }
        })
        .catch(function () {})
    }

    function pushGalleryItems(items) {
      if (!items || items.length === 0) return Promise.resolve()
      // 串行上传，避免并发写 index.json 互相覆盖
      var chain = Promise.resolve()
      items.forEach(function (item) {
        chain = chain.then(function () { return pushOneGalleryItem(item) })
      })
      return chain
    }

    /* ===== 跨设备变更探测(20261027) =====
     * 每 2s 用 GET 探一次 revision（只回一个整数），变了才拉全量配置。
     * 变更后通过 onRemoteConfigChange 回调通知上层刷新 UI。
     * 页面隐藏时暂停轮询（移动端切后台省电），可见时立即探一次。
     */
    var REVISION_ENDPOINT = '/api/dsh-liquid-glass/revision'
    var lastRevision = null
    var pollTimer = null
    var remoteListeners = []
    var POLL_INTERVAL_MS = 2000

    function onRemoteConfigChange(fn) {
      if (typeof fn === 'function') remoteListeners.push(fn)
    }

    function emitRemoteChange(cfg) {
      for (var i = 0; i < remoteListeners.length; i++) {
        try { remoteListeners[i](cfg) } catch (_e) {}
      }
    }

    function pullConfig() {
      return fetch(CONFIG_ENDPOINT, { headers: { accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null })
        .then(function (cfg) {
          if (cfg === null || typeof cfg !== 'object') return
          var rev = cfg.__revision
          delete cfg.__revision
          if (rev !== undefined) lastRevision = rev
          serverConfig = cfg
          emitRemoteChange(cfg)
        })
        .catch(function () {})
    }

    function pollOnce() {
      if (document && document.hidden) return Promise.resolve()
      return fetch(REVISION_ENDPOINT, { headers: { accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null })
        .then(function (data) {
          if (data === null || typeof data.revision !== 'number') return
          if (lastRevision === null) { lastRevision = data.revision; return }
          if (data.revision === lastRevision) return
          return pullConfig()   // 只有变了才拉全量
        })
        .catch(function () {})
    }

    function startRevisionPolling() {
      if (pollTimer !== null) return
      pollTimer = setInterval(function () { pollOnce() }, POLL_INTERVAL_MS)
      if (document && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) pollOnce()   // 回到前台立即探一次
        })
      }
    }

    function clamp(value, min, max, fallback) {
      return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
    }

    function readNumber(key, min, max, fallback) {
      var raw = storageGet(key)
      if (raw === null) return fallback
      return clamp(Number(raw), min, max, fallback)
    }

    function runWithRollback(steps) {
      var disposers = []
      try {
        for (var i = 0; i < steps.length; i += 1) {
          var dispose = steps[i]()
          if (typeof dispose === 'function') disposers.push(dispose)
        }
        return function () {
          for (var j = disposers.length - 1; j >= 0; j -= 1) {
            try { disposers[j]() } catch (_error) {}
          }
        }
      } catch (error) {
        for (var k = disposers.length - 1; k >= 0; k -= 1) {
          try { disposers[k]() } catch (_error) {}
        }
        throw error
      }
    }
