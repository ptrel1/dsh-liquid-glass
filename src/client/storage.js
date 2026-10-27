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
