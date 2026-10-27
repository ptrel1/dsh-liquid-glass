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

    /* 拉索引 + 补齐本地缺失的图片。
     * 先把索引里新出现的 id 拉成 data URL 写回本地图库；
     * 本地已有同 hash 的条目直接跳过（避免重复下载）。 */
    function syncGallery() {
      return fetch(GALLERY_INDEX_ENDPOINT, { headers: { accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null })
        .then(function (index) {
          if (index === null || typeof index !== 'object') return
          galleryIndex = index
          var local = readLocalLibrary()
          var byId = {}
          local.forEach(function (item) { if (item && item.id) byId[item.id] = item })

          var tasks = []
          Object.keys(index).forEach(function (id) {
            var entry = index[id]
            if (!entry || !entry.url) return
            var existing = byId[id]
            // 已有同 hash 的本地副本 → 跳过下载
            if (existing && existing.hash === entry.hash && existing.data) return
            tasks.push(
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
          return Promise.all(tasks).then(function () { writeLocalLibrary(local) })
        })
        .catch(function () {})
    }

    /* 把本地新增的图片上传服务端。仅在用户新导入时调用。 */
    function pushGalleryItems(items) {
      if (!items || items.length === 0) return Promise.resolve()
      var payload = {}
      items.forEach(function (item) {
        if (item && typeof item.id === 'string' && typeof item.data === 'string') payload[item.id] = item.data
      })
      if (Object.keys(payload).length === 0) return Promise.resolve()
      return fetch(GALLERY_UPLOAD_ENDPOINT, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function (r) { return r.ok ? r.json() : null })
        .then(function (changed) {
          if (!changed || typeof changed !== 'object') return
          // 回填 hash，供下次启动时跳过下载
          var local = readLocalLibrary()
          var touched = false
          local.forEach(function (item) {
            if (item && changed[item.id] && changed[item.id].hash) { item.hash = changed[item.id].hash; touched = true }
          })
          if (touched) writeLocalLibrary(local)
        })
        .catch(function () {})
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
