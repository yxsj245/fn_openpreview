#!/bin/bash

# 极速文件预览器 CGI 入口
#
# 路由（均挂载在 /cgi/ThirdParty/fn_openpreview/index.cgi/ 下）：
#   /            -> 预览页 index.html
#   /assets/*    -> 前端静态资源（带缓存头）
#   /file?path=  -> 流式输出用户文件（严格校验，供预览器读取字节）
#   /health      -> 健康检查

APP_NAME="fn_openpreview"
APP_ROOT="/var/apps/${APP_NAME}"
BASE_PATH="${APP_ROOT}/target/www"

URI_NO_QUERY="${REQUEST_URI%%\?*}"
REL_PATH="/"

case "$URI_NO_QUERY" in
  *index.cgi*)
    REL_PATH="${URI_NO_QUERY#*index.cgi}"
    ;;
esac

respond() {
  # $1 = status line, $2 = content type, $3 = body
  echo "Status: $1"
  echo "Content-Type: $2"
  echo ""
  echo "$3"
  exit 0
}

urldecode() {
  # 还原 %XX 与 +；先反斜杠转义，避免 printf %b 解释路径中的反斜杠
  local s="${1//+/ }"
  s="${s//\\/\\\\}"
  printf '%b' "${s//%/\\x}"
}

urlencode() {
  # 用于 Content-Disposition 中的 filename*
  local i c
  for (( i = 0; i < ${#1}; i++ )); do
    c="${1:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) printf '%s' "$c" ;;
      *) printf '%%%02X' "'$c" ;;
    esac
  done
}

# ---- 健康检查 ----
if [ "$REL_PATH" = "/health" ]; then
  respond "200 OK" "text/plain; charset=utf-8" "ok"
fi

# ---- 用户文件流接口 ----
if [ "$REL_PATH" = "/file" ]; then
  RAW_PATH=""
  WANT_DOWNLOAD=""

  IFS='&' read -ra PAIRS <<< "${QUERY_STRING:-}"
  for kv in "${PAIRS[@]}"; do
    case "$kv" in
      path=*) RAW_PATH="${kv#path=}" ;;
      download=1) WANT_DOWNLOAD="1" ;;
    esac
  done

  if [ -z "$RAW_PATH" ]; then
    respond "400 Bad Request" "text/plain; charset=utf-8" "missing path"
  fi

  DECODED="$(urldecode "$RAW_PATH")"

  # 安全校验：路径即用户输入
  case "$DECODED" in
    *..*) respond "400 Bad Request" "text/plain; charset=utf-8" "invalid path" ;;
  esac
  case "$DECODED" in
    /*) : ;;
    *) respond "400 Bad Request" "text/plain; charset=utf-8" "absolute path required" ;;
  esac

  REAL_PATH="$(realpath -m -- "$DECODED" 2>/dev/null)"

  # 仅允许存储空间下的用户数据路径
  case "$REAL_PATH" in
    /vol*) : ;;
    *) respond "403 Forbidden" "text/plain; charset=utf-8" "forbidden" ;;
  esac
  # 拒绝飞牛系统保留目录（@appcenter/@appconf/@appdata 等）
  case "$REAL_PATH" in
    */@*) respond "403 Forbidden" "text/plain; charset=utf-8" "forbidden" ;;
  esac

  if [ ! -f "$REAL_PATH" ]; then
    respond "404 Not Found" "text/plain; charset=utf-8" "file not found"
  fi
  if [ ! -r "$REAL_PATH" ]; then
    respond "403 Forbidden" "text/plain; charset=utf-8" "permission denied"
  fi

  FILE_SIZE="$(stat -c %s -- "$REAL_PATH" 2>/dev/null || echo 0)"
  FILE_NAME="$(basename -- "$REAL_PATH")"

  echo "Content-Type: application/octet-stream"
  echo "Content-Length: $FILE_SIZE"
  echo "Cache-Control: no-store"
  echo "X-Content-Type-Options: nosniff"
  if [ "$WANT_DOWNLOAD" = "1" ]; then
    echo "Content-Disposition: attachment; filename*=UTF-8''$(urlencode "$FILE_NAME")"
  fi
  echo ""
  if [ "$REQUEST_METHOD" = "HEAD" ]; then
    exit 0
  fi
  cat -- "$REAL_PATH"
  exit 0
fi

# ---- 压缩包目录接口（7z/rar，借助设备 7-Zip 解码）----
SEVENZ="/usr/trim/bin/7zz"

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

