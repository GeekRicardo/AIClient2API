#!/bin/bash

# Kiro 自动登录脚本
# 功能：自动完成 Google 登录并保存 session，支持批量处理

set -e  # 遇到错误立即退出

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# 默认配置
SESSION_DIR="$HOME/kiro-sessions"
AICLIENT_API_URL="http://aiclient2api.sshug.cn"
ADD_TO_AICLIENT=false
BATCH_MODE=false
BATCH_FILE=""
ACCOUNT_LINE=""
# 失败后等待时间（秒），允许人工介入，默认 60 秒
MANUAL_INTERVENTION_TIMEOUT="${MANUAL_INTERVENTION_TIMEOUT:-60}"
# 代理配置
PROXY_URL="${PROXY_URL:-http://localhost:7892}"
PROXY_API_URL="${PROXY_API_URL:-http://127.0.0.1:9090}"
PROXY_API_TOKEN="${PROXY_API_TOKEN:-iYTW2vgxjvEiWgF9}"
PROXY_GROUP="${PROXY_GROUP:-ApiFixedProxy}"
USE_PROXY="${USE_PROXY:-false}"
# 是否在成功后注释掉账号行
COMMENT_ON_SUCCESS="${COMMENT_ON_SUCCESS:-true}"

# CloakBrowser Manager 配置
CLOAK_MANAGER_URL="${CLOAK_MANAGER_URL:-http://localhost:8080}"
CLOAK_AUTH_TOKEN="${CLOAK_AUTH_TOKEN:-}"
# 任务结束后是否保留 profile（默认删除，保持环境干净）
CLOAK_KEEP_PROFILE="${CLOAK_KEEP_PROFILE:-false}"
# --manual：脚本退出时不关闭浏览器、不停止/删除 profile，留给用户手工操作（抓包/调试）
MANUAL_MODE="${MANUAL_MODE:-false}"
# Manager 内 Chrome 运行的平台标记
CLOAK_PLATFORM="${CLOAK_PLATFORM:-linux}"
# Manager 容器视角的代理地址。未设置时从 PROXY_URL 自动转换：
# 把 localhost / 127.0.0.1 重写为 host.docker.internal，让 Manager 容器
# 通过 docker 网络访问宿主机上 mihomo 暴露的端口。
CLOAK_PROXY_URL="${CLOAK_PROXY_URL:-}"

# 当前正在使用的 Manager profile id（供异常退出时清理）
CURRENT_PROFILE_ID=""

# 日志函数
log_info() {
    echo -e "${BLUE}[INFO]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_prompt() {
    echo -e "${CYAN}[INPUT]${NC} $1"
}

