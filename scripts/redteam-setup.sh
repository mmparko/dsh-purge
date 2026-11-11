#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Red Team Environment Setup — Automated toolkit installer & checker
#
#   bash $DSH_HOME/redteam/setup.sh            # Interactive setup (recommended)
#   bash $DSH_HOME/redteam/setup.sh --yes      # Non-interactive / automatic
#   bash $DSH_HOME/redteam/setup.sh --check    # Diagnostic healthcheck only
#
# Core tasks:
#   1. Install Tools: Download binaries to $DSH_HOME/redteam/toolkit/
#   2. Verify Skills: Confirm skills directory exists and is accessible
#   3. Configuration: Guide setup for FOFA_KEY and VPS reverse shell
#   4. Validation: Verify binaries, templates, and record completion marker
#
# Design principles:
#   - Idempotent: Safe to re-run; existing tools skipped unless --force
#   - Minimal dependencies: Requires only curl / python3 / tar / unzip
#   - Dynamic discovery: Uses GitHub releases/latest API for real asset links
#   - Comprehensive diagnostics: Clear outputs and final health checklist
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
TK="$DSH_HOME/redteam/toolkit"
ENV_FILE="$DSH_HOME/.env"
MARKER="$DSH_HOME/redteam/.setup-complete"
LOG_DIR="$DSH_HOME/redteam"
LOG="$LOG_DIR/setup.log"
ASSUME_YES=0
CHECK_ONLY=0
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --yes|-y)   ASSUME_YES=1 ;;
    --check)    CHECK_ONLY=1 ;;
    --force)    FORCE=1 ;;
    -h|--help)  sed -n '2,20p' "$0"; exit 0 ;;
  esac
done

mkdir -p "$TK" "$LOG_DIR"

# -- Output helpers -----------------------------------------------------------
C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
say()  { printf '%s\n' "$*" | tee -a "$LOG"; }

# Environment notice: drops binaries/tools into toolkit; run in a dedicated lab/VM
if [ -z "${REDTEAM_NO_VM_WARN:-}" ]; then
  say ""
  say "⚠️  Please run Red Team Mode in a dedicated test VM (e.g. Kali Linux):"
  say "    - Tools, scanners, and payloads may trigger local EDR/antivirus warnings;"
  say "    - Scanning and reconnaissance traffic will egress through your local IP;"
  say "    - Dedicated VMs ensure clean isolation. (Set REDTEAM_NO_VM_WARN=1 to skip this warning)"
  say ""
fi
ok()   { say "  ${C_OK}✓${C_OFF} $*"; }
warn() { say "  ${C_WARN}!${C_OFF} $*"; }
bad()  { say "  ${C_ERR}✗${C_OFF} $*"; }
dim()  { say "  ${C_DIM}$*${C_OFF}"; }
head_() { say ""; say "── $* ──────────────────────────────────────────"; }

ask() { # ask <prompt> <default> -> Echo input (defaults when non-interactive)
  local prompt="$1" def="${2:-}"
  if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then printf '%s' "$def"; return; fi
  local ans
  printf '%s' "$prompt" > /dev/tty
  [ -n "$def" ] && printf ' [%s]' "$def" > /dev/tty
  printf ': ' > /dev/tty
  read -r ans < /dev/tty || ans=""
  printf '%s' "${ans:-$def}"
}

ask_secret() { # Silent input
  local prompt="$1"
  if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then printf ''; return; fi
  local ans
  printf '%s: ' "$prompt" > /dev/tty
  read -rs ans < /dev/tty || ans=""
  printf '\n' > /dev/tty
  printf '%s' "$ans"
}

# -- Tool functions -----------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

gh_api() { # gh_api <repo> -> output releases/latest JSON
  local repo="$1" tok=""
  have gh && tok="$(gh auth token 2>/dev/null || true)"
  if [ -n "$tok" ]; then
    curl -s -m 30 -H "Authorization: Bearer $tok" "https://api.github.com/repos/$repo/releases/latest"
  else
    curl -s -m 30 "https://api.github.com/repos/$repo/releases/latest"
  fi
}

