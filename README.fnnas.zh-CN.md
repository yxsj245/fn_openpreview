# 极速文件预览器（飞牛 fnOS 应用）

将 [Open File Viewer](./README.zh-CN.md) 打包为飞牛 fnOS 应用（fpk）：**在文件管理器中双击文件，自动在 fnOS 桌面窗口内打开统一预览器**，使用 `index.cgi` 方式接入，而不是打开单独的浏览器标签页。

**低占用 · 极速秒开**：纯静态 CGI 架构，无常驻进程、零常驻内存，双击即开、用完即走，不占用 NAS 运行资源。

已在飞牛测试设备（fnOS 1.x，x86）完成端到端验证：双击 `eml`/`csv` 文件 → fnOS 桌面窗口内打开预览；`/file` 接口安全校验全部通过。

## 1. 工作原理

- 应用入口（`app/ui/config`）通过 `fileTypes` 注册文件打开方式，`type: "iframe"` 让 fnOS 在桌面窗口内打开应用，而不是新标签页。
- 双击已注册扩展名的文件时，fnOS 先校验当前用户对该文件的读权限，然后在入口 URL 后追加 `?path=文件路径`（URL 编码）打开应用。
- 入口指向 `/cgi/ThirdParty/fn_openpreview/index.cgi/`，CGI 输出预览页与静态资源，并提供 `/file` 接口按校验后的路径流式输出文件字节。
- 预览页读取 `path` 参数 → 经 `/file` 接口拉取文件 → 交给 Open File Viewer 在窗口内渲染。

```mermaid
graph LR
    A[双击文件] --> B{fnOS 权限校验}
    B -->|有权限| C[iframe 窗口打开 index.cgi?path=...]
    B -->|无权限| D[提示无权限]
    C --> E[CGI 返回预览页]
    E --> F[前端 fetch /file?path=...]
    F --> G[CGI 校验并流式输出文件]
    G --> H[Open File Viewer 渲染]
```

### 实测确认的关键机制（文档未写明）

1. **应用必须处于 running 状态才会进入入口注册表**：`nostart` 状态的应用不出现在桌面图标、Launchpad 和文件打开方式中。因此 manifest 使用 `ctl_stop=true`，安装后需 `appcenter-cli start fn_openpreview`（`cmd/main` 的 start/status 直接返回成功）。
2. **`fileTypes` 要放在可见入口上**：实测 `noDisplay: true` 入口上的 `fileTypes` 不会进入双击派发注册表；可见入口（未设 `noDisplay`）上的 `fileTypes` 正常生效。
3. **入口 ID 需以 `appname.` 为前缀**（fnpack 校验规则），例如 `fn_openpreview.main`。
4. **`fileTypes` 有 500 字符上限**：应用中心数据库 `app_service.file_types` 字段为 `varchar(500)`，超长会导致安装失败（报错 `value too long for type character varying(500)`）。
5. **双击派发规则**：某扩展名存在已注册应用时，双击直接打开列表中的**第一个**应用（无权限则提示）；多个应用注册同一扩展名时先到先得，用户可通过右键「打开方式」选择。
6. **系统内置处理优先级**：图片/视频（`mp4/mov/mkv/wmv/flv/rmvb`）/PDF 有内置预览，`md`/`json` 被内置文本编辑器占用，注册这些扩展名会覆盖系统行为，本应用刻意避让；`zip` 默认走内置解压对话框，但注册后由注册应用接管（本应用已注册接管，内置解压可通过右键菜单使用）。
7. **安装注意**：本设备的 `install-fpk` 对已安装应用是**空操作**（仅校验文件并提示 `is installed`，不刷新任何文件，即使递增 `version` 也无效）；必须**先 `uninstall` 再 `install-fpk`**。`install-local` 在本设备上存在 `/tmp` 复制丢执行权限的问题（报 10237），推荐使用 `fnpack build` + `uninstall` + `install-fpk`。

## 2. 支持的格式（fileTypes）

注册原则是**不接管系统内置预览**：图片、视频、PDF、`md`/`json`（内置文本编辑器）保持系统默认行为；压缩包（含 `zip`）由本应用接管，双击直接查看目录与内容。当前注册（77 个扩展名，JSON 470 字符，低于 500 上限）：

| 类别 | 扩展名 |
| --- | --- |
| 文本 / 配置 | `txt` `log` `ini` `conf` `yaml` `yml` `xml` |
| 网页 / 代码 | `html` `css` `js` `ts` `tsx` `vue` `py` `go` `rs` `java` `c` `cpp` `h` `sh` `sql` |
| Office 文档 | `doc` `docx` `rtf` `odt` `xls` `xlsx` `ods` `csv` `ppt` `pptx` `odp` `wps` `et` `dps` |
| 压缩包 | `zip` `rar` `7z` `tar` `gz` `tgz` `xz` |
| 邮件 | `eml` `msg` `mbox` |
| 电子书 / 版式 | `epub` `ofd` `xps` `oxps` |
| 音频 | `mp3` `wav` `ogg` `m4a` `flac` |
| 绘图 | `drawio` |
| CAD / 工程 | `dxf` `dwg` `step` `stp` `iges` `igs` |
| 3D 模型 | `gltf` `glb` `obj` `stl` `fbx` `ply` `3mf` |
| GIS | `geojson` `kml` `kmz` `gpx` `shp` |
| 设计资产 | `psd` `ai` |

