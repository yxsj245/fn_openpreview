import {
  createViewer,
  textPlugin,
  officePlugin,
  archivePlugin,
  emailPlugin,
  audioPlugin,
  epubPlugin,
  xpsPlugin,
  ofdPlugin,
  drawingPlugin,
  cadPlugin,
  model3dPlugin,
  gisPlugin,
  assetPlugin,
  fallbackPlugin
} from "@open-file-viewer/core";
import "@open-file-viewer/core/style.css";

/* ============================================================
 * DOM 元素引用
 * ============================================================ */
const el = {
  loading: document.getElementById("state-loading"),
  loadingName: document.getElementById("loading-name"),
  error: document.getElementById("state-error"),
  errorTitle: document.getElementById("error-title"),
  errorDetail: document.getElementById("error-detail"),
  errorDownload: document.getElementById("error-download"),
  errorRetry: document.getElementById("error-retry"),
  landing: document.getElementById("state-landing"),
  viewer: document.getElementById("viewer"),
  tabs: document.getElementById("tabs"),
  passwordDialog: document.getElementById("password-dialog"),
  passwordTitle: document.getElementById("password-title"),
  passwordHint: document.getElementById("password-hint"),
  passwordInput: document.getElementById("password-input"),
  rememberPassword: document.getElementById("remember-password"),
  passwordConfirm: document.getElementById("password-confirm"),
  passwordCancel: document.getElementById("password-cancel"),
  contextMenu: document.getElementById("tab-context-menu")
};

/* ============================================================
 * 常量
 * ============================================================ */
const baseUrl = location.pathname.endsWith("/")
  ? location.pathname
  : `${location.pathname}/`;