if [ "$REL_PATH" = "/archive" ]; then
  RAW_PATH=""
  WANT_LIST=""
  RAW_ENTRY=""
  RAW_PASSWORD=""

  IFS='&' read -ra PAIRS <<< "${QUERY_STRING:-}"
  for kv in "${PAIRS[@]}"; do
    case "$kv" in
      path=*) RAW_PATH="${kv#path=}" ;;
      list=1) WANT_LIST="1" ;;
      entry=*) RAW_ENTRY="${kv#entry=}" ;;
      password=*) RAW_PASSWORD="${kv#password=}" ;;
    esac
  done

  if [ -z "$RAW_PATH" ]; then
    respond "400 Bad Request" "text/plain; charset=utf-8" "missing path"
  fi

  DECODED="$(urldecode "$RAW_PATH")"

  case "$DECODED" in
    *..*) respond "400 Bad Request" "text/plain; charset=utf-8" "invalid path" ;;
  esac
  case "$DECODED" in
    /*) : ;;
    *) respond "400 Bad Request" "text/plain; charset=utf-8" "absolute path required" ;;
  esac

  REAL_PATH="$(realpath -m -- "$DECODED" 2>/dev/null)"

  case "$REAL_PATH" in
    /vol*) : ;;
    *) respond "403 Forbidden" "text/plain; charset=utf-8" "forbidden" ;;
  esac
  case "$REAL_PATH" in
    */@*) respond "403 Forbidden" "text/plain; charset=utf-8" "forbidden" ;;
  esac

  if [ ! -f "$REAL_PATH" ]; then
    respond "404 Not Found" "text/plain; charset=utf-8" "file not found"
  fi
  if [ ! -r "$REAL_PATH" ]; then
    respond "403 Forbidden" "text/plain; charset=utf-8" "permission denied"
  fi
  if [ ! -x "$SEVENZ" ]; then
    respond "500 Internal Server Error" "text/plain; charset=utf-8" "7z decoder unavailable"
  fi

  PASSWORD="$(urldecode "$RAW_PASSWORD")"
  ERR_FILE="$(mktemp)"
  if [ -n "$PASSWORD" ]; then
    LISTING="$("$SEVENZ" l -slt -p"$PASSWORD" -- "$REAL_PATH" 2>"$ERR_FILE")"
  else
    LISTING="$("$SEVENZ" l -slt -- "$REAL_PATH" 2>"$ERR_FILE")"
  fi
  ERR_CAPTURE="$(cat "$ERR_FILE")"
  rm -f "$ERR_FILE"
  if [ -z "$LISTING" ]; then
    case "$ERR_CAPTURE" in
      *assword*|*ncrypt*|*Enter*password*)
        respond "401 Unauthorized" "application/json; charset=utf-8" '{"error":"encrypted"}'
        ;;
    esac
    respond "415 Unsupported Media Type" "text/plain; charset=utf-8" "cannot read archive"
  fi

  # 解析 -slt 输出：分隔线后的每个块为一个条目
  ENTRY_NAMES=()
  ENTRY_SIZES=()
  ARCHIVE_ENCRYPTED=0
  in_entries=0
  cur_name=""
  cur_size=""
  cur_dir=""
  cur_enc=""
  flush_entry() {
    if [ -n "$cur_name" ] && [ "$cur_dir" != "1" ]; then
      ENTRY_NAMES+=("$cur_name")
      ENTRY_SIZES+=("${cur_size:-0}")
      [ "$cur_enc" = "+" ] && ARCHIVE_ENCRYPTED=1
    fi
    cur_name=""; cur_size=""; cur_dir=""; cur_enc=""
  }
  while IFS= read -r line; do
    case "$line" in
      ----------*) in_entries=1; continue ;;
    esac
    [ "$in_entries" = "1" ] || continue
    case "$line" in
      "Path = "*) flush_entry; cur_name="${line#Path = }" ;;
      "Size = "*) cur_size="${line#Size = }" ;;
      "Folder = +"*) cur_dir="1" ;;
      "Encrypted = +"*) cur_enc="+" ;;
      "Attributes = "*) : ;;
      "") flush_entry ;;
    esac
  done <<< "$LISTING"
  flush_entry

  if [ "$WANT_LIST" = "1" ]; then
    echo "Content-Type: application/json; charset=utf-8"
    echo "Cache-Control: no-store"
    echo ""
    printf '{"entries":['
    first=1
    for i in "${!ENTRY_NAMES[@]}"; do
      [ "$first" = "1" ] || printf ','
      first=0
      printf '{"name":"%s","size":%s}' "$(json_escape "${ENTRY_NAMES[$i]}")" "${ENTRY_SIZES[$i]}"
    done
    printf '],"encrypted":%s}\n' "$([ "$ARCHIVE_ENCRYPTED" = "1" ] && echo true || echo false)"
    exit 0
  fi

  # 单条目解压输出
  if [ -z "$RAW_ENTRY" ]; then
    respond "400 Bad Request" "text/plain; charset=utf-8" "missing entry"
  fi
  ENTRY_NAME="$(urldecode "$RAW_ENTRY")"

  # 安全：拒绝 glob 元字符与路径穿越，必须精确存在于目录清单中
  case "$ENTRY_NAME" in
    *..*) respond "400 Bad Request" "text/plain; charset=utf-8" "invalid entry" ;;
  esac
  case "$ENTRY_NAME" in
    *[*?[]*) respond "400 Bad Request" "text/plain; charset=utf-8" "invalid entry" ;;
  esac
  case "$ENTRY_NAME" in
    -*) respond "400 Bad Request" "text/plain; charset=utf-8" "invalid entry" ;;
  esac

  ENTRY_SIZE=""
  for i in "${!ENTRY_NAMES[@]}"; do
    if [ "${ENTRY_NAMES[$i]}" = "$ENTRY_NAME" ]; then
      ENTRY_SIZE="${ENTRY_SIZES[$i]}"
      break
    fi
  done
  if [ -z "$ENTRY_SIZE" ]; then
    respond "404 Not Found" "text/plain; charset=utf-8" "entry not found"
  fi

  if [ -n "$PASSWORD" ]; then
    TMP_DIR="$(mktemp -d)"
    "$SEVENZ" e -o"$TMP_DIR" -p"$PASSWORD" -- "$REAL_PATH" "$ENTRY_NAME" >/dev/null 2>&1
    EXTRACT_EXIT=$?
    if [ "$EXTRACT_EXIT" -ne 0 ]; then
      rm -rf "$TMP_DIR"
      respond "401 Unauthorized" "application/json; charset=utf-8" '{"error":"wrong_password"}'
    fi
    EXTRACTED_FILE="$(find "$TMP_DIR" -type f -print -quit)"
    if [ -z "$EXTRACTED_FILE" ]; then
      rm -rf "$TMP_DIR"
      respond "500 Internal Server Error" "text/plain; charset=utf-8" "extraction failed"
    fi
    EXTRACTED_SIZE="$(stat -c %s -- "$EXTRACTED_FILE" 2>/dev/null || echo 0)"
    echo "Content-Type: application/octet-stream"
    echo "Content-Length: $EXTRACTED_SIZE"
    echo "Cache-Control: no-store"
    echo "X-Content-Type-Options: nosniff"
    echo ""
    cat -- "$EXTRACTED_FILE"
    rm -rf "$TMP_DIR"
    exit 0
  fi
  echo "Content-Type: application/octet-stream"
  echo "Content-Length: $ENTRY_SIZE"
  echo "Cache-Control: no-store"
  echo "X-Content-Type-Options: nosniff"
  echo ""
  exec "$SEVENZ" e -so -- "$REAL_PATH" "$ENTRY_NAME" 2>/dev/null