复杂格式（高保真 Office、CAD、PSD 等）遵循 SDK 的渐进增强策略：浏览器端能解析的直接渲染，无法完整解析的展示元信息与下载兜底。

> 提示：若设备上同时安装了「万能编辑器」等同样注册 `txt`/`js` 等扩展名的应用，双击这些扩展名会打开注册表中排第一个的应用，可通过右键「打开方式」选择。

## 3. 项目结构

```txt
fpk/                          # fpk 应用工程（fnpack build 的输入）
├── manifest                  # 应用元数据（appname=fn_openpreview，ctl_stop=true）
├── ICON.PNG                  # 包图标 64x64
├── ICON_256.PNG              # 包图标 256x256
├── cmd/
│   ├── main                  # 运行控制（start/status 返回成功，无常驻进程）
│   └── install_init 等 8 个生命周期脚本
├── config/
│   ├── privilege             # run-as=package 专用应用用户
│   └── resource              # 资源声明（空）
└── app/
    ├── ui/
    │   ├── config            # 单一可见入口 + fileTypes
    │   ├── index.cgi         # CGI：预览页 / 静态资源 / 文件流接口
    │   └── images/           # 入口图标
    └── www/
        ├── index.html        # 预览页（加载 / 错误 / 落地页状态）
        └── assets/           # viewer.js / viewer.css（前端构建产物）
viewer/                       # 前端源码工程
├── package.json              # esbuild 打包脚本
└── src/main.js               # 预览页逻辑（path 参数 → 拉取文件 → 渲染）
```

## 4. 入口配置说明

`app/ui/config` 只定义一个入口 `fn_openpreview.main`（同时承担桌面图标与文件打开方式）：

- `type: "iframe"`：双击文件与点击图标都在 fnOS 桌面窗口内打开，不产生新标签页。
- `url: "/cgi/ThirdParty/fn_openpreview/index.cgi/"`：fnOS 打开文件时在此 URL 后追加 `?path=`。
- `allUsers: true`：所有用户可见可用。
- `fileTypes`：见第 2 节清单。
- `manifest.desktop_applaunchname=fn_openpreview.main`，与入口 ID 一致。

CGI 入口由 fnOS 在调用前校验 NAS 登录态，未登录访问返回 302 跳转登录页。

## 5. index.cgi 接口

| 路由 | 说明 |
| --- | --- |
| `/cgi/ThirdParty/fn_openpreview/index.cgi/` | 预览页 `index.html`（无 `path` 时展示落地页） |
| `/cgi/ThirdParty/fn_openpreview/index.cgi/assets/*` | 前端静态资源，`Cache-Control: public, max-age=86400` |
| `/cgi/ThirdParty/fn_openpreview/index.cgi/file?path=...` | 流式输出用户文件；附加 `&download=1` 时以附件形式下载 |
| `/cgi/ThirdParty/fn_openpreview/index.cgi/archive?path=...&list=1` | 压缩包目录（JSON），用于 7z/rar |
| `/cgi/ThirdParty/fn_openpreview/index.cgi/archive?path=...&entry=...` | 解压并流式输出包内单个文件 |
| `/cgi/ThirdParty/fn_openpreview/index.cgi/health` | 健康检查 |

`/file` 接口的安全校验（路径即用户输入，全部拒绝式校验，已实测）：

1. 解码后包含 `..` → 400；
2. 非绝对路径 → 400；
3. `realpath` 解析后不位于 `/vol*` 存储空间内（如 `/etc/passwd`）→ 403；
4. 命中 `/@` 系统保留目录（`@appcenter` 等）→ 403；
5. 文件不存在 → 404；不可读 → 403；
6. 路径只作为 `cat`/`stat` 的参数（`--` 防选项注入），绝不拼接进 shell 命令执行。