const fileEndpoint = (path, download = false) =>
  `${baseUrl}file?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;

const archiveEndpoint = (path, entry, password) =>
  `${baseUrl}archive?path=${encodeURIComponent(path)}${
    entry === undefined ? "&list=1" : `&entry=${encodeURIComponent(entry)}`
  }${password ? `&password=${encodeURIComponent(password)}` : ""}`;

// SDK 无法列目录、但设备 7-Zip 可解码的格式，走服务端压缩包浏览
const SERVER_ARCHIVE_EXTS = new Set(["7z", "rar"]);

const STORAGE_KEYS = {
  tabs: "fn_openpreview_tabs",
  activeTab: "fn_openpreview_active_tab",
  zoom: "fn_openpreview_zoom",
  passwords: "fn_openpreview_passwords"
};

const DEFAULT_ZOOM = 1.32;
const APP_TITLE = "极速文件预览器";
const MAX_PREVIEW_SIZE = 1 * 1024 * 1024; // 1MB，超过此大小阻止渲染以防浏览器卡死

/* ============================================================
 * 运行时状态
 * ============================================================ */
let tabs = [];
let activeTabId = null;
let activeViewer = null;
let archiveEntryToken = 0;
let passwordDialogResolve = null;

/* ============================================================
 * 工具函数
 * ============================================================ */
function extensionOf(name) {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fileNameOf(path) {
  const segments = path.split("/").filter(Boolean);
  return segments.length ? segments[segments.length - 1] : path;
}

// 检测 zip 文件是否加密（扫描中央目录中所有条目的加密标志位）
async function isZipEncrypted(blob) {
  try {
    // 从文件末尾查找 EOCD 记录（End of Central Directory）
    const tailSize = Math.min(blob.size, 65557);
    const tail = await blob.slice(blob.size - tailSize).arrayBuffer();
    const tailView = new DataView(tail);
    let eocdOffset = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
      if (tailView.getUint32(i, true) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) return false;

    // 读取中央目录
    const cdOffset = tailView.getUint32(eocdOffset + 16, true);
    const cdSize = tailView.getUint32(eocdOffset + 12, true);
    if (cdOffset + cdSize > blob.size) return false;
    const cd = await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer();
    const cdView = new DataView(cd);

    // 遍历中央目录条目，检查加密标志
    let pos = 0;
    while (pos < cd.byteLength - 4) {
      if (cdView.getUint32(pos, true) !== 0x02014b50) break;
      const flags = cdView.getUint16(pos + 8, true);
      if (flags & 0x01) return true; // 条目已加密
      const fnLen = cdView.getUint16(pos + 28, true);
      const extraLen = cdView.getUint16(pos + 30, true);
      const commentLen = cdView.getUint16(pos + 32, true);
      pos += 46 + fnLen + extraLen + commentLen;
    }
    return false;
  } catch {
    return false;
  }
}

function getActiveTab() {
  return tabs.find((t) => t.id === activeTabId);
}

function generateId() {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ============================================================
 * 飞牛系统主题检测（跟随飞牛桌面设置，而非浏览器 prefers-color-scheme）
 * ============================================================ */
function getFnOSTheme() {
  try {
    const parent = window.parent;
    if (parent && parent !== window && parent.document && parent.document.body) {
      const mode = parent.document.body.getAttribute("theme-mode");
      if (mode === "dark") return "dark";
      if (mode === "light") return "light";
    }
  } catch {
    /* cross-origin or no parent */
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyAppTheme(theme) {
  const root = document.documentElement;
  root.classList.remove("theme-light", "theme-dark");
  root.classList.add(`theme-${theme}`);
}

function updateViewerTheme(theme) {
  const viewerRoot = el.viewer.querySelector(".ofv-root");
  if (viewerRoot) {
    viewerRoot.classList.remove("ofv-theme-light", "ofv-theme-dark");
    viewerRoot.classList.add(theme === "dark" ? "ofv-theme-dark" : "ofv-theme-light");
  }
}

function watchFnOSTheme() {
  try {
    const parent = window.parent;
    if (!parent || parent === window || !parent.document || !parent.document.body) return;
    const observer = new MutationObserver(() => {
      const theme = getFnOSTheme();
      applyAppTheme(theme);
      updateViewerTheme(theme);
    });
    observer.observe(parent.document.body, {
      attributes: true,
      attributeFilter: ["theme-mode"]
    });
  } catch {
    /* ignore */
  }
}

/* ============================================================
 * 状态切换
 * ============================================================ */
function showState(name) {
  el.loading.hidden = name !== "loading";
  el.error.hidden = name !== "error";
  el.landing.hidden = name !== "landing";
  el.viewer.hidden = name !== null;
}

function showLanding() {
  showState("landing");
  document.title = APP_TITLE;
}

function showLoading(fileName) {
  el.loadingName.textContent = fileName;
  showState("loading");
}

function showError(title, detail, filePath) {
  el.errorTitle.textContent = title;
  el.errorDetail.textContent = detail || "";
  if (filePath) {
    el.errorDownload.href = fileEndpoint(filePath, true);
    el.errorDownload.hidden = false;
  } else {
    el.errorDownload.hidden = true;
  }
  showState("error");
  document.title = `${title} - ${APP_TITLE}`;
}

/* ============================================================
 * localStorage 持久化
 * ============================================================ */
function loadTabs() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEYS.tabs) || "[]");
    return data.map((t) => ({
      id: t.id || generateId(),
      path: t.path,
      name: t.name || fileNameOf(t.path),
      isArchive: !!t.isArchive,
      status: "idle",
      error: null,
      blob: null,
      archiveEntries: null,
      archiveEncrypted: false,
      password: loadPassword(t.path)
    }));
  } catch {
    return [];
  }
}

function saveTabs() {
  // 压缩包标签页不持久化，仅在当前会话中临时显示
  const data = tabs
    .filter((t) => !t.isArchive)
    .map((t) => ({
      id: t.id,
      path: t.path,
      name: t.name,
      isArchive: t.isArchive
    }));
  localStorage.setItem(STORAGE_KEYS.tabs, JSON.stringify(data));
}

function loadActiveTab() {
  return localStorage.getItem(STORAGE_KEYS.activeTab);
}

function saveActiveTab() {
  if (activeTabId) {
    localStorage.setItem(STORAGE_KEYS.activeTab, activeTabId);
  } else {
    localStorage.removeItem(STORAGE_KEYS.activeTab);
  }
}

function loadZoom() {
  const v = parseFloat(localStorage.getItem(STORAGE_KEYS.zoom));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_ZOOM;
}

function saveZoom(zoom) {
  localStorage.setItem(STORAGE_KEYS.zoom, String(zoom));
}

function loadPassword(path) {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEYS.passwords) || "{}");
    return data[path] || null;
  } catch {
    return null;
  }
}

function savePassword(path, password) {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEYS.passwords) || "{}");
    data[path] = password;
    localStorage.setItem(STORAGE_KEYS.passwords, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

/* ============================================================
 * SDK Viewer 挂载
 * ============================================================ */
function buildPlugins() {
  return [
    textPlugin(),
    officePlugin(),
    archivePlugin(),
    emailPlugin(),
    audioPlugin(),
    epubPlugin(),
    xpsPlugin(),
    ofdPlugin(),
    drawingPlugin(),
    cadPlugin(),
    model3dPlugin(),
    gisPlugin(),
    assetPlugin(),
    fallbackPlugin()
  ];
}

function destroyActiveViewer() {
  if (activeViewer && typeof activeViewer.destroy === "function") {
    activeViewer.destroy();
  }
  activeViewer = null;
}

async function mountViewer(blob, fileName, filePath, target) {
  destroyActiveViewer();
  const container = target || el.viewer;
  container.innerHTML = "";
  showState(null);

  const zoom = loadZoom();

  activeViewer = createViewer({
    container,
    file: blob,
    fileName,
    width: "100%",
    height: "100%",
    fit: "contain",
    zoom,
    toolbar: {
      zoom: true,
      rotate: true,
      download: true,
      fullscreen: true,
      print: true,
      search: true,
      actions: [
        {
          id: "zoom-tracker",
          label: "",
          title: "",
          className: "ofv-zoom-tracker",
          hidden: (ctx) => {
            if (typeof ctx.zoom === "number" && ctx.zoom > 0) {
              saveZoom(ctx.zoom);
            }
            return true;
          },
          onClick: () => {}
        }
      ]
    },
    theme: getFnOSTheme(),
    locale: "zh-CN",
    plugins: buildPlugins(),
    onError(error) {
      console.error("[fn_openpreview] preview error:", error);
    },
    onUnsupported() {
      showError(
        "暂不支持预览该格式",
        `${fileName}：可以下载原文件查看。`,
        filePath
      );
    }
  });

  document.title = `${fileName} - ${APP_TITLE}`;
}

/* ============================================================
 * 文件预览（非压缩包）
 * ============================================================ */
function handleFileError(status, filePath) {
  if (status === 403) {
    return { title: "没有读取权限", detail: `当前账号无权读取 ${filePath}。` };
  }
  if (status === 404) {
    return { title: "文件不存在", detail: `未找到 ${filePath}，文件可能已被移动或删除。` };
  }
  return { title: "读取文件失败", detail: `预览服务返回 ${status}。` };
}

async function loadAndPreview(tab) {
  showLoading(tab.name);
  tab.status = "loading";
  renderTabBar();

  // 优先使用缓存的 blob，实现标签页快速切换
  if (tab.blob) {
    if (tab.blob.size > MAX_PREVIEW_SIZE) {
      tab.status = "error";
      tab.error = {
        title: "文件过大，已阻止加载",
        detail: `当前文件 ${formatSize(tab.blob.size)} 过大，为防止浏览器卡死已自动阻止加载，请将文件下载到本地打开。`
      };
      showError(tab.error.title, tab.error.detail, tab.path);
      renderTabBar();
      return;
    }
    try {
      await mountViewer(tab.blob, tab.name, tab.path);
      tab.status = "loaded";
      tab.error = null;
      renderTabBar();
      return;
    } catch {
      tab.blob = null;
    }
  }

  let response;
  try {
    response = await fetch(fileEndpoint(tab.path), { credentials: "same-origin" });
  } catch (error) {
    tab.status = "error";
    tab.error = { title: "网络错误", detail: `无法连接预览服务：${error.message}` };
    showError(tab.error.title, tab.error.detail, tab.path);
    renderTabBar();
    return;
  }

  if (!response.ok) {
    tab.status = "error";
    tab.error = handleFileError(response.status, tab.path);
    showError(tab.error.title, tab.error.detail, tab.path);
    renderTabBar();
    return;
  }

  try {
    tab.blob = await response.blob();

    // 文件过大保护：阻止渲染可能导致浏览器卡死的大文件
    if (tab.blob.size > MAX_PREVIEW_SIZE) {
      tab.status = "error";
      tab.error = {
        title: "文件过大，已阻止加载",
        detail: `当前文件 ${formatSize(tab.blob.size)} 过大，为防止浏览器卡死已自动阻止加载，请将文件下载到本地打开。`
      };
      showError(tab.error.title, tab.error.detail, tab.path);
      tab.blob = null;
      renderTabBar();
      return;
    }

    // 加密 zip 重定向到服务端压缩包浏览器（支持密码输入）
    if (extensionOf(tab.name) === "zip" && await isZipEncrypted(tab.blob)) {
      tab.isArchive = true;
      tab.blob = null;
      saveTabs();
      await loadArchiveBrowser(tab);
      return;
    }

    await mountViewer(tab.blob, tab.name, tab.path);
    tab.status = "loaded";
    tab.error = null;
    renderTabBar();
  } catch (error) {
    tab.status = "error";
    tab.error = { title: "预览失败", detail: error.message || String(error) };
    showError(tab.error.title, tab.error.detail, tab.path);
    renderTabBar();
  }
}

/* ============================================================
 * 压缩包预览（7z / rar，服务端 7-Zip 解码）
 * ============================================================ */
function handleArchiveError(resp, filePath) {
  if (resp.status === 403) {
    return { title: "没有读取权限", detail: `当前账号无权读取 ${filePath}。` };
  }
  if (resp.status === 404) {
    return { title: "文件不存在", detail: `未找到 ${filePath}，文件可能已被移动或删除。` };
  }
  if (resp.status === 415) {
    return { title: "无法读取压缩包", detail: "压缩包格式不受支持或已损坏。" };
  }
  return { title: "无法读取压缩包", detail: `预览服务返回 ${resp.status}。` };
}

async function loadArchiveBrowser(tab) {
  // 优先使用缓存的条目列表
  if (tab.archiveEntries) {
    renderArchiveBrowser(tab, tab.archiveEntries, tab.password);
    return;
  }

  showLoading(tab.name);
  tab.status = "loading";
  renderTabBar();

  let password = tab.password || loadPassword(tab.path);
  let resp;
  try {
    resp = await fetch(archiveEndpoint(tab.path, undefined, password), {
      credentials: "same-origin"
    });
  } catch (error) {
    tab.status = "error";
    tab.error = { title: "网络错误", detail: `无法连接预览服务：${error.message}` };
    showError(tab.error.title, tab.error.detail, tab.path);
    renderTabBar();
    return;
  }

  // 头部加密：列表失败，需要密码
  if (resp.status === 401) {
    const isRetry = !!password;
    const result = await promptPassword(
      isRetry ? "密码错误，请重新输入" : "压缩包已加密，请输入密码",
      isRetry
    );
    if (!result) {
      tab.status = "error";
      tab.error = { title: "已取消", detail: "需要密码才能预览此压缩包。" };
      showError(tab.error.title, tab.error.detail, tab.path);
      renderTabBar();
      return;
    }
    password = result.password;
    tab.password = password;
    if (result.remember) savePassword(tab.path, password);
    try {
      resp = await fetch(archiveEndpoint(tab.path, undefined, password), {
        credentials: "same-origin"
      });
    } catch (error) {
      tab.status = "error";
      tab.error = { title: "网络错误", detail: `无法连接预览服务：${error.message}` };
      showError(tab.error.title, tab.error.detail, tab.path);
      renderTabBar();
      return;
    }
    if (resp.status === 401) {
      tab.status = "error";
      tab.error = { title: "密码错误", detail: "无法解压此压缩包，请检查密码。" };
      showError(tab.error.title, tab.error.detail, tab.path);
      renderTabBar();
      return;
    }
  }

  if (!resp.ok) {
    tab.status = "error";
    tab.error = handleArchiveError(resp, tab.path);
    showError(tab.error.title, tab.error.detail, tab.path);
    renderTabBar();
    return;
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    tab.status = "error";
    tab.error = { title: "解析失败", detail: "压缩包列表数据格式错误。" };
    showError(tab.error.title, tab.error.detail, tab.path);
    renderTabBar();
    return;
  }

  const entries = Array.isArray(data.entries) ? data.entries : [];
  tab.archiveEntries = entries;
  tab.archiveEncrypted = !!data.encrypted;
  tab.password = password;

  // 条目加密的压缩包：列表不需要密码，直接展示文件列表
  // 密码在实际提取文件时才提示输入
  renderArchiveBrowser(tab, entries, password);
}

function renderArchiveBrowser(tab, entries, password) {
  destroyActiveViewer();
  el.viewer.innerHTML = "";
  showState(null);
  tab.status = "loaded";
  tab.error = null;
  document.title = `${tab.name} - ${APP_TITLE}`;
  renderTabBar();

  const layout = document.createElement("div");
  layout.className = "archive-layout";

  const listPane = document.createElement("div");
  listPane.className = "archive-list";
  const header = document.createElement("div");
  header.className = "archive-list-header";
  header.textContent = `文件列表（${entries.length}）`;
  listPane.append(header);

  const previewPane = document.createElement("div");
  previewPane.className = "archive-preview";
  const emptyHint = document.createElement("div");
  emptyHint.className = "archive-empty";
  emptyHint.textContent = entries.length
    ? "选择左侧文件查看内容"
    : "压缩包为空";
  previewPane.append(emptyHint);

  for (const entry of entries) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "archive-item";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.name;
    name.title = entry.name;
    const size = document.createElement("span");
    size.className = "size";
    size.textContent = formatSize(entry.size);
    item.append(name, size);
    item.addEventListener("click", () => {
      listPane
        .querySelectorAll(".archive-item.active")
        .forEach((n) => n.classList.remove("active"));
      item.classList.add("active");
      emptyHint.textContent = "";

      let pw = tab.archiveEncrypted ? tab.password || loadPassword(tab.path) : null;
      if (tab.archiveEncrypted && !pw) {
        promptPassword("此压缩包的文件已加密，请输入密码", false).then(
          (result) => {
            if (!result) {
              emptyHint.textContent = "需要密码才能查看加密文件";
              return;
            }
            tab.password = result.password;
            if (result.remember) savePassword(tab.path, result.password);
            void mountArchiveEntry(
              tab.path,
              entry.name,
              previewPane,
              emptyHint,
              result.password,
              tab
            );
          }
        );
      } else {
        void mountArchiveEntry(
          tab.path,
          entry.name,
          previewPane,
          emptyHint,
          pw,
          tab
        );
      }
    });
    listPane.append(item);
  }

  layout.append(listPane, previewPane);
  el.viewer.append(layout);

  if (entries.length) {
    listPane.querySelector(".archive-item")?.click();
  }
}

async function mountArchiveEntry(
  archivePath,
  entryName,
  container,
  emptyHint,
  password,
  tab
) {
  const token = ++archiveEntryToken;
  destroyActiveViewer();
  container.innerHTML = "";
  container.append(emptyHint);
  emptyHint.textContent = `正在解压 ${entryName} …`;

  let resp;
  try {
    resp = await fetch(archiveEndpoint(archivePath, entryName, password), {
      credentials: "same-origin"
    });
  } catch {
    if (token !== archiveEntryToken) return;
    emptyHint.textContent = `网络错误，无法读取：${entryName}`;
    return;
  }

  // 密码错误或缺失
  if (resp.status === 401) {
    const isRetry = !!password;
    const result = await promptPassword(
      isRetry ? "密码错误，请重新输入" : "此文件已加密，请输入密码",
      isRetry
    );
    if (token !== archiveEntryToken) return;
    if (!result) {
      emptyHint.textContent = "已取消解压";
      return;
    }
    password = result.password;
    tab.password = password;
    if (result.remember) savePassword(tab.path, password);
    try {
      resp = await fetch(archiveEndpoint(archivePath, entryName, password), {
        credentials: "same-origin"
      });
    } catch {
      if (token !== archiveEntryToken) return;
      emptyHint.textContent = `网络错误，无法读取：${entryName}`;
      return;
    }
    if (token !== archiveEntryToken) return;
    if (resp.status === 401) {
      emptyHint.textContent = `密码错误，无法解压 ${entryName}`;
      return;
    }
  }

  if (token !== archiveEntryToken) return;

  if (!resp.ok) {
    emptyHint.textContent = `无法读取包内文件：${entryName}（${resp.status}）`;
    return;
  }

  const blob = await resp.blob();
  if (token !== archiveEntryToken) return;
  if (blob.size > MAX_PREVIEW_SIZE) {
    emptyHint.textContent = `${entryName}（${formatSize(blob.size)}）过大，为防止浏览器卡死已阻止加载，请将文件下载到本地打开。`;
    return;
  }
  await mountViewer(blob, entryName, archivePath, container);
}

/* ============================================================
 * 密码对话框
 * ============================================================ */
function promptPassword(hintText, isError) {
  return new Promise((resolve) => {
    el.passwordTitle.textContent = "压缩包已加密";
    el.passwordHint.textContent = hintText;
    el.passwordHint.classList.toggle("error", !!isError);
    el.passwordInput.value = "";
    el.rememberPassword.checked = false;
    el.passwordDialog.hidden = false;
    setTimeout(() => el.passwordInput.focus(), 0);
    passwordDialogResolve = resolve;
  });
}

function setupPasswordDialog() {
  el.passwordConfirm.addEventListener("click", () => {
    if (!passwordDialogResolve) return;
    const pw = el.passwordInput.value;
    const remember = el.rememberPassword.checked;
    el.passwordDialog.hidden = true;
    passwordDialogResolve({ password: pw, remember });
    passwordDialogResolve = null;
  });

  el.passwordCancel.addEventListener("click", () => {
    if (!passwordDialogResolve) return;
    el.passwordDialog.hidden = true;
    passwordDialogResolve(null);
    passwordDialogResolve = null;
  });

  el.passwordInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      el.passwordConfirm.click();
    } else if (e.key === "Escape") {
      e.preventDefault();
      el.passwordCancel.click();
    }
  });
}

/* ============================================================
 * 标签页管理
 * ============================================================ */
function createTab(filePath) {
  const fileName = fileNameOf(filePath);
  const isArchive = SERVER_ARCHIVE_EXTS.has(extensionOf(fileName));
  return {
    id: generateId(),
    path: filePath,
    name: fileName,
    isArchive,
    status: "loading",
    error: null,
    blob: null,
    archiveEntries: null,
    archiveEncrypted: false,
    password: loadPassword(filePath)
  };
}

function renderTabBar() {
  el.tabs.innerHTML = "";
  for (const tab of tabs) {
    const tabEl = document.createElement("div");
    tabEl.className = "tab";
    if (tab.id === activeTabId) tabEl.classList.add("active");
    if (tab.status === "loading") tabEl.classList.add("tab-loading");
    tabEl.dataset.tabId = tab.id;

    const nameEl = document.createElement("span");
    nameEl.className = "tab-name";
    nameEl.textContent = tab.name;
    nameEl.title = tab.path;

    const closeBtn = document.createElement("button");
    closeBtn.className = "tab-close";
    closeBtn.type = "button";
    closeBtn.innerHTML = "&times;";
    closeBtn.title = "关闭";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });

    tabEl.append(nameEl, closeBtn);
    tabEl.addEventListener("click", () => switchTab(tab.id));
    tabEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showContextMenu(e, tab.id);
    });

    el.tabs.append(tabEl);
  }
}

async function switchTab(tabId) {
  if (tabId === activeTabId) return;
  activeTabId = tabId;
  saveActiveTab();
  const tab = getActiveTab();
  if (tab) {
    await renderTabContent(tab);
  }
}

function closeTab(tabId, skipRender = false) {
  const idx = tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;

  tabs.splice(idx, 1);

  if (tabId === activeTabId) {
    if (tabs.length === 0) {
      activeTabId = null;
      destroyActiveViewer();
      if (!skipRender) {
        showLanding();
        renderTabBar();
      }
    } else {
      activeTabId = tabs[Math.min(idx, tabs.length - 1)].id;
      if (!skipRender) {
        renderTabContent(getActiveTab());
      }
    }
  }

  saveTabs();
  saveActiveTab();
  if (!skipRender) renderTabBar();
}

function closeOthers(keepTabId) {
  tabs = tabs.filter((t) => t.id === keepTabId);
  if (activeTabId !== keepTabId) {
    activeTabId = keepTabId;
    saveActiveTab();
    renderTabContent(getActiveTab());
  }
  saveTabs();
  renderTabBar();
}

function closeAll() {
  tabs = [];
  activeTabId = null;
  destroyActiveViewer();
  saveTabs();
  saveActiveTab();
  showLanding();
  renderTabBar();
}

async function renderTabContent(tab) {
  destroyActiveViewer();
  el.viewer.innerHTML = "";
  renderTabBar();

  if (tab.isArchive) {
    await loadArchiveBrowser(tab);
  } else {
    await loadAndPreview(tab);
  }
}

/* ============================================================
 * 右键菜单
 * ============================================================ */
function showContextMenu(e, tabId) {
  el.contextMenu.hidden = false;
  el.contextMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 180)}px`;
  el.contextMenu.style.top = `${Math.min(e.clientY, window.innerHeight - 140)}px`;
  el.contextMenu.dataset.tabId = tabId;
}