fi

# ---- 静态资源与预览页 ----
if [ -z "$REL_PATH" ] || [ "$REL_PATH" = "/" ]; then
  REL_PATH="/index.html"
fi

TARGET_FILE="${BASE_PATH}${REL_PATH}"

if echo "$TARGET_FILE" | grep -q '\.\.'; then
  respond "400 Bad Request" "text/plain; charset=utf-8" "Bad Request"
fi

if [ ! -f "$TARGET_FILE" ]; then
  respond "404 Not Found" "text/plain; charset=utf-8" "404 Not Found"
fi

case "${TARGET_FILE##*.}" in
  html|htm) mime="text/html; charset=utf-8" ;;
  css) mime="text/css; charset=utf-8" ;;
  js|mjs) mime="application/javascript; charset=utf-8" ;;
  json) mime="application/json; charset=utf-8" ;;
  png) mime="image/png" ;;
  jpg|jpeg) mime="image/jpeg" ;;
  svg) mime="image/svg+xml" ;;
  woff) mime="font/woff" ;;
  woff2) mime="font/woff2" ;;
  wasm) mime="application/wasm" ;;
  *) mime="application/octet-stream" ;;
esac

echo "Content-Type: $mime"
case "$REL_PATH" in
  /assets/*) echo "Cache-Control: public, max-age=86400" ;;
  *) echo "Cache-Control: no-cache" ;;
esac
echo ""
cat -- "$TARGET_FILE"