响应头：`Content-Type: application/octet-stream`、`Content-Length`、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`。

`/archive` 接口复用同一套路径校验，并额外校验包内条目名：拒绝 `..`、glob 元字符（`*?[`）和前导 `-`，且必须与 7-Zip 目录清单精确匹配，不存在返回 404。目录与解压由设备自带的 `/usr/trim/bin/7zz`（7-Zip 24.07，支持 7z/rar/rar5）完成，前端拿到目录后渲染双栏压缩包浏览器，点击条目即时解压预览。静态资源 URL 带版本参数（`?v=版本号`）做缓存破节，避免升级后浏览器沿用旧 bundle。

## 6. 前端预览页

`viewer/src/main.js` 逻辑：

1. 解析 `location.search` 中的 `path`；缺失时显示落地页。
2. `fetch("file?path=...")` 拉取文件为 Blob，按状态码映射错误：403 无权限 / 404 不存在 / 其他读取失败，均提供「下载原文件」和「重试」。
3. 成功后 `createViewer({ file: blob, fileName, locale: "zh-CN", toolbar: true, theme: "auto" })`，插件按注册格式裁剪：`text/office/archive/email/audio/epub/xps/ofd/drawing/cad/model3d/gis/asset/fallback`，不引入图片/视频/PDF 重型插件。
4. `7z`/`rar` 走服务端压缩包浏览器：`/archive` 接口列目录 + 单条目解压，双栏 UI 点击条目即用 SDK 预览包内文件。
5. 不支持的格式走 `fallbackPlugin` 下载兜底。

构建：`cd viewer && npm install && npm run build`，产物输出到 `fpk/app/www/assets/`（约 5.5 MB，含 Office/邮件等解析器，局域网加载 + 24h 缓存可接受）。

## 7. 打包、安装与启动

本地文件经 SFTP 单向同步到设备 `/vol1/1000/project/fn_openpreview/`（见 `.vscode/sftp.json`）。在飞牛设备上：

```bash
cd /vol1/1000/project/fn_openpreview/fpk
fnpack build
sudo appcenter-cli uninstall fn_openpreview   # 已安装过必须先卸载（install-fpk 不做升级）
sudo appcenter-cli install-fpk fn_openpreview.fpk --volume 1
sudo appcenter-cli start fn_openpreview   # 必须启动，running 后入口与文件关联才生效
sudo appcenter-cli status fn_openpreview  # 期望输出 running
```

也可以在应用中心手动安装 `.fpk`。发布时分别用 `platform="x86"` / `platform="arm"` 构建两个包（如 `dist/fn_openpreview_0.1.7_amd64.fpk` 与 `dist/fn_openpreview_0.1.7_arm64.fpk`），源码树 manifest 保持 `platform="all"`。

## 8. 验收清单（已实测）

- [x] 双击 `eml` / `csv` / `zip` / `tar.gz` / `7z` 文件，在 fnOS 桌面窗口内打开预览，URL 带 `?path=`。
- [x] 压缩包预览：`zip`/`tar.gz` 展示文件列表并可预览包内文件；`7z`/`rar` 经服务端 7-Zip 解码，同样支持目录浏览与包内文件预览。
- [x] `/archive` 接口：路径穿越 400、系统文件 403、包内条目非法 400、条目不存在 404、目录与解压 200。
- [x] 预览器工具栏（缩放/下载/全屏/打印/搜索）与中文文案正常。
- [x] `/file` 接口：`..` 穿越 400、`/etc/passwd` 403、不存在文件 404、`/@` 系统目录 403、正常文件 200。
- [x] 未登录访问 CGI 返回 302 跳转登录（fnOS 前置登录态校验）。
- [x] 应用 `nostart` 时不出现在入口注册表；`start` 后桌面图标与文件关联生效。
- [x] `md`/`json` 仍由内置文本编辑器打开；图片/视频/PDF 仍走系统内置预览（均未被本应用接管）。

## 9. 已知限制与后续演进

- **CGI 模型限制**：每次请求启动一次进程、不支持 WebSocket；bash 实现的 `/file` 不支持 HTTP Range。已注册格式以文档类为主，影响可控；音频在加载完成前不能拖动进度。
- **整读内存占用**：预览页将文件整体读为 Blob，数百 MB 级文件会占用等量内存，超大文件建议下载查看。
- **fileTypes 500 字符上限**：受应用中心数据库字段限制，注册扩展名总量有限，已按价值裁剪（牺牲了 `tldraw`/`excalidraw`、字体、数据库文件等低频格式）。
- **同扩展名多应用**：与其他应用（如万能编辑器）注册同一扩展名时，双击打开注册表中的第一个应用；可通过右键「打开方式」切换。
- **CGI 执行身份**：`trim_http_cgi` 调度进程为 root，CGI 脚本实际执行用户未在文档中公开。`/file` 已做路径白名单校验，登录态由 fnOS 前置校验；后续可校验文件属主与登录用户的一致性，或迁移统一网关获取 `X-Trim-Userid` 身份头。
- **演进路径**：需要 Range、流式大文件、WebSocket 或精确用户身份时，迁移到统一网关（常驻服务 + `gatewayPrefix`/`gatewaySocket`），入口与 fileTypes 配置保持不变。

## 10. 参考

- SDK 能力与插件清单：[README.zh-CN.md](./README.zh-CN.md)
- 飞牛开发文档本地镜像：[fnnas-docs](./fnnas-docs/SUMMARY.md)（应用入口、index.cgi、Manifest、打包工具）
- 打包工具：`fnpack`；脚本化安装：`appcenter-cli`

## License

[MIT](./LICENSE)