log_batch() {
    echo -e "${MAGENTA}[BATCH]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_proxy() {
    echo -e "${CYAN}[PROXY]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_cloak() {
    echo -e "${CYAN}[CLOAK]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

# === CloakBrowser Manager 调用 ===

# Manager 容器视角的代理 URL：
#   - 显式设置 CLOAK_PROXY_URL 时直接使用
#   - 否则把 PROXY_URL 中的 localhost / 127.0.0.1 重写为 host.docker.internal
_cloak_resolve_proxy() {
    if [ -n "$CLOAK_PROXY_URL" ]; then
        printf '%s' "$CLOAK_PROXY_URL"
        return
    fi
    printf '%s' "$PROXY_URL" | sed -E 's#(://)(127\.0\.0\.1|localhost)([:/]|$)#\1host.docker.internal\3#'
}

# 通过 node 提取 JSON 字段，避免依赖 jq
_cloak_json_field() {
    local field="$1"
    node -e '
        let s = "";
        process.stdin.on("data", c => s += c);
        process.stdin.on("end", () => {
            try {
                const v = JSON.parse(s)[process.argv[1]];
                if (v !== undefined && v !== null) console.log(v);
            } catch (e) {}
        });
    ' "$field"
}

_cloak_curl() {
    if [ -n "$CLOAK_AUTH_TOKEN" ]; then
        curl -s -H "Authorization: Bearer $CLOAK_AUTH_TOKEN" "$@"
    else
        curl -s "$@"
    fi
}

cloak_create_profile() {
    local name="$1"
    local proxy="$2"

    local body
    body=$(node -e '
        const [name, platform, proxy] = process.argv.slice(1);
        const obj = { name, platform };
        if (proxy) obj.proxy = proxy;
        console.log(JSON.stringify(obj));
    ' "$name" "$CLOAK_PLATFORM" "$proxy")

    local resp
    resp=$(_cloak_curl -X POST "$CLOAK_MANAGER_URL/api/profiles" \
        -H 'Content-Type: application/json' -d "$body")

    local id
    id=$(printf '%s' "$resp" | _cloak_json_field id)

    if [ -z "$id" ]; then
        log_error "  [Cloak] 创建 profile 失败: $resp" >&2
        return 1
    fi

    printf '%s' "$id"
}

cloak_launch_profile() {
    local id="$1"

    local resp
    resp=$(_cloak_curl -X POST "$CLOAK_MANAGER_URL/api/profiles/$id/launch" \
        -H 'Content-Type: application/json' -d '{}')

    local cdp
    cdp=$(printf '%s' "$resp" | _cloak_json_field cdp_url)

    if [ -z "$cdp" ]; then
        log_error "  [Cloak] 启动 profile 失败: $resp" >&2
        return 1
    fi

    # cdp_url 一般是 /api/profiles/<id>/cdp，需要拼成完整 URL
    if [[ "$cdp" == /* ]]; then
        printf '%s%s' "$CLOAK_MANAGER_URL" "$cdp"
    else
        printf '%s' "$cdp"
    fi
}

cloak_stop_profile() {
    local id="$1"
    [ -z "$id" ] && return 0
    _cloak_curl -X POST "$CLOAK_MANAGER_URL/api/profiles/$id/stop" > /dev/null 2>&1 || true
}

cloak_delete_profile() {
    local id="$1"
    [ -z "$id" ] && return 0
    _cloak_curl -X DELETE "$CLOAK_MANAGER_URL/api/profiles/$id" > /dev/null 2>&1 || true
}

# 释放当前 profile：先 stop，再按配置决定是否 delete
release_browser() {
    local id="${1:-$CURRENT_PROFILE_ID}"
    [ -z "$id" ] && return 0

    # --manual / MANUAL_MODE=true：完全跳过关闭+删除，保留 profile 给用户手工操作
    if [ "$MANUAL_MODE" = "true" ]; then
        log_cloak "[manual] 保留 profile 不关闭：$id"
        log_cloak "[manual] VNC 端口可在 GET http://localhost:8080/api/profiles/$id 查询"
        log_cloak "[manual] 清理时手动执行：curl -X POST http://localhost:8080/api/profiles/$id/stop && curl -X DELETE http://localhost:8080/api/profiles/$id"
        CURRENT_PROFILE_ID=""
        return 0
    fi

    log_cloak "停止 profile: $id"
    cloak_stop_profile "$id"

    if [ "$CLOAK_KEEP_PROFILE" != "true" ]; then
        log_cloak "删除 profile: $id"
        cloak_delete_profile "$id"
    else
        log_cloak "保留 profile: $id (CLOAK_KEEP_PROFILE=true)"
    fi

    CURRENT_PROFILE_ID=""
}

# 获取可用的代理节点列表
get_proxy_nodes() {
    local response=$(curl -s -H "Authorization: Bearer $PROXY_API_TOKEN" \
        "$PROXY_API_URL/proxies/$PROXY_GROUP" 2>/dev/null)

    if [ $? -ne 0 ] || [ -z "$response" ]; then
        log_error "无法连接到代理 API"
        return 1
    fi

    echo "$response" | jq -r '.all[]' 2>/dev/null
}

# 切换代理节点
switch_proxy_node() {
    local node_name="$1"

    log_proxy "切换代理节点: $node_name"

    local response=$(curl -s -X PUT \
        -H "Authorization: Bearer $PROXY_API_TOKEN" \
        -H "Content-Type: application/json" \
        "$PROXY_API_URL/proxies/$PROXY_GROUP" \
        -d "{\"name\": \"$node_name\"}" 2>/dev/null)

    if [ $? -eq 0 ]; then
        log_success "代理节点已切换: $node_name"
        return 0
    else
        log_error "切换代理节点失败: $node_name"
        return 1
    fi
}

# 为账号选择代理节点（随机）
select_proxy_for_account() {
    local account_index="$1"

    if [ "$USE_PROXY" != "true" ]; then
        return 0
    fi

    log_proxy "获取可用代理节点列表..."

    local nodes=$(get_proxy_nodes)
    if [ $? -ne 0 ] || [ -z "$nodes" ]; then
        log_warning "无法获取代理节点，跳过代理设置"
        return 1
    fi

    # 将节点列表转换为数组
    local nodes_array=()
    while IFS= read -r node; do
        nodes_array+=("$node")
    done <<< "$nodes"

    local node_count=${#nodes_array[@]}
    if [ $node_count -eq 0 ]; then
        log_warning "没有可用的代理节点"
        return 1
    fi

    log_proxy "可用节点数: $node_count"

    # 随机选择节点
    local node_index=$(( RANDOM % node_count ))
    local selected_node="${nodes_array[$node_index]}"

    log_proxy "为账号 #$account_index 随机选择节点: $selected_node"

    # 切换到选中的节点
    switch_proxy_node "$selected_node"

    return $?
}

# 显示使用说明
show_usage() {
    cat << EOF
${GREEN}Kiro 自动登录脚本${NC}

${YELLOW}使用方法：${NC}
  $0 [选项]

${YELLOW}选项：${NC}
  -e, --email EMAIL          Google 邮箱地址
  -p, --password PASSWORD    Google 密码
  -t, --totp-secret SECRET   2FA TOTP 密钥（base32 格式）
  -a, --add-to-aiclient      登录成功后自动添加到 AIClient2API
  -u, --api-url URL          AIClient2API 地址（默认: http://localhost:3300）
  -b, --batch FILE           批量处理模式，从文件读取账号信息
  --account-line LINE        直接指定单行账号（同批量文件格式）
  --manual                   登录完成后不关闭浏览器/不删除 profile（用于手工调试/抓包）
  --use-proxy                启用代理（每个账号自动切换节点）
  --no-comment               成功后不注释账号行（默认会注释）
  -h, --help                 显示此帮助信息

${YELLOW}代理配置（环境变量）：${NC}
  USE_PROXY                  是否启用代理（默认: false）
  PROXY_URL                  代理地址（默认: http://localhost:7892）
  PROXY_API_URL              代理 API 地址（默认: http://127.0.0.1:9090）
  PROXY_API_TOKEN            代理 API Token（默认: iYTW2vgxjvEiWgF9）
  PROXY_GROUP                代理组名称（默认: FixedProxy）
  COMMENT_ON_SUCCESS         成功后是否注释账号行（默认: true）

${YELLOW}CloakBrowser Manager 配置（环境变量）：${NC}
  CLOAK_MANAGER_URL          Manager 地址（默认: http://localhost:8080）
  CLOAK_AUTH_TOKEN           Manager API Token（可选）
  CLOAK_KEEP_PROFILE         任务结束后是否保留 profile（默认: false）
  CLOAK_PLATFORM             profile 平台标记（默认: linux）
  CLOAK_PROXY_URL            Manager 容器视角的代理 URL（可选）
                             未设置时从 PROXY_URL 自动重写 localhost
                             为 host.docker.internal，例如：
                             http://localhost:7892 -> http://host.docker.internal:7892

${YELLOW}批量文件格式：${NC}

  ${CYAN}格式 1（管道分隔）：${NC}
  邮箱|密码|备用邮箱|2FA密钥|年份|国家

  示例：
  ngocahanx@gmail.com|minhtu99@|ngocahanx4901@hotmail.com|nmozl2oyo4zje3qm7pdngvrle4v6w5fy|2024|Vietnam
  user2@gmail.com|pass123|backup@hotmail.com|JBSWY3DPEHPK3PXP|2024|USA

  ${CYAN}格式 2（键值对）：${NC}
  邮箱：LamonViorel@gmail.com
  密码：ejkbsujpbv
  Recovery Email：edrousgurdalb@hotmail.com
  2FA Key：fchhxqntp3gyqcycp2wibvurbdrhy2qt
  登录地址：https://mail.google.com

  （账号之间用空行分隔）

${YELLOW}示例：${NC}
  # 单账号交互式输入
  $0

  # 单账号命令行参数
  $0 -e user@gmail.com -p mypassword -t JBSWY3DPEHPK3PXP

  # 指定单行账号（---- 或 | 分隔均可）
  $0 --account-line "user@gmail.com----password----recovery@hotmail.com----TOTP2FA" -a
  $0 --account-line "user@gmail.com|password|recovery@hotmail.com|TOTP2FA" -a

  # 批量处理
  $0 --batch accounts.txt --add-to-aiclient

  # 批量处理并使用代理
  $0 --batch accounts.txt --add-to-aiclient --use-proxy

  # 批量处理并指定 API 地址
  $0 -b accounts.txt -a -u http://192.168.1.100:3300

  # 使用自定义代理配置
  USE_PROXY=true PROXY_URL=http://localhost:7892 $0 --batch accounts.txt -a

${YELLOW}注意：${NC}
  - 浏览器由 CloakBrowser Manager 托管，需要先启动 Manager（默认 http://localhost:8080）
  - 每个账号会在 Manager 中创建一个独立 profile，避免 cookie 污染
  - 默认任务结束后自动删除 profile，可设 CLOAK_KEEP_PROFILE=true 保留
  - 启用代理后，每个账号会自动切换到不同的代理节点（代理通过 profile.proxy 注入）
  - Session 文件保存在: $SESSION_DIR
  - 批量模式支持两种文件格式，可以混合使用
  - 文件中 # 开头的行会被视为注释跳过
  - 使用 --add-to-aiclient 需要 AIClient2API 服务运行

EOF
}

# 解析批量文件
parse_batch_file() {
    local file="$1"
    local accounts=()

    if [ ! -f "$file" ]; then
        log_error "批量文件不存在: $file"
        exit 1
    fi

    log_info "解析批量文件: $file" >&2

    local current_account=""
    local line_num=0

    while IFS= read -r line || [ -n "$line" ]; do
        ((line_num++))

        # 跳过空行和注释
        if [[ -z "$line" ]] || [[ "$line" =~ ^[[:space:]]*# ]]; then
            # 如果遇到空行且有当前账号，保存它
            if [ -n "$current_account" ]; then
                accounts+=("$current_account")
                current_account=""
            fi
            continue
        fi

        # 格式 1a: 四横线分隔 (email----password----recovery----totp)
        if [[ "$line" =~ ---- ]]; then
            email=$(echo "$line" | cut -d'-' -f1 | xargs)
            password=$(echo "$line" | cut -d'-' -f5 | xargs)
            recovery_email=$(echo "$line" | cut -d'-' -f9 | xargs)
            totp_secret=$(echo "$line" | cut -d'-' -f13- | xargs)

            if [ -n "$email" ] && [ -n "$password" ] && [ -n "$totp_secret" ]; then
                accounts+=("EMAIL=$email|PASSWORD=$password|TOTP=$totp_secret")
                log_info "  [行 $line_num] 解析账号: $email (格式1a: ----分隔)" >&2
            else
                log_warning "  [行 $line_num] 跳过无效行（缺少必需字段）" >&2
            fi
            continue
        fi

        # 格式 1b: 管道分隔 (email|password|recovery|totp|year|country)
        if [[ "$line" =~ \| ]]; then
            IFS='|' read -r email password recovery_email totp_secret year country <<< "$line"

            # 清理空格
            email=$(echo "$email" | xargs)
            password=$(echo "$password" | xargs)
            totp_secret=$(echo "$totp_secret" | xargs)

            if [ -n "$email" ] && [ -n "$password" ] && [ -n "$totp_secret" ]; then
                accounts+=("EMAIL=$email|PASSWORD=$password|TOTP=$totp_secret")
                log_info "  [行 $line_num] 解析账号: $email (格式1b: |分隔)" >&2
            else
                log_warning "  [行 $line_num] 跳过无效行（缺少必需字段）" >&2
            fi
            continue
        fi

        # 格式 2: 键值对
        if [[ "$line" =~ ^[[:space:]]*(邮箱|密码|Recovery[[:space:]]Email|2FA[[:space:]]Key|登录地址)[:：] ]]; then
            local key=$(echo "$line" | cut -d':' -f1 | cut -d'：' -f1 | xargs)
            local value=$(echo "$line" | cut -d':' -f2- | cut -d'：' -f2- | xargs)

            case "$key" in
                "邮箱")
                    current_account="EMAIL=$value"
                    ;;
                "密码")
                    current_account="$current_account|PASSWORD=$value"
                    ;;
                "Recovery Email")
                    # 可选字段，不处理
                    ;;
                "2FA Key")
                    current_account="$current_account|TOTP=$value"
                    ;;
                "登录地址")
                    # 可选字段，不处理
                    ;;
            esac
        fi

    done < "$file"

    # 保存最后一个账号
    if [ -n "$current_account" ]; then
        accounts+=("$current_account")
    fi

    log_success "共解析到 ${#accounts[@]} 个账号" >&2

    # 返回账号数组
    printf '%s\n' "${accounts[@]}"
}

# 从账号字符串提取信息
extract_account_info() {
    local account_str="$1"

    local email=$(echo "$account_str" | grep -o 'EMAIL=[^|]*' | cut -d'=' -f2)
    local password=$(echo "$account_str" | grep -o 'PASSWORD=[^|]*' | cut -d'=' -f2)
    local totp=$(echo "$account_str" | grep -o 'TOTP=[^|]*' | cut -d'=' -f2)

    echo "$email|$password|$totp"
}

# 安全读取密码（不显示输入）
read_password() {
    local prompt="$1"
    local password=""

    echo -ne "${CYAN}[INPUT]${NC} $prompt"

    # 关闭回显
    stty -echo
    read password
    stty echo
    echo ""

    echo "$password"
}

# 读取用户输入
read_input() {
    local prompt="$1"
    local default="$2"
    local value=""

    if [ -n "$default" ]; then
        log_prompt "$prompt [默认: $default]: "
        read value
        value="${value:-$default}"
    else
        log_prompt "$prompt: "
        read value
    fi

    echo "$value"
}

# 验证邮箱格式
validate_email() {
    local email="$1"
    if [[ "$email" =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; then
        return 0
    else
        return 1
    fi
}

# 验证 TOTP 密钥格式
validate_totp_secret() {
    local secret="$1"
    # Base32 字符集：A-Z, 2-7
    if [[ "$secret" =~ ^[A-Z2-7]+$ ]] && [ ${#secret} -ge 16 ]; then
        return 0
    else
        return 1
    fi
}

# 生成 TOTP 验证码的函数
generate_totp() {
    local secret="$1"

    cat > /tmp/generate_totp.js << 'EOF'
const crypto = require('crypto');

function base32Decode(base32) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    base32 = base32.toUpperCase().replace(/=+$/, '');

    for (let i = 0; i < base32.length; i++) {
        const val = alphabet.indexOf(base32[i]);
        if (val === -1) throw new Error('Invalid base32 character');
        bits += val.toString(2).padStart(5, '0');
    }

    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.substr(i, 8), 2));
    }

    return Buffer.from(bytes);
}

function generateTOTP(secret, timeStep = 30) {
    const time = Math.floor(Date.now() / 1000 / timeStep);
    const timeBuffer = Buffer.alloc(8);
    timeBuffer.writeBigUInt64BE(BigInt(time));

    const key = base32Decode(secret);
    const hmac = crypto.createHmac('sha1', key);
    hmac.update(timeBuffer);
    const hash = hmac.digest();

    const offset = hash[hash.length - 1] & 0xf;
    const binary = ((hash[offset] & 0x7f) << 24) |
                   ((hash[offset + 1] & 0xff) << 16) |
                   ((hash[offset + 2] & 0xff) << 8) |
                   (hash[offset + 3] & 0xff);

    const otp = binary % 1000000;
    return otp.toString().padStart(6, '0');
}

const secret = process.argv[2];
const code = generateTOTP(secret);
console.log(code);
EOF

    TOTP_CODE=$(node /tmp/generate_totp.js "$secret")
    echo "$TOTP_CODE"
}

# 提取 RefreshToken
extract_refresh_token() {
    local session_file="$1"

    cat > /tmp/extract_refresh_token.js << 'EOF'
const fs = require('fs');

const sessionFile = process.argv[2];
const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));

const refreshTokenCookie = session.cookies.find(cookie =>
    cookie.name === 'RefreshToken' && cookie.domain === 'app.kiro.dev'
);

if (refreshTokenCookie) {
    console.log(refreshTokenCookie.value);
} else {
    console.error('RefreshToken not found');
    process.exit(1);
}
EOF

    local refresh_token=$(node /tmp/extract_refresh_token.js "$session_file" 2>/dev/null)
    rm -f /tmp/extract_refresh_token.js

    echo "$refresh_token"
}

# 登录到 AIClient2API 获取 token
login_to_aiclient() {
    local password="${AICLIENT_PASSWORD:-admin123}"

    local response=$(curl -s -X POST "$AICLIENT_API_URL/api/login" \
        -H "Content-Type: application/json" \
        -d "{\"password\": \"$password\"}")

    local token=$(echo "$response" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

    if [ -n "$token" ]; then
        echo "$token"
        return 0
    else
        log_error "登录失败: $response"
        return 1
    fi
}

# 添加到 AIClient2API（使用批量导入 API）
# 把 email 作为 customName 写回刚导入的 kiro provider
# 参数：$1 = auth_token, $2 = 凭证文件路径(由 batch-import 返回), $3 = email
update_provider_custom_name() {
    local auth_token="$1"
    local cred_path="$2"
    local email="$3"

    # 1. 拉 claude-kiro-oauth provider 列表，找到 KIRO_OAUTH_CREDS_FILE_PATH 匹配的 uuid
    local providers_resp=$(curl -s -X GET "$AICLIENT_API_URL/api/providers/claude-kiro-oauth" \
        -H "Authorization: Bearer $auth_token")
    local target_uuid=$(echo "$providers_resp" | node -e "
let buf='';process.stdin.on('data',c=>buf+=c);process.stdin.on('end',()=>{
  try {
    const data = JSON.parse(buf);
    const cp = process.argv[1];
    const norm = s => (s || '').replace(/\\\\/g, '/').replace(/^\\.\\//, '');
    const target = norm(cp);
    const p = (data.providers || []).find(p => norm(p.KIRO_OAUTH_CREDS_FILE_PATH) === target);
    if (p) console.log(p.uuid);
  } catch (e) {}
});
" "$cred_path" 2>/dev/null)

    if [ -z "$target_uuid" ]; then
        log_warning "  [customName] 未找到 cred_path=$cred_path 对应的 provider，跳过 customName 设置"
        return 1
    fi
    log_info "  [customName] 匹配到 provider uuid=$target_uuid"

    # 2. PUT 更新 customName
    local update_resp=$(curl -s -X PUT "$AICLIENT_API_URL/api/providers/claude-kiro-oauth/$target_uuid" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $auth_token" \
        -d "{\"providerConfig\":{\"customName\":\"$email\"}}")

    if echo "$update_resp" | grep -q '"success":true\|"customName"'; then
        log_success "  [customName] 已设置: $email"
    else
        log_warning "  [customName] 设置失败: $(echo "$update_resp" | head -c 200)"
    fi
}

add_to_aiclient() {
    local email="$1"
    local refresh_token="$2"

    log_info "添加到 AIClient2API: $email"

    # 检查 AIClient2API 是否运行
    if ! curl -s -f "$AICLIENT_API_URL/api/health" > /dev/null 2>&1; then
        log_error "无法连接到 AIClient2API 服务 ($AICLIENT_API_URL)"
        return 1
    fi

    # 登录获取 token
    local auth_token=$(login_to_aiclient)
    if [ -z "$auth_token" ]; then
        log_error "无法获取认证 token"
        return 1
    fi

    # 使用批量导入 API（会自动刷新 token 获取完整认证信息）
    local response=$(curl -s -X POST "$AICLIENT_API_URL/api/kiro/batch-import-tokens" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $auth_token" \
        -d "{
            \"refreshTokens\": [\"$refresh_token\"]
        }")

    # 检查响应（这个 API 返回的是 SSE 流，最后一个 event 是 complete）
    if echo "$response" | grep -q '"success":true'; then
        log_success "已添加到 AIClient2API"
        # 提取保存的文件路径
        local cred_path=$(echo "$response" | grep -o '"path":"[^"]*"' | head -1 | cut -d'"' -f4)
        if [ -n "$cred_path" ]; then
            log_info "  凭证文件: $cred_path"
            # 把 email 作为 customName 写回到刚刚导入的 provider
            update_provider_custom_name "$auth_token" "$cred_path" "$email"
        else
            log_warning "  [校验] 响应中未找到 cred path，无法设置 customName"
        fi
        return 0
    else
        local error_msg=$(echo "$response" | grep -o '"error":"[^"]*"' | cut -d'"' -f4)
        if [ -z "$error_msg" ]; then
            error_msg="$response"
        fi
        log_error "添加失败: $error_msg"
        return 1
    fi
}

# 清理函数
cleanup() {
    rm -f /tmp/generate_totp.js /tmp/extract_kiro_cookies.js /tmp/extract_refresh_token.js

    # 异常退出时释放当前正在使用的 Manager profile
    if [ -n "$CURRENT_PROFILE_ID" ]; then
        release_browser "$CURRENT_PROFILE_ID"
    fi
}

# 设置退出时清理
trap cleanup EXIT

# 解析命令行参数
parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -e|--email)
                EMAIL="$2"
                shift 2
                ;;
            -p|--password)
                PASSWORD="$2"
                shift 2
                ;;
            -t|--totp-secret)
                TOTP_SECRET="$2"
                shift 2
                ;;
            -a|--add-to-aiclient)
                ADD_TO_AICLIENT=true
                shift
                ;;
            -u|--api-url)
                AICLIENT_API_URL="$2"
                shift 2
                ;;
            -b|--batch)
                BATCH_MODE=true
                BATCH_FILE="$2"
                shift 2
                ;;
            --account-line)
                ACCOUNT_LINE="$2"
                shift 2
                ;;
            --manual)
                MANUAL_MODE=true
                shift
                ;;
            --use-proxy)
                USE_PROXY=true
                shift
                ;;
            --no-comment)
                COMMENT_ON_SUCCESS=false
                shift
                ;;
            -h|--help)
                show_usage
                exit 0
                ;;
            *)
                log_error "未知参数: $1"
                show_usage
                exit 1
                ;;
        esac
    done
}

# 获取登录信息
get_credentials() {
    echo ""
    log_info "=========================================="
    log_info "请输入 Kiro 登录信息"
    log_info "=========================================="
    echo ""

    # 获取邮箱
    while [ -z "$EMAIL" ]; do
        EMAIL=$(read_input "请输入 Google 邮箱地址")

        if ! validate_email "$EMAIL"; then
            log_error "邮箱格式不正确，请重新输入"
            EMAIL=""
        fi
    done
    log_success "邮箱: $EMAIL"

    # 获取密码
    while [ -z "$PASSWORD" ]; do
        PASSWORD=$(read_password "请输入 Google 密码（输入不可见）: ")

        if [ -z "$PASSWORD" ]; then
            log_error "密码不能为空，请重新输入"
        fi
    done
    log_success "密码已设置（已隐藏）"

    # 获取 TOTP 密钥
    while [ -z "$TOTP_SECRET" ]; do
        echo ""
        log_info "2FA TOTP 密钥说明："
        log_info "  - 这是 Google Authenticator 的密钥（base32 格式）"
        log_info "  - 通常是一串大写字母和数字（如：JBSWY3DPEHPK3PXP）"
        log_info "  - 可以在 Google 账户的两步验证设置中找到"
        echo ""

        TOTP_SECRET=$(read_input "请输入 2FA TOTP 密钥")

        # 转换为大写并移除空格
        TOTP_SECRET=$(echo "$TOTP_SECRET" | tr '[:lower:]' '[:upper:]' | tr -d ' ')

        if ! validate_totp_secret "$TOTP_SECRET"; then
            log_error "TOTP 密钥格式不正确（应为 base32 格式，至少 16 个字符）"
            log_error "示例格式：JBSWY3DPEHPK3PXP"
            TOTP_SECRET=""
        fi
    done
    log_success "2FA 密钥已设置"

    # 询问是否添加到 AIClient2API
    if [ "$ADD_TO_AICLIENT" = false ]; then
        echo ""
        log_prompt "是否添加到 AIClient2API？(y/N): "
        read add_choice
        if [[ "$add_choice" =~ ^[Yy]$ ]]; then
            ADD_TO_AICLIENT=true
        fi
    fi

    echo ""
    log_info "=========================================="
    log_success "登录信息收集完成"
    log_info "=========================================="
    echo ""
}

# 执行单个账号登录
process_single_account() {
    local email="$1"
    local password="$2"
    local totp_secret="$3"
    local account_index="$4"

    # 生成 session 文件名（使用邮箱前缀）
    local email_prefix=$(echo "$email" | cut -d'@' -f1)
    # playwright-cli 只能保存到当前目录，先保存到这里
    local session_file="${email_prefix}-session.json"
    local kiro_only_session="${email_prefix}-kiro-only.json"
    # 最终目标路径（如果不添加到 AIClient，则移动到这里）
    local final_session_file="$SESSION_DIR/${email_prefix}-session.json"
    local final_kiro_session="$SESSION_DIR/${email_prefix}-kiro-only.json"

    log_info "=========================================="
    log_info "处理账号 [$account_index]: $email"
    log_info "=========================================="

    # 为账号选择代理节点
    select_proxy_for_account "$account_index"

    # 步骤 1: 通过 CloakBrowser Manager 创建并启动新 profile
    log_info "步骤 1/10: 通过 CloakBrowser Manager 启动 profile"

    local proxy_for_profile=""
    if [ "$USE_PROXY" = "true" ]; then
        proxy_for_profile=$(_cloak_resolve_proxy)
        log_proxy "宿主代理: $PROXY_URL -> 容器内代理: $proxy_for_profile"
    fi

    local profile_name="kiro-${email_prefix}-$(date +%s)"
    local profile_id
    if ! profile_id=$(cloak_create_profile "$profile_name" "$proxy_for_profile"); then
        log_error "  [校验失败] 创建 Manager profile 失败"
        return 1
    fi
    CURRENT_PROFILE_ID="$profile_id"
    log_success "Profile 已创建: $profile_id ($profile_name)"

    local cdp_url
    if ! cdp_url=$(cloak_launch_profile "$profile_id"); then
        log_error "  [校验失败] 启动 Manager profile 失败"
        release_browser "$profile_id"
        return 1
    fi
    log_success "Profile 已启动 (CDP: $cdp_url)"
    sleep 2

    # 步骤 2: 通过 CDP 连接到 profile
    log_info "步骤 2/10: 通过 CDP 连接到 profile"
    if ! playwright-cli attach --cdp="$cdp_url" > /dev/null 2>&1; then
        log_error "  [校验失败] CDP 连接失败: $cdp_url"
        release_browser "$profile_id"
        return 1
    fi
    log_success "已连接"
    sleep 2

    # 步骤 3: 访问 Kiro 登录页面
    log_info "步骤 3/10: 访问 Kiro 登录页面"
    playwright-cli goto https://app.kiro.dev/signin > /dev/null 2>&1
    sleep 3

    # 验证是否到达登录页面（循环等待）
    local retry=0
    local page_loaded=false
    while [ $retry -lt 15 ]; do
        local page_title=$(playwright-cli --raw eval "document.title" 2>/dev/null || echo "")
        local page_url=$(playwright-cli --raw eval "window.location.href" 2>/dev/null || echo "")

        log_info "  [校验] 页面标题: ${page_title:0:50}, URL: ${page_url:0:50}"

        # 检查标题和 URL
        if ([[ "$page_title" == *"Sign In"* ]] || [[ "$page_title" == *"登录"* ]] || [[ "$page_title" == *"Kiro"* ]]) && [[ "$page_url" == *"app.kiro.dev"* ]]; then
            page_loaded=true
            log_success "  [校验通过] 已到达 Kiro 登录页面"
            break
        fi

        log_warning "  [等待] 页面加载中... (尝试 $((retry+1))/15)"
        sleep 2
        ((retry++))
    done

    if [ "$page_loaded" = false ]; then
        log_error "  [校验失败] Kiro 登录页面加载超时"
        log_warning "  [人工介入] 等待 $MANUAL_INTERVENTION_TIMEOUT 秒，允许人工操作..."

        # 等待期间持续检查
        local wait_count=0
        local max_wait=$MANUAL_INTERVENTION_TIMEOUT

        while [ $wait_count -lt $max_wait ]; do
            sleep 5
            wait_count=$((wait_count + 5))

            local page_title=$(playwright-cli --raw eval "document.title" 2>/dev/null || echo "")
            local page_url=$(playwright-cli --raw eval "window.location.href" 2>/dev/null || echo "")

            if ([[ "$page_title" == *"Sign In"* ]] || [[ "$page_title" == *"登录"* ]] || [[ "$page_title" == *"Kiro"* ]]) && [[ "$page_url" == *"app.kiro.dev"* ]]; then
                log_success "  [人工介入成功] 页面已加载"
                page_loaded=true
                break
            fi

            log_info "  [等待中] 已等待 $wait_count/$max_wait 秒..."
        done

        if [ "$page_loaded" = false ]; then
            log_error "  [超时] 页面仍未加载"
            release_browser "$profile_id"
            return 1
        fi
    fi

    log_success "已打开登录页面"

    # 步骤 4: 点击 Google 登录按钮
    log_info "步骤 4/10: 点击 Google 登录"

    # 等待 Google 登录按钮出现并验证
    local retry=0
    local button_found=false
    while [ $retry -lt 10 ]; do
        local button_text=$(playwright-cli --raw eval "Array.from(document.querySelectorAll('button')).map(b => b.textContent).join('|')" 2>/dev/null || echo "")
        log_info "  [校验] 页面按钮: ${button_text:0:100}"

        if [[ "$button_text" == *"Google"* ]]; then
            button_found=true
            log_success "  [校验通过] 找到 Google 登录按钮"
            break
        fi
        log_warning "  [等待] Google 登录按钮... (尝试 $((retry+1))/10)"
        sleep 2
        ((retry++))
    done

    if [ "$button_found" = false ]; then
        log_error "  [校验失败] 未找到 Google 登录按钮"
        log_warning "  [人工介入] 等待 $MANUAL_INTERVENTION_TIMEOUT 秒，允许人工操作..."

        # 等待期间持续检查
        local wait_count=0
        local max_wait=$MANUAL_INTERVENTION_TIMEOUT

        while [ $wait_count -lt $max_wait ]; do
            sleep 5
            wait_count=$((wait_count + 5))

            local button_text=$(playwright-cli --raw eval "Array.from(document.querySelectorAll('button')).map(b => b.textContent).join('|')" 2>/dev/null || echo "")
            if [[ "$button_text" == *"Google"* ]]; then
                log_success "  [人工介入成功] 找到 Google 登录按钮"
                button_found=true
                break
            fi

            log_info "  [等待中] 已等待 $wait_count/$max_wait 秒..."
        done

        if [ "$button_found" = false ]; then
            log_error "  [超时] 仍未找到按钮"
            release_browser "$profile_id"
            return 1
        fi
    fi

    playwright-cli click "getByRole('button', { name: 'Google Sign in' })" > /dev/null 2>&1
    log_success "已点击 Google 登录按钮"
    sleep 3

    # 步骤 5: 填写邮箱
    log_info "步骤 5/10: 填写邮箱"

    # 等待跳转到 Google 登录页面并验证
    retry=0
    local google_page_loaded=false
    while [ $retry -lt 15 ]; do
        local current_url=$(playwright-cli --raw eval "window.location.href" 2>/dev/null || echo "")
        log_info "  [校验] 当前 URL: ${current_url:0:80}"

        if [[ "$current_url" == *"accounts.google.com"* ]]; then
            google_page_loaded=true
            log_success "  [校验通过] 已跳转到 Google 登录页面"
            break
        fi
        log_warning "  [等待] 跳转到 Google 登录页面... (尝试 $((retry+1))/15)"
        sleep 2
        ((retry++))
    done

    if [ "$google_page_loaded" = false ]; then
        log_error "  [校验失败] 未跳转到 Google 登录页面"
        log_warning "  [人工介入] 等待 $MANUAL_INTERVENTION_TIMEOUT 秒，允许人工操作..."

        # 等待期间持续检查
        local wait_count=0
        local max_wait=$MANUAL_INTERVENTION_TIMEOUT

        while [ $wait_count -lt $max_wait ]; do
            sleep 5
            wait_count=$((wait_count + 5))

            local current_url=$(playwright-cli --raw eval "window.location.href" 2>/dev/null || echo "")
            if [[ "$current_url" == *"accounts.google.com"* ]]; then
                log_success "  [人工介入成功] 已跳转到 Google 登录页面"
                google_page_loaded=true
                break
            fi

            log_info "  [等待中] 已等待 $wait_count/$max_wait 秒..."
        done

        if [ "$google_page_loaded" = false ]; then
            log_error "  [超时] 仍未跳转到 Google 登录页面"
            release_browser "$profile_id"
            return 1
        fi
    fi

    # 等待邮箱输入框出现
    retry=0
    local email_input_found=false
    while [ $retry -lt 10 ]; do
        local has_email_input=$(playwright-cli --raw eval "document.querySelector('input[type=email]') !== null" 2>/dev/null || echo "false")
        log_info "  [校验] 邮箱输入框存在: $has_email_input"

        if [[ "$has_email_input" == "true" ]]; then
            email_input_found=true
            log_success "  [校验通过] 找到邮箱输入框"
            break
        fi
        log_warning "  [等待] 邮箱输入框... (尝试 $((retry+1))/10)"
        sleep 2
        ((retry++))
    done

    if [ "$email_input_found" = false ]; then
        log_error "  [校验失败] 未找到邮箱输入框"
        log_warning "  [人工介入] 等待 $MANUAL_INTERVENTION_TIMEOUT 秒，允许人工操作..."

        # 等待期间持续检查
        local wait_count=0
        local max_wait=$MANUAL_INTERVENTION_TIMEOUT

        while [ $wait_count -lt $max_wait ]; do
            sleep 5
            wait_count=$((wait_count + 5))

            local has_email_input=$(playwright-cli --raw eval "document.querySelector('input[type=email]') !== null" 2>/dev/null || echo "false")
            if [[ "$has_email_input" == "true" ]]; then
                log_success "  [人工介入成功] 找到邮箱输入框"
                email_input_found=true
                break
            fi

            log_info "  [等待中] 已等待 $wait_count/$max_wait 秒..."
        done

        if [ "$email_input_found" = false ]; then
            log_error "  [超时] 仍未找到邮箱输入框"
            release_browser "$profile_id"
            return 1
        fi
    fi

    sleep 2
    if ! playwright-cli fill "input[type=email]" "$email" 2>&1 | tail -3; then
        log_error "  [校验失败] 填写邮箱失败"
        release_browser "$profile_id"
        return 1
    fi
    local filled_email=$(playwright-cli --raw eval "document.querySelector('input[type=email]').value" 2>/dev/null | sed 's/^"//;s/"$//')
    if [ "$filled_email" != "$email" ]; then
        log_error "  [校验失败] 邮箱填写未生效（实际值: '$filled_email'）"
        release_browser "$profile_id"
        return 1
    fi
    log_success "已填写邮箱: $email"
    sleep 2

    # 步骤 6: 提交邮箱
    log_info "步骤 6/10: 提交邮箱"

    log_info "  [校验] 点击「下一步」按钮"
    if ! playwright-cli click "#identifierNext button" 2>&1 | tail -3; then
        log_error "  [校验失败] 点击邮箱下一步失败"
        release_browser "$profile_id"
        return 1
    fi
    log_success "  [校验通过] 已点击提交"
    sleep 5

    # 检查是否被阻止
    local current_url=$(playwright-cli --raw eval "window.location.href" 2>/dev/null || echo "")
    log_info "  [校验] 提交后 URL: ${current_url:0:80}"

    if [[ "$current_url" == *"rejected"* ]]; then
        log_error "  [校验失败] Google 阻止了登录（可能需要人机验证）"
        log_warning "  [人工介入] 等待 $MANUAL_INTERVENTION_TIMEOUT 秒，允许人工操作..."
        log_warning "  [人工介入] 请在浏览器中完成验证，脚本会自动检测是否成功"

        # 等待期间持续检查是否登录成功
        local wait_count=0
        local max_wait=$MANUAL_INTERVENTION_TIMEOUT
        local check_success=false

        while [ $wait_count -lt $max_wait ]; do
            sleep 5
            wait_count=$((wait_count + 5))

            local check_url=$(playwright-cli --raw eval "window.location.href" 2>/dev/null || echo "")

            # 检查是否已经跳转到密码页面或其他非 rejected 页面
            if [[ "$check_url" != *"rejected"* ]] && [[ "$check_url" == *"accounts.google.com"* ]]; then
                log_success "  [人工介入成功] 检测到页面已跳转，继续自动流程"
                check_success=true
                break
            fi

            log_info "  [等待中] 已等待 $wait_count/$max_wait 秒..."
        done

        if [ "$check_success" = false ]; then
            log_error "  [超时] 等待 $MANUAL_INTERVENTION_TIMEOUT 秒后仍未通过验证"
            release_browser "$profile_id"
            return 1
        fi
    else
        log_success "  [校验通过] 邮箱提交成功，未被阻止"
    fi

    # 步骤 7: 填写密码
    log_info "步骤 7/10: 填写密码"

    # 等待密码输入框出现并验证
    retry=0
    local password_input_found=false
    while [ $retry -lt 15 ]; do
        local has_password_input=$(playwright-cli --raw eval "document.querySelector('input[type=password]') !== null" 2>/dev/null || echo "false")
        log_info "  [校验] 密码输入框存在: $has_password_input"

        if [[ "$has_password_input" == "true" ]]; then
            password_input_found=true
            log_success "  [校验通过] 找到密码输入框"
            break
        fi
        log_warning "  [等待] 密码输入框... (尝试 $((retry+1))/15)"
        sleep 2
        ((retry++))
    done

    if [ "$password_input_found" = false ]; then
        log_error "  [校验失败] 未找到密码输入框"
        log_warning "  [人工介入] 等待 $MANUAL_INTERVENTION_TIMEOUT 秒，允许人工操作..."

        # 等待期间持续检查
        local wait_count=0
        local max_wait=$MANUAL_INTERVENTION_TIMEOUT

        while [ $wait_count -lt $max_wait ]; do
            sleep 5
            wait_count=$((wait_count + 5))

            local has_password_input=$(playwright-cli --raw eval "document.querySelector('input[type=password]') !== null" 2>/dev/null || echo "false")
            if [[ "$has_password_input" == "true" ]]; then
                log_success "  [人工介入成功] 找到密码输入框"
                password_input_found=true
                break
            fi

            log_info "  [等待中] 已等待 $wait_count/$max_wait 秒..."
        done

        if [ "$password_input_found" = false ]; then
            log_error "  [超时] 仍未找到密码输入框"
            release_browser "$profile_id"
            return 1
        fi
    fi

    sleep 2
    if ! playwright-cli fill "input[type=password]" "$password" 2>&1 | tail -3; then
        log_error "  [校验失败] 填写密码失败"
        release_browser "$profile_id"
        return 1
    fi
    local pwd_len=$(playwright-cli --raw eval "document.querySelector('input[type=password]').value.length" 2>/dev/null | tr -d '"')
    if [ "$pwd_len" != "${#password}" ]; then
        log_error "  [校验失败] 密码填写未生效（长度=$pwd_len, 期望=${#password}）"
        release_browser "$profile_id"
        return 1
    fi
    log_success "  [校验通过] 已填写密码"
    sleep 2

    # 步骤 8: 提交密码
    log_info "步骤 8/10: 提交密码"

    log_info "  [校验] 点击「下一步」按钮"
    if ! playwright-cli click "#passwordNext button" 2>&1 | tail -3; then
        log_error "  [校验失败] 点击密码下一步失败"
        release_browser "$profile_id"
        return 1
    fi
    log_success "  [校验通过] 已点击提交"
    sleep 5

    # 验证提交后的页面状态
    local submit_url=$(playwright-cli --raw eval "window.location.href" 2>/dev/null || echo "")
    log_info "  [校验] 提交后 URL: ${submit_url:0:80}"
    log_success "  [校验通过] 密码提交成功"

    # 步骤 9: 处理 2FA
    log_info "步骤 9/10: 处理 2FA 验证"

    # 等待 2FA 输入框出现并验证
    retry=0
    local totp_input_found=false
    while [ $retry -lt 15 ]; do
        local page_text=$(playwright-cli --raw eval "document.body.textContent" 2>/dev/null || echo "")
        local has_totp_input=$(playwright-cli --raw eval "document.querySelector('input[type=tel]') !== null || document.querySelector('input[type=text]') !== null" 2>/dev/null || echo "false")

        log_info "  [校验] 2FA 输入框存在: $has_totp_input, 页面包含验证码关键词: $(echo "$page_text" | grep -q -i 'code\|verify\|验证码' && echo 'true' || echo 'false')"

        if ([[ "$page_text" == *"验证码"* ]] || [[ "$page_text" == *"code"* ]] || [[ "$page_text" == *"verify"* ]]) && [[ "$has_totp_input" == "true" ]]; then
            totp_input_found=true
            log_success "  [校验通过] 找到 2FA 验证页面"
            break
        fi
        log_warning "  [等待] 2FA 验证页面... (尝试 $((retry+1))/15)"
        sleep 2
        ((retry++))
    done

    if [ "$totp_input_found" = false ]; then
        log_error "  [校验失败] 未找到 2FA 验证页面"
        log_warning "  [人工介入] 等待 $MANUAL_INTERVENTION_TIMEOUT 秒，允许人工操作..."

        # 等待期间持续检查
        local wait_count=0
        local max_wait=$MANUAL_INTERVENTION_TIMEOUT

        while [ $wait_count -lt $max_wait ]; do
            sleep 5
            wait_count=$((wait_count + 5))

            local page_text=$(playwright-cli --raw eval "document.body.textContent" 2>/dev/null || echo "")
            local has_totp_input=$(playwright-cli --raw eval "document.querySelector('input[type=tel]') !== null || document.querySelector('input[type=text]') !== null" 2>/dev/null || echo "false")

            if ([[ "$page_text" == *"验证码"* ]] || [[ "$page_text" == *"code"* ]] || [[ "$page_text" == *"verify"* ]]) && [[ "$has_totp_input" == "true" ]]; then
                log_success "  [人工介入成功] 找到 2FA 验证页面"
                totp_input_found=true
                break
            fi

            # 也检查是否已经跳过 2FA 直接到了 Kiro 页面
            local current_url=$(playwright-cli --raw eval "window.location.href" 2>/dev/null || echo "")
            if [[ "$current_url" == *"app.kiro.dev"* ]] && [[ "$current_url" != *"signin"* ]]; then
                log_success "  [人工介入成功] 已跳过 2FA，直接登录成功"
                # 跳过后续 2FA 步骤，直接到保存 session
                totp_input_found=true
                break
            fi

            log_info "  [等待中] 已等待 $wait_count/$max_wait 秒..."
        done

        if [ "$totp_input_found" = false ]; then
            log_error "  [超时] 仍未找到 2FA 验证页面"
            release_browser "$profile_id"
            return 1
        fi
    fi

    TOTP_CODE=$(generate_totp "$totp_secret")
    log_success "  [校验] 生成 2FA 验证码: $TOTP_CODE"

    sleep 2
    if ! playwright-cli fill "#totpPin" "$TOTP_CODE" 2>&1 | tail -3; then
        log_error "  [校验失败] 填写验证码失败"
        release_browser "$profile_id"
        return 1
    fi
    local totp_filled=$(playwright-cli --raw eval "document.querySelector('#totpPin').value" 2>/dev/null | sed 's/^"//;s/"$//')
    if [ "$totp_filled" != "$TOTP_CODE" ]; then
        log_error "  [校验失败] 验证码填写未生效（实际值: '$totp_filled'）"
        release_browser "$profile_id"
        return 1
    fi
    log_success "  [校验通过] 已填写验证码"
    sleep 2

    log_info "  [校验] 点击「下一步」提交验证码"
    if ! playwright-cli click "#totpNext button" 2>&1 | tail -3; then
        log_error "  [校验失败] 点击验证码下一步失败"
        release_browser "$profile_id"
        return 1
    fi
    log_success "  [校验通过] 已提交验证码 sleep 8"
    sleep 8

    # 检查是否需要授权（Kiro OAuth 页面）
    retry=0
    while [ $retry -lt 10 ]; do
        log_info "检测是否到达 Kiro OAuth 授权页面... (尝试 $((retry+1))/10)"
        CURRENT_URL=$(playwright-cli --raw eval "window.location.href" 2>/dev/null || echo "")
        CURRENT_TITLE=$(playwright-cli --raw eval "document.title" 2>/dev/null || echo "")

        # 检查是否到达 Kiro 授权页面
        if [[ "$CURRENT_URL" == *"kiro"* ]] && ([[ "$CURRENT_TITLE" == *"Đăng nhập"* ]] || [[ "$CURRENT_TITLE" == *"登录"* ]] || [[ "$CURRENT_TITLE" == *"Sign"* ]]); then
            log_info "检测到 Kiro OAuth 授权页面"
            break
        fi
        sleep 1
        ((retry++))
    done

    # 如果在授权页面，先切换语言到美国，然后点击 Continue
    if [[ "$CURRENT_URL" == *"kiro"* ]]; then
        log_info "检测到 Kiro OAuth 授权页面"

        # 尝试切换语言到英语（美国）
        log_info "  [校验] 尝试切换语言到英语"
        sleep 2

        # 检查是否有语言选择框
        local has_combobox=$(playwright-cli --raw eval "document.querySelector('[role=combobox]') !== null" 2>/dev/null || echo "false")
        log_info "  [校验] 语言选择框存在: $has_combobox"

        if [[ "$has_combobox" == "true" ]]; then
            playwright-cli click "getByRole('combobox')" > /dev/null 2>&1 || true
            sleep 1

            # 尝试点击英语选项
            if playwright-cli click "getByRole('option', { name: 'English (United States)' })" > /dev/null 2>&1; then
                log_success "  [校验通过] 已切换到英语（美国）"
            elif playwright-cli click "getByRole('option', { name: 'English' })" > /dev/null 2>&1; then
                log_success "  [校验通过] 已切换到英语"
            else
                log_warning "  [校验] 未找到英语选项，使用当前语言"
            fi
            sleep 1
        else
            log_info "  [校验] 未找到语言选择框，跳过语言切换"
        fi

        # 点击 Continue 按钮（多语言尝试）
        log_info "  [校验] 查找并点击 Continue 按钮"

        # 检查页面上的所有按钮
        local buttons=$(playwright-cli --raw eval "Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()).join('|')" 2>/dev/null || echo "")
        log_info "  [校验] 页面按钮: ${buttons:0:150}"

        local clicked=false
        if playwright-cli click "getByRole('button', { name: 'Continue' })" > /dev/null 2>&1; then
            log_success "  [校验通过] 已点击 Continue 按钮"
            clicked=true
        elif playwright-cli click "getByRole('button', { name: 'Tiếp tục' })" > /dev/null 2>&1; then
            log_success "  [校验通过] 已点击 Tiếp tục 按钮"
            clicked=true
        elif playwright-cli click "getByRole('button', { name: '继续' })" > /dev/null 2>&1; then
            log_success "  [校验通过] 已点击继续按钮"
            clicked=true
        else
            log_warning "  [校验失败] 未找到 Continue 按钮，可能需要人工介入"
        fi

        if [ "$clicked" = true ]; then
            log_success "已授权"
        else
            log_warning "授权可能未完成，等待人工确认..."
        fi
        sleep 5
    fi

    # 等待回到 Kiro 页面
    retry=0
    while [ $retry -lt 15 ]; do
        local final_url=$(playwright-cli --raw eval "window.location.href" 2>/dev/null || echo "")
        if [[ "$final_url" == *"app.kiro.dev"* ]] && [[ "$final_url" != *"signin"* ]]; then
            log_success "已成功登录到 Kiro"
            break
        fi
        sleep 1
        ((retry++))
    done

    # 步骤 10: 保存 session
    log_info "步骤 10/10: 保存 session"
    sleep 3

    log_info "  [校验] 保存 session 到当前目录: $session_file"

    # 保存 session 并检查是否成功
    if ! playwright-cli state-save "$session_file" 2>&1; then
        log_error "  [校验失败] 保存 session 失败"
        release_browser "$profile_id"
        return 1
    fi

    # 验证文件是否真的创建了
    if [ ! -f "$session_file" ]; then
        log_error "  [校验失败] Session 文件未创建: $session_file"
        release_browser "$profile_id"
        return 1
    fi

    log_success "  [校验通过] Session 文件已创建"

    # 提取 Kiro cookies
    log_info "  [校验] 提取 Kiro cookies"
    cat > /tmp/extract_kiro_cookies.js << 'EOF'
const fs = require('fs');
const sessionFile = process.argv[2];
const outputFile = process.argv[3];

try {
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    const kiroCookies = session.cookies.filter(cookie =>
        cookie.domain === 'app.kiro.dev' || cookie.domain === '.app.kiro.dev'
    );
    const kiroSession = { cookies: kiroCookies, origins: [] };
    fs.writeFileSync(outputFile, JSON.stringify(kiroSession, null, 2));
    console.log('SUCCESS');
} catch (error) {
    console.error('ERROR:', error.message);
    process.exit(1);
}
EOF

    if ! node /tmp/extract_kiro_cookies.js "$session_file" "$kiro_only_session" 2>&1 | grep -q "SUCCESS"; then
        log_error "  [校验失败] 提取 Kiro cookies 失败"
        release_browser "$profile_id"
        return 1
    fi

    log_success "  [校验通过] Kiro cookies 已提取: $kiro_only_session"

    # 验证登录
    FINAL_URL=$(playwright-cli --raw eval "window.location.href" 2>/dev/null || echo "")
    if [[ "$FINAL_URL" == *"app.kiro.dev"* ]] && [[ "$FINAL_URL" != *"signin"* ]]; then
        log_success "登录成功！"
    else
        log_warning "登录可能未完全成功"
    fi

    # 添加到 AIClient2API
    if [ "$ADD_TO_AICLIENT" = true ]; then
        log_info "提取 RefreshToken 并同步到 AIClient2API..."
        REFRESH_TOKEN=$(extract_refresh_token "$session_file")

        if [ -n "$REFRESH_TOKEN" ]; then
            log_success "  [校验通过] RefreshToken 提取成功"
            if add_to_aiclient "$email" "$REFRESH_TOKEN"; then
                log_success "  [校验通过] 已同步到 AIClient2API"
                # 同步成功后删除本地 session 文件
                log_info "  [清理] 删除本地 session 文件"
                rm -f "$session_file" "$kiro_only_session"
                log_success "  [清理完成] 本地文件已删除"
            else
                log_error "  [校验失败] 同步到 AIClient2API 失败"
                # 同步失败，移动文件到目标目录保留
                mkdir -p "$SESSION_DIR"
                mv "$session_file" "$final_session_file" 2>/dev/null || true
                mv "$kiro_only_session" "$final_kiro_session" 2>/dev/null || true
                log_info "  [保留] Session 文件已移动到: $SESSION_DIR"
            fi
        else
            log_error "  [校验失败] 无法提取 RefreshToken"
            # 提取失败，移动文件到目标目录保留
            mkdir -p "$SESSION_DIR"
            mv "$session_file" "$final_session_file" 2>/dev/null || true
            mv "$kiro_only_session" "$final_kiro_session" 2>/dev/null || true
            log_info "  [保留] Session 文件已移动到: $SESSION_DIR"
        fi
    else
        # 不添加到 AIClient2API，移动文件到目标目录
        log_info "  [校验] 移动 session 文件到目标目录"
        mkdir -p "$SESSION_DIR"
        if mv "$session_file" "$final_session_file" 2>&1 && mv "$kiro_only_session" "$final_kiro_session" 2>&1; then
            log_success "  [校验通过] Session 文件已保存到: $SESSION_DIR"
        else
            log_warning "  [校验] 移动文件失败，文件保留在当前目录"
        fi
    fi

    # 步骤 11: 点击 Upgrade to Pro 并捕获 Stripe 链接
    log_info "步骤 11: 点击 Upgrade to Pro 并捕获 Stripe 链接"
    capture_stripe_upgrade_url "$email"

    # 关闭并释放 Manager profile
    log_info "关闭浏览器..."
    release_browser "$profile_id"
    sleep 2

    log_success "账号 [$account_index] 处理完成"
    echo ""
}

# 点击 Upgrade to Pro 并把跳转的 Stripe URL 保存到 scripts/stripe-urls/<email>.txt
# 需要在 release_browser 之前调用，依赖当前 playwright-cli 已 attach 到浏览器
capture_stripe_upgrade_url() {
    local email="$1"
    local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local stripe_dir="$script_dir/stripe-urls"
    mkdir -p "$stripe_dir"
    local stripe_file="$stripe_dir/${email}.txt"

    # 1. 确保在 Kiro 账号页
    local cur=$(playwright-cli --raw eval "window.location.href" 2>/dev/null | sed 's/^"//;s/"$//')
    if [[ "$cur" != *"app.kiro.dev"* ]] || [[ "$cur" == *"signin"* ]]; then
        playwright-cli goto "https://app.kiro.dev/account/usage" 2>&1 | tail -1 || true
        sleep 4
    fi

    # 2. 精确匹配文本为 "Upgrade to Pro" 的按钮（避开 "Upgrade to Pro+" / "Upgrade to Power"）
    local click_result=$(playwright-cli --raw eval "
        (() => {
            const els = Array.from(document.querySelectorAll('a, button, [role=button]'));
            const m = els.find(e => /^upgrade to pro$/i.test((e.textContent||'').trim()));
            if (!m) return 'NOT_FOUND';
            m.scrollIntoView();
            m.click();
            return 'CLICKED';
        })()
    " 2>/dev/null | sed 's/^"//;s/"$//')

    if [[ "$click_result" != "CLICKED" ]]; then
        log_warning "  [跳过] 未找到 'Upgrade to Pro' 按钮（结果: $click_result）"
        return 0
    fi
    log_info "  [校验] 已点击 Upgrade to Pro 按钮，等待 Stripe 新 tab..."

    # 3. 轮询 tab-list 找 stripe.com 的 tab（最多 15 秒）
    local stripe_url=""
    for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
        sleep 1
        stripe_url=$(playwright-cli tab-list 2>&1 | grep -oE 'https://[^])[:space:]]*stripe\.com[^])[:space:]]*' | head -1)
        if [ -n "$stripe_url" ]; then
            break
        fi
    done

    if [ -n "$stripe_url" ]; then
        echo "$stripe_url" > "$stripe_file"
        log_success "  [校验通过] Stripe URL 已保存: $stripe_file"
        log_info "  URL[0..100]: ${stripe_url:0:100}"
    else
        log_warning "  [校验失败] 15 秒内未出现 Stripe tab"
        log_info "  当前 tab 列表:"
        playwright-cli tab-list 2>&1 | grep '^- ' | head -5 | while read -r ln; do log_info "    $ln"; done
    fi
}

# 注释掉批量文件中的指定行
comment_out_line() {
    local file="$1"
    local line_number="$2"

    # 使用 sed 在指定行开头添加 #（如果还没有 #）
    sed -i.bak "${line_number}s/^[^#]/# &/" "$file"
    rm -f "${file}.bak"

    log_info "  [标记] 已在文件中注释掉第 $line_number 行"
}

# 批量处理模式
batch_process() {
    log_batch "=========================================="
    log_batch "批量处理模式"
    log_batch "=========================================="
    echo ""

    # 解析批量文件（兼容不支持 mapfile 的 shell）
    local accounts=()
    local account_lines=()  # 存储每个账号对应的原始行内容

    while IFS= read -r line; do
        accounts+=("$line")
        account_lines+=("$line")
    done < <(parse_batch_file "$BATCH_FILE")

    if [ ${#accounts[@]} -eq 0 ]; then
        log_error "没有找到有效的账号信息"
        exit 1
    fi

    log_batch "开始处理 ${#accounts[@]} 个账号..."
    echo ""

    local success_count=0
    local fail_count=0
    local failed_emails=()

    for i in "${!accounts[@]}"; do
        local account_info=$(extract_account_info "${accounts[$i]}")
        IFS='|' read -r email password totp <<< "$account_info"

        if [ -n "$email" ] && [ -n "$password" ] && [ -n "$totp" ]; then
            # 转换 TOTP 为大写并移除空格
            totp=$(echo "$totp" | tr '[:lower:]' '[:upper:]' | tr -d ' ')

            if process_single_account "$email" "$password" "$totp" "$((i+1))"; then
                ((success_count++))
                # 成功后在文件中注释掉包含该邮箱的行（如果启用）
                if [ "$COMMENT_ON_SUCCESS" = "true" ]; then
                    sed -i.bak "/^[^#].*${email}/s/^/# /" "$BATCH_FILE"
                    rm -f "${BATCH_FILE}.bak"
                    log_info "  [标记] 已在文件中注释掉账号: $email"
                fi
            else
                ((fail_count++))
                failed_emails+=("$email")
            fi

            # 账号之间等待一段时间
            if [ $((i+1)) -lt ${#accounts[@]} ]; then
                log_batch "等待 5 秒后处理下一个账号..."
                sleep 5
            fi
        else
            log_error "账号 $((i+1)) 信息不完整，跳过"
            ((fail_count++))
            if [ -n "$email" ]; then
                failed_emails+=("$email")
            else
                failed_emails+=("账号 $((i+1)) (邮箱未知)")
            fi
        fi
    done

    echo ""
    log_batch "=========================================="
    log_batch "批量处理完成"
    log_batch "=========================================="
    log_success "成功: $success_count 个账号"

    # 只有失败时才输出失败信息
    if [ $fail_count -gt 0 ]; then
        log_error "失败: $fail_count 个账号"
        echo ""
        log_error "失败账号列表:"
        for failed_email in "${failed_emails[@]}"; do
            log_error "  - $failed_email"
        done
    fi

    log_info "Session 文件保存在: $SESSION_DIR"
    echo ""
}

# 主流程
main() {
    log_info "=========================================="
    log_info "Kiro 自动登录脚本"
    log_info "=========================================="
    echo ""

    # 解析命令行参数
    parse_args "$@"

    # 批量处理模式
    if [ "$BATCH_MODE" = true ]; then
        batch_process
        exit 0
    fi

    # --account-line 单行模式（复用批量文件的解析逻辑）
    if [ -n "$ACCOUNT_LINE" ]; then
        local al_email="" al_password="" al_totp=""
        if [[ "$ACCOUNT_LINE" =~ ---- ]]; then
            al_email=$(echo "$ACCOUNT_LINE"    | cut -d'-' -f1  | xargs)
            al_password=$(echo "$ACCOUNT_LINE" | cut -d'-' -f5  | xargs)
            al_totp=$(echo "$ACCOUNT_LINE"     | cut -d'-' -f13- | xargs)
        elif [[ "$ACCOUNT_LINE" =~ \| ]]; then
            IFS='|' read -r al_email al_password _ al_totp _ _ <<< "$ACCOUNT_LINE"
            al_email=$(echo "$al_email" | xargs)
            al_password=$(echo "$al_password" | xargs)
            al_totp=$(echo "$al_totp" | xargs)
        else
            log_error "--account-line 格式不正确，请使用 ---- 或 | 分隔"
            exit 1
        fi

        if [ -z "$al_email" ] || [ -z "$al_password" ] || [ -z "$al_totp" ]; then
            log_error "--account-line 缺少必需字段（邮箱/密码/2FA）"
            exit 1
        fi

        al_totp=$(echo "$al_totp" | tr '[:lower:]' '[:upper:]' | tr -d ' ')
        log_info "使用 --account-line 指定账号: $al_email"
        process_single_account "$al_email" "$al_password" "$al_totp" "1"
        exit 0
    fi

    # 单账号模式
    if [ -z "$EMAIL" ] || [ -z "$PASSWORD" ] || [ -z "$TOTP_SECRET" ]; then
        get_credentials
    else
        log_info "使用命令行参数提供的登录信息"
        log_success "邮箱: $EMAIL"
        log_success "密码: ******（已隐藏）"
        log_success "2FA 密钥: ******（已隐藏）"
        echo ""
    fi

    # 处理单个账号
    process_single_account "$EMAIL" "$PASSWORD" "$TOTP_SECRET" "1"

    log_info "浏览器已关闭"
}

# 执行主流程
main "$@"