function hideContextMenu() {
  el.contextMenu.hidden = true;
}

function setupContextMenu() {
  el.contextMenu.addEventListener("click", (e) => {
    const action = e.target.dataset.action;
    const tabId = el.contextMenu.dataset.tabId;
    hideContextMenu();
    if (!action || !tabId) return;
    switch (action) {
      case "close":
        closeTab(tabId);
        break;
      case "close-others":
        closeOthers(tabId);
        break;
      case "close-all":
        closeAll();
        break;
    }
  });

  document.addEventListener("click", hideContextMenu);
  document.addEventListener("contextmenu", (e) => {
    if (!e.target.closest(".tab")) {
      hideContextMenu();
    }
  });
  window.addEventListener("blur", hideContextMenu);
}

/* ============================================================
 * 文件存在性检查（启动时清理已删除的文件标签）
 * ============================================================ */
async function checkFileExists(path) {
  try {
    const resp = await fetch(fileEndpoint(path), {
      method: "HEAD",
      credentials: "same-origin"
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function cleanupInactiveTabs() {
  const inactive = tabs.filter((t) => t.id !== activeTabId);
  const results = await Promise.all(
    inactive.map(async (tab) => ({
      id: tab.id,
      exists: await checkFileExists(tab.path)
    }))
  );
  let changed = false;
  for (const { id, exists } of results) {
    if (!exists) {
      closeTab(id, true);
      changed = true;
    }
  }
  if (changed) {
    saveTabs();
    renderTabBar();
  }
}

/* ============================================================
 * 初始化
 * ============================================================ */
function setupEventHandlers() {
  el.errorRetry.addEventListener("click", () => {
    const tab = getActiveTab();
    if (tab) {
      // 清除缓存以强制重新加载
      tab.blob = null;
      tab.archiveEntries = null;
      renderTabContent(tab);
    }
  });

  setupPasswordDialog();
  setupContextMenu();
}

async function main() {
  // 同步飞牛系统主题
  applyAppTheme(getFnOSTheme());
  watchFnOSTheme();

  const params = new URLSearchParams(location.search);
  const filePath = params.get("path");

  // 恢复已保存的标签页
  tabs = loadTabs();
  let savedActiveId = loadActiveTab();

  // 清理 URL 中的 ?path= 参数，避免刷新时重复打开
  if (filePath) {
    history.replaceState(null, "", location.pathname);
  }

  // 处理新打开的文件
  if (filePath) {
    const existing = tabs.find((t) => t.path === filePath);
    if (existing) {
      existing.status = "loading";
      existing.blob = null;
      existing.archiveEntries = null;
      activeTabId = existing.id;
    } else {
      const tab = createTab(filePath);
      tabs.push(tab);
      activeTabId = tab.id;
    }
  } else if (savedActiveId && tabs.find((t) => t.id === savedActiveId)) {
    activeTabId = savedActiveId;
  } else if (tabs.length > 0) {
    activeTabId = tabs[tabs.length - 1].id;
  } else {
    activeTabId = null;
  }

  saveTabs();
  saveActiveTab();
  renderTabBar();
  setupEventHandlers();

  // 渲染当前标签页
  if (activeTabId) {
    const tab = getActiveTab();
    renderTabContent(tab);
    // 后台清理不存在的标签页
    cleanupInactiveTabs();
  } else {
    showLanding();
  }
}

main();
