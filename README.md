# dsh-liquid-glass · DSH 液态玻璃

DeepSeek Harness（DSH）Web 皮肤：在官方**浅色 / 深色 / 跟随系统**之上叠加壁纸，以及可选的液态玻璃岛。

对照官方基线：DeepSeek Harness `47f943859bef60e4160492346772ded9b24f765a`。

## 预览

| 冰原 | 深水 |
| --- | --- |
| ![冰原壁纸下的新会话](docs/preview/ice-hero.jpg) | ![深水壁纸下的对话](docs/preview/deepwater-chat.jpg) |

| 设置 | 自定义壁纸 |
| --- | --- |
| ![设置里选择壁纸](docs/preview/settings.jpg) | ![导入的自定义壁纸](docs/preview/custom-wallpaper.jpg) |

## 功能

- **壁纸预设**：冰原（浅色）、深水（深色），也可导入自己的图
- **壁纸透明度**：只改壁纸本身，不糊整张图
- **玻璃模糊**：只糊每个玻璃岛背后那一层（侧栏、标题、正文、输入区）
- **液态玻璃开关**：关材质后官方表面回来，壁纸可以继续留着
- **不抢官方几何**：会话滚动仍由 `data-conversation-scroll` 管，输入区 sticky 不改

## 安装

前置：已安装 DSH（`dsh web` 可运行）。

```sh
dsh plugin --profile web add github:xingyingyuzhui/dsh-liquid-glass
```

装完**重启 DSH**（`dsh web`），然后打开 **设置 → 通用 → Liquid Glass**。

## 使用

| 控件 | 作用 |
| --- | --- |
| Wallpaper | 预设 / 导入。滑杆只改壁纸透明度。 |
| Glass blur | 每个玻璃岛背后的 backdrop blur。壁纸保持清晰。 |
| Liquid Glass | 开/关材质。关了恢复官方表面，壁纸可单独留着。 |

旧的「壁纸模糊」存储键不再读取，也不会自动换成新的玻璃模糊。

## 配置持久化与多设备同步

**配置存在服务端，不是浏览器本地。** 所有客户端共享同一份。

```
$DSH_HOME/liquid-glass/config.json
```

| 存储位置 | 内容 | 原因 |
| --- | --- | --- |
| **服务端**（上述文件） | 开关、皮肤、壁纸预设、玻璃模糊、壁纸透明度 | 统一风格，多端一致 |
| **浏览器本地** | 自定义壁纸图片 | 图片体积大，且只对当前设备有意义 |

对应接口：`GET/PUT /api/dsh-liquid-glass/config`

**升级注意**：从旧版本升级时会**自动迁移** —— 首次加载若服务端配置为空，
会把浏览器里已有的设置上报一次，无需重新配置。

> 如果你确实需要「不同设备用不同壁纸」，把壁纸图片导入为**自定义壁纸**即可：
> 图片存在本地，预设选择存在服务端。

## 工作原理

| 面 | 文件 | 说明 |
| --- | --- | --- |
| Host | `host.js` | 托管冰原 / 深水 JPEG。哈希 URL 一年 `immutable`，legacy URL `no-cache`。 |
| Client | `client.js` | `__ModuleLoader__` bundle：设置行 + 壁纸层 + 玻璃岛 CSS。源码在 `src/client/`，`client.js` 由 `npm run build` 生成。 |

CSS 只挂在 `body[data-dsh-liquid-glass]` 下。模糊只发生在各岛 `::before`，不糊壁纸、body 或官方滚动容器。

## 卸载

```sh
dsh plugin --profile web remove dsh-liquid-glass
```

然后重启 `dsh web`。

## 开发

```sh
# 改 src/client/ 后重新生成 client.js
npm run build
npm test          # 只读检查，生成物过期会失败

# 本地验证
dsh plugin --profile web add file:/absolute/path/to/dsh-liquid-glass
# 或
dsh plugin --profile web add link:/absolute/path/to/dsh-liquid-glass
```

不要手改 `client.js` 和 `src/client/generated-optics-fallbacks.js`。

## License

MIT