dl_asset() { # dl_asset <repo> <asset-regex> <out-path> [executable]
  local repo="$1" pat="$2" out="$3" chmod_x="${4:-1}"
  if [ -s "$out" ] && [ "$FORCE" != 1 ]; then ok "Already installed $(basename "$out")"; return 0; fi
  local json url name
  json="$(gh_api "$repo")"
  read -r name url <<<"$(printf '%s' "$json" | python3 -c "
import json,sys,re
pat=re.compile(sys.argv[1], re.I)
try: j=json.load(sys.stdin)
except Exception: sys.exit(1)
for a in j.get('assets') or []:
    if pat.search(a['name']): print(a['name'], a['browser_download_url']); break
" "$pat")"
  if [ -z "${url:-}" ]; then bad "$repo: No matching asset ($pat)"; return 1; fi
  # Validate exact byte count from API to prevent silent file truncation
  local want
  want="$(printf '%s' "$json" | python3 -c "
import json,sys,re
pat=re.compile(sys.argv[1], re.I)
try: j=json.load(sys.stdin)
except Exception: sys.exit(0)
for a in j.get('assets') or []:
    if pat.search(a['name']): print(a.get('size') or 0); break
" "$pat")"
  dim "Downloading $name (expecting ${want:-?} bytes)"
  if curl -sL --retry 3 --retry-delay 2 --fail -m 600 "$url" -o "$out"; then
    local got; got="$(stat -c%s "$out" 2>/dev/null || echo 0)"
    if [ -n "$want" ] && [ "$want" != "0" ] && [ "$got" != "$want" ]; then
      bad "$name download truncated: expected $want bytes, got $got; removed, please retry"
      rm -f "$out"; return 1
    fi
    [ "$chmod_x" = 1 ] && chmod +x "$out" 2>/dev/null
    ok "$name -> $out ($got bytes, verified)"
  else
    bad "$name download failed (curl exit $?)"; return 1
  fi
}

untar_all() { # untar_all <tarfile> <dir> <bin_names...> -> unpack and extract
  local tf="$1" dir="$2"; shift 2
  ( cd "$dir" && tar xzf "$tf" 2>/dev/null ) || { bad "$(basename "$tf") extraction failed"; return 1; }
  local name found sz
  for name in "$@"; do
    found="$(find "$dir" -maxdepth 3 -type f -name "$name" ! -name "*.tar.gz" 2>/dev/null | head -1)"
    if [ -n "$found" ]; then
      [ "$(dirname "$found")" != "$dir" ] && mv -f "$found" "$dir/$name"
      chmod +x "$dir/$name"
      sz="$(stat -c%s "$dir/$name" 2>/dev/null || echo 0)"
      # Smoke test: execute --version/-h to catch broken binaries or missing shared libraries
      if "$dir/$name" --version >/dev/null 2>&1 || "$dir/$name" -version >/dev/null 2>&1 \
         || "$dir/$name" -h >/dev/null 2>&1 || "$dir/$name" --help >/dev/null 2>&1; then
        ok "$name ready ($sz bytes, smoke test passed)"
      else
        warn "$name installed ($sz bytes) but smoke test gave no output: verify via $dir/$name --help"
      fi
    else
      bad "$name not found in package"
    fi
  done
}

verify_bin() { # verify_bin <path> -> returns 0 if executable runs
  local p="$1"
  [ -x "$p" ] || return 1
  timeout 15 "$p" --version >/dev/null 2>&1 && return 0
  timeout 15 "$p" -version  >/dev/null 2>&1 && return 0
  timeout 15 "$p" -h        >/dev/null 2>&1 && return 0
  timeout 15 "$p" --help    >/dev/null 2>&1 && return 0
  timeout 15 "$p" version   >/dev/null 2>&1 && return 0
  return 1
}

# Pre-install doctor check: removes broken binaries to trigger clean redownload
doctor() { # doctor <path> <name>
  if [ -e "$1" ] && ! verify_bin "$1"; then
    warn "$2 corrupted or truncated; removing to redownload"
    rm -f "$1"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
head_ "Red Team Environment Diagnostics $(date '+%F %T')"
say "DSH_HOME = $DSH_HOME"
say "Toolkit   = $TK"

# === 1. Tool Installation =============================================════════
head_ "1. Tool Installation"

# --- System binaries in PATH (Healthcheck) ---
PATHD="nmap masscan nuclei sqlmap ffuf feroxbuster gobuster hydra john hashcat wpscan nikto whatweb amass theHarvester msfconsole searchsploit proxychains4 socat nc tmux"
MISSING_PATH=""
for t in $PATHD; do have "$t" || MISSING_PATH="$MISSING_PATH $t"; done
if [ -n "$MISSING_PATH" ]; then
  warn "Missing from PATH: $MISSING_PATH"
  dim "Install missing system packages: sudo apt install -y$MISSING_PATH"
else
  ok "System tools in PATH verified (nmap, nuclei, sqlmap, ffuf, etc.)"
fi

# --- Toolkit Binaries ---
declare -A BIN=(
  [fscan]="$TK/fscan/fscan"
  [gogo]="$TK/gogo/gogo"
  [suo5]="$TK/suo5/suo5-linux-amd64"
  [chisel]="$TK/chisel/chisel"
  [frpc]="$TK/frp/frpc"
  [frps]="$TK/frp/frps"
  [subfinder]="$TK/subfinder/subfinder"
  [dnsx]="$TK/dnsx/dnsx"
  [naabu]="$TK/naabu/naabu"
  [httpx]="$TK/httpx/httpx"
  [ksubdomain]="$TK/ksubdomain/ksubdomain"
  [ligolo-proxy]="$TK/ligolo/proxy"
  [ligolo-agent]="$TK/ligolo/agent"
  [gowitness]="$TK/gowitness/gowitness"
)

if [ "$CHECK_ONLY" != 1 ]; then
  # fscan / gogo (Intranet pivoting tools)
  doctor "${BIN[fscan]}" fscan
  [ -x "${BIN[fscan]}" ] || { mkdir -p "$TK/fscan"; dl_asset "shadow1ng/fscan" "fscan_linux_amd64|linux_amd64.*\.(zip|tar\.gz)$" "$TK/fscan/fscan.zip" 0; }
  [ -x "${BIN[gogo]}" ] || dim "gogo: obtain from https://github.com/chainreactors/gogo/releases (manual asset naming)"

  # suo5 (WebShell tunneling)
  doctor "${BIN[suo5]}" suo5
  [ -x "${BIN[suo5]}" ] || { mkdir -p "$TK/suo5"; dl_asset "zema1/suo5" "suo5-linux-amd64" "${BIN[suo5]}"; }

  # chisel
  doctor "${BIN[chisel]}" chisel
  if [ ! -x "${BIN[chisel]}" ]; then
    mkdir -p "$TK/chisel"
    dl_asset "jpillora/chisel" "chisel_.*linux_amd64\.gz$" "$TK/chisel/chisel.gz" 0 && gunzip -f "$TK/chisel/chisel.gz" && mv -f "$TK/chisel/chisel" "${BIN[chisel]}" && chmod +x "${BIN[chisel]}"
  fi

  # frp (frpc + frps)
  doctor "${BIN[frpc]}" frpc; doctor "${BIN[frps]}" frps
  if [ ! -x "${BIN[frpc]}" ] || [ ! -x "${BIN[frps]}" ]; then
    mkdir -p "$TK/frp"
    dl_asset "fatedier/frp" "linux_amd64\.tar\.gz$" "$TK/frp/frp.tar.gz" 0 \
      && untar_all "$TK/frp/frp.tar.gz" "$TK/frp" frpc frps
  fi

  # ProjectDiscovery Suite
  doctor "${BIN[subfinder]}" subfinder
  [ -x "${BIN[subfinder]}" ] || { mkdir -p "$TK/subfinder"; dl_asset "projectdiscovery/subfinder" "linux_amd64\.zip$" "$TK/subfinder/s.zip" 0 && python3 -c "import zipfile;zipfile.ZipFile('$TK/subfinder/s.zip').extractall('$TK/subfinder')" && chmod +x "${BIN[subfinder]}"; }
  doctor "${BIN[dnsx]}" dnsx
  [ -x "${BIN[dnsx]}" ]      || { mkdir -p "$TK/dnsx";      dl_asset "projectdiscovery/dnsx"      "linux_amd64\.zip$" "$TK/dnsx/d.zip" 0      && python3 -c "import zipfile;zipfile.ZipFile('$TK/dnsx/d.zip').extractall('$TK/dnsx')"           && chmod +x "${BIN[dnsx]}"; }
  doctor "${BIN[naabu]}" naabu
  [ -x "${BIN[naabu]}" ]     || { mkdir -p "$TK/naabu";     dl_asset "projectdiscovery/naabu"     "linux_amd64\.zip$" "$TK/naabu/n.zip" 0     && python3 -c "import zipfile;zipfile.ZipFile('$TK/naabu/n.zip').extractall('$TK/naabu')"         && chmod +x "${BIN[naabu]}"; }
  doctor "${BIN[httpx]}" httpx
  [ -x "${BIN[httpx]}" ]     || { mkdir -p "$TK/httpx";     dl_asset "projectdiscovery/httpx"     "linux_amd64\.zip$" "$TK/httpx/h.zip" 0     && python3 -c "import zipfile;zipfile.ZipFile('$TK/httpx/h.zip').extractall('$TK/httpx')"         && chmod +x "${BIN[httpx]}"; }
  if [ -x "${BIN[httpx]}" ]; then
    mkdir -p "$HOME/.local/bin"
    printf '#!/usr/bin/env bash\nexec "%s" "$@"\n' "${BIN[httpx]}" > "$HOME/.local/bin/pd-httpx"
    chmod +x "$HOME/.local/bin/pd-httpx"
    ok "pd-httpx wrapper -> ${BIN[httpx]}"
  fi

  # ksubdomain (Stateless subdomain enumeration)
  doctor "${BIN[ksubdomain]}" ksubdomain
  [ -x "${BIN[ksubdomain]}" ] || { mkdir -p "$TK/ksubdomain"; dl_asset "knownsec/ksubdomain" "linux.*\.zip$" "$TK/ksubdomain/k.zip" 0 && python3 -c "import zipfile;zipfile.ZipFile('$TK/ksubdomain/k.zip').extractall('$TK/ksubdomain')" && chmod +x "${BIN[ksubdomain]}"; }

  # ligolo-ng (TUN tunnel option)
  doctor "${BIN[ligolo-proxy]}" ligolo-proxy; doctor "${BIN[ligolo-agent]}" ligolo-agent
  if [ ! -x "${BIN[ligolo-proxy]}" ] || [ ! -x "${BIN[ligolo-agent]}" ]; then
    mkdir -p "$TK/ligolo"
    dl_asset "nicocha30/ligolo-ng" "proxy_.*linux_amd64\.tar\.gz$" "$TK/ligolo/proxy.tar.gz" 0 \
      && untar_all "$TK/ligolo/proxy.tar.gz" "$TK/ligolo" proxy
    dl_asset "nicocha30/ligolo-ng" "agent_.*linux_amd64\.tar\.gz$" "$TK/ligolo/agent.tar.gz" 0 \
      && untar_all "$TK/ligolo/agent.tar.gz" "$TK/ligolo" agent
  fi

  # gowitness (Screenshot capture)
  doctor "${BIN[gowitness]}" gowitness
  [ -x "${BIN[gowitness]}" ] || { mkdir -p "$TK/gowitness"; dl_asset "sensepost/gowitness" "gowitness-[0-9.]+-linux-amd64$" "${BIN[gowitness]}"; }

  # OneForAll (Subdomain collector)
  OF_DIR="$TK/oneforall/OneForAll-0.4.5"
  if [ ! -f "$OF_DIR/oneforall.py" ]; then
    mkdir -p "$TK/oneforall"
    dim "Downloading OneForAll source v0.4.5"
    curl -sL --retry 3 -m 300 "https://github.com/shmilylty/OneForAll/archive/refs/tags/v0.4.5.tar.gz" -o "$TK/oneforall/of.tar.gz" \
      && python3 -c "import tarfile;tarfile.open('$TK/oneforall/of.tar.gz').extractall('$TK/oneforall')" 2>/dev/null \
      && ok "OneForAll source ready" || bad "OneForAll download failed"
  else
    ok "OneForAll source exists"
  fi
  # venv dependencies (1-2 mins on first run)
  if [ -f "$OF_DIR/oneforall.py" ] && [ ! -x "$OF_DIR/.venv/bin/python" ]; then
    dim "Creating venv and installing OneForAll dependencies (1-2 mins)"
    ( cd "$OF_DIR" && python3 -m venv .venv >/dev/null 2>&1 \
      && .venv/bin/python -m pip install -q --no-cache-dir --upgrade pip setuptools wheel >/dev/null 2>&1 \
      && .venv/bin/python -m pip install -q --no-cache-dir requests exrex fire beautifulsoup4 dnspython loguru tqdm PySocks tenacity termcolor treelib colorama future "SQLAlchemy<2" >/dev/null 2>&1 ) \
      && ok "OneForAll dependencies ready" || warn "OneForAll dependency installation failed (subfinder + ksubdomain available as alternative)"
  elif [ -x "$OF_DIR/.venv/bin/python" ]; then
    ok "OneForAll venv exists"
  fi
else
  dim "--check mode: skipping downloads"
fi

# === 2. Nuclei Templates ===============================================
head_ "2. Nuclei Template Library"
NT="$HOME/.local/nuclei-templates"
if [ -d "$NT" ]; then
  NTC="$(find "$NT" -name '*.yaml' 2>/dev/null | wc -l | tr -d ' ')"
  ok "Template library ready: $NT ($NTC templates)"
  [ "$NTC" -lt 1000 ] && warn "Low template count; run: nuclei -update-templates"
elif have nuclei; then
  if [ "$CHECK_ONLY" != 1 ]; then
    dim "Initial template library update (~100MB, 1-3 mins)"
    nuclei -update-templates >/dev/null 2>&1 && ok "Template library update complete ($NT)" || bad "Template update failed; run manually: nuclei -update-templates"
  else
    warn "Template library missing (run nuclei -update-templates)"
  fi
else
  warn "nuclei not installed; skipping"
fi

# === 3. Configuration: FOFA_KEY & VPS ===================================
head_ "3. Configuration (FOFA API Key & VPS Login)"

# Existing values (env var takes precedence over .env file)
cur_env() { # cur_env <NAME> -> returns active value
  local n="$1" v=""
  v="${!n-}"                                   # hyphen prevents set -u unbound variable error
  [ -n "$v" ] && { printf '%s' "$v"; return; }
  [ -f "$ENV_FILE" ] && grep -E "^${n}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'
}
env_set() { # env_set <NAME> <VALUE> -> updates $DSH_HOME/.env with 600 permissions
  local n="$1" v="$2"
  mkdir -p "$(dirname "$ENV_FILE")"; touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  if grep -qE "^${n}=" "$ENV_FILE" 2>/dev/null; then
    python3 - "$ENV_FILE" "$n" "$v" <<'PY'
import sys
path, name, value = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path, encoding='utf-8').read().splitlines()
out, done = [], False
for line in lines:
    if line.startswith(name + '='):
        out.append(f'{name}={value}'); done = True
    else:
        out.append(line)
if not done: out.append(f'{name}={value}')
open(path, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
PY
  else
    printf '%s=%s\n' "$n" "$v" >> "$ENV_FILE"
  fi
}

# --- FOFA_KEY ---
FOFA_NOW="$(cur_env FOFA_KEY)"
if [ -n "$FOFA_NOW" ]; then
  ok "FOFA_KEY configured (${FOFA_NOW:0:4}...${FOFA_NOW: -4}, length ${#FOFA_NOW})"
  dim "Source: $([ -n "${FOFA_KEY:-}" ] && echo 'Environment variable' || echo "$ENV_FILE")"
  if [ "$CHECK_ONLY" != 1 ] && [ "$ASSUME_YES" != 1 ]; then
    NEW="$(ask_secret 'Update FOFA_KEY (Press Enter to keep current)')"
    [ -n "$NEW" ] && env_set FOFA_KEY "$NEW" && ok "FOFA_KEY updated"
  fi
else
  warn "FOFA_KEY not configured — asset surveying (fofa-recon skill) will be degraded"
  dim "Get API key: Log in to https://fofa.info -> User Center -> API Key"
  dim "Alternatives: crt.sh Certificate Transparency + subfinder/ksubdomain + passive DNS"
  if [ "$CHECK_ONLY" != 1 ]; then
    NEW="$(ask_secret 'Paste FOFA_KEY (Leave blank to skip, configure later via setup.sh)')"
    if [ -n "$NEW" ]; then
      env_set FOFA_KEY "$NEW"; ok "FOFA_KEY saved to $ENV_FILE (takes effect after dsh web restart)"
      # Immediate validation
      RESP="$(curl -s -m 20 "https://fofa.info/api/v1/info/my?key=$NEW" 2>/dev/null)"
      if printf '%s' "$RESP" | grep -q '"error":false'; then
        ok "FOFA_KEY validation passed"
      else
        warn "FOFA_KEY validation failed: $(printf '%s' "$RESP" | head -c 120)"
      fi
    else
      warn "Skipped FOFA_KEY (surveying degraded; re-run script anytime to configure)"
    fi
  fi
fi

# --- VPS (Reverse shell & pivot) ---
VPS_KEY_NOW="$(cur_env REDTEAM_VPS_KEY)";   VPS_KEY_NOW="${VPS_KEY_NOW:-$TK/vps/id_rsa}"
VPS_HOST_NOW="$(cur_env REDTEAM_VPS_HOST)"
VPS_USER_NOW="$(cur_env REDTEAM_VPS_USER)"; VPS_USER_NOW="${VPS_USER_NOW:-ubuntu}"
say ""
if [ -f "$VPS_KEY_NOW" ]; then
  # Prompt if host is missing when private key is present
  if [ -z "$VPS_HOST_NOW" ]; then
    warn "Private key exists but VPS address is missing (REDTEAM_VPS_HOST unset)"
    if [ "$CHECK_ONLY" != 1 ]; then
      ANS="$(ask 'VPS host address (IP or domain; username defaults to '"$VPS_USER_NOW"')' '')"
      if [ -n "$ANS" ]; then
        env_set REDTEAM_VPS_HOST "$ANS"; env_set REDTEAM_VPS_USER "$VPS_USER_NOW"
        VPS_HOST_NOW="$ANS"; ok "VPS address saved to $ENV_FILE: $VPS_USER_NOW@$VPS_HOST_NOW"
      else
        warn "Skipped — Reverse shell and payload delivery skills will be marked unavailable"
      fi
    fi
  fi
fi
if [ -f "$VPS_KEY_NOW" ] && [ -n "$VPS_HOST_NOW" ]; then
  ok "VPS access configured: $VPS_USER_NOW@$VPS_HOST_NOW (Key: $VPS_KEY_NOW)"
  if ssh -i "$VPS_KEY_NOW" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 "$VPS_USER_NOW@$VPS_HOST_NOW" 'echo ok' >/dev/null 2>&1; then
    ok "VPS SSH connectivity verified"
  else
    warn "VPS SSH unreachable — reverse shells and payload delivery will fail"
    dim "Check: private key permissions (chmod 600), port 22 security groups, username"
  fi
elif [ ! -f "$VPS_KEY_NOW" ]; then
  warn "VPS private key not found ($VPS_KEY_NOW) — reverse shell delivery unavailable"
  dim "A public VPS is recommended (to catch reverse shells, host payloads, and serve as tunnel egress)"
  if [ "$CHECK_ONLY" != 1 ]; then
    NEW_HOST="$(ask 'VPS login address (user@ip)' 'ubuntu@')"
    NEW_KEY="$(ask 'VPS private key path' "$TK/vps/id_rsa")"
    if [ -n "$NEW_HOST" ] && [ -f "$NEW_KEY" ]; then
      env_set REDTEAM_VPS_HOST "$NEW_HOST"; env_set REDTEAM_VPS_KEY "$NEW_KEY"
      ok "VPS login info recorded ($NEW_HOST)"
      dim "Place private key at $NEW_KEY and run chmod 600"
    else
      warn "Skipped VPS config (without VPS, scoring is limited to non-payload findings: accounts, data, unauthorized access)"
    fi
  fi
else
  warn "Private key exists but VPS address is unset (REDTEAM_VPS_HOST missing)"
  dim "To configure: set REDTEAM_VPS_HOST=<IP or domain> and REDTEAM_VPS_USER=<user> in $ENV_FILE"
fi

# Environment notice
if [ ! -f "$ENV_FILE" ] || ! grep -q 'FOFA_KEY' "$ENV_FILE" 2>/dev/null; then
  dim "Notice: $ENV_FILE is loaded on startup; restart dsh web to apply changes"
fi

# === 4. Health Checklist ===============================================
head_ "4. Health Checklist (Binary Execution)"
FAILED=""; WEAK=""
for name in "${!BIN[@]}"; do
  p="${BIN[$name]}"
  if [ ! -x "$p" ]; then bad "$name missing ($p)"; FAILED="$FAILED $name"; continue; fi
  # Run smoke test to verify binary is not truncated
  if timeout 15 "$p" --version >/dev/null 2>&1 || timeout 15 "$p" -version >/dev/null 2>&1 \
     || timeout 15 "$p" -h >/dev/null 2>&1 || timeout 15 "$p" --help >/dev/null 2>&1 \
     || timeout 15 "$p" version >/dev/null 2>&1; then
    ok "$name ($(stat -c%s "$p") bytes, smoke test passed)"
  else
    warn "$name exists but unresponsive (possible truncation) — re-run with --force"
    WEAK="$WEAK $name"
  fi
done
[ -f "$TK/oneforall/OneForAll-0.4.5/oneforall.py" ] && ok "oneforall (source)" || warn "oneforall (not installed; subfinder+ksubdomain alternative available)"
[ -d "$TK/Behinder" ] && ok "Behinder (WebShell deliverable)" || warn "Behinder not installed"
[ -d "$TK/Godzilla" ] && ok "Godzilla (WebShell deliverable)" || warn "Godzilla not installed"
[ -d "$TK/AntSword" ] && ok "AntSword" || dim "AntSword not installed (optional)"

# === 5. Completion Summary =============================================
head_ "Summary"
if [ -n "$FAILED" ]; then
  warn "The following tools are missing; related skills will be degraded: $FAILED"
elif [ -n "$WEAK" ]; then
  warn "The following tools failed smoke tests (re-run with --force): $WEAK"
else
  ok "Toolkit complete (all binaries passed smoke tests)"
fi

if [ "$CHECK_ONLY" != 1 ]; then
  {
    echo "# Red Team Mode environment completion marker — written by setup.sh"
    echo "completed_at=$(date -Iseconds)"
    echo "dsh_home=$DSH_HOME"
    echo "toolkit=$TK"
    echo "missing_tools=${FAILED:-none}"
    echo "fofa_key=$([ -n "$(cur_env FOFA_KEY)" ] && echo configured || echo missing)"
    echo "vps=$([ -f "$VPS_KEY_NOW" ] && echo configured || echo missing)"
  } > "$MARKER"
  ok "Wrote completion marker: $MARKER"
  dim "Agents check this marker during preflight to confirm environment readiness"
fi

say ""
say "Next steps:"
say "  1) If $ENV_FILE was modified (FOFA_KEY / VPS), restart dsh web to load values"
say "  2) In Red Team Mode, Commander runs redteam_preflight on startup"
say "  3) Enter target organization name to begin engagement"
say ""
say "Log: $LOG"
exit 0
