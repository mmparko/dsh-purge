---
name: browser-automation
description: Drive Chrome/Chromium without dependencies to render SPA pages, capture screenshots, execute JS, and extract endpoint lists (headless fallback + playwright-cli)
whenToUse: When rendering SPA sites, extracting JS-generated content, taking evidence screenshots, or batch crawling web interfaces
role: recon
enabled: true
---

# Browser Automation (Headless Chrome)

Local environment: `/usr/bin/chromium` 150.0.7871.181, `DISPLAY=:10.0`, Node v22.23.2.

## 1. Zero-Dependency Chromium CLI (Fastest & Most Reliable)
```bash
CHROME=/usr/bin/chromium
FLAGS="--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --virtual-time-budget=8000"

# 1) Dump rendered DOM (works for SPAs)
$CHROME $FLAGS --dump-dom "https://target.example.com/" 2>/dev/null > runs/page.html

# 2) Extract plain text
$CHROME $FLAGS --dump-dom "https://target.example.com/" 2>/dev/null \
  | python3 -c "import sys,re;h=sys.stdin.read();print(re.sub(r'<[^>]+>',' ',re.sub(r'(?is)<(script|style).*?</\1>',' ',h)))" | head -200

# 3) Capture screenshot evidence
$CHROME $FLAGS --window-size=1440,900 --screenshot=runs/shot-$(date +%s).png "https://target.example.com/"

# 4) Authenticated requests (Reuse cookies exported from Burp/Browser)
$CHROME $FLAGS --user-data-dir=/tmp/rt-profile --dump-dom "https://target.example.com/admin"

# 5) Generate PDF
$CHROME $FLAGS --print-to-pdf=runs/page.pdf "https://target.example.com/"
```

### Extracting Frontend API Endpoints (Recon Priority)
```bash
$CHROME $FLAGS --dump-dom "https://target.example.com/" 2>/dev/null > runs/page.html
python3 - <<'PY'
import re, json, pathlib
html = pathlib.Path('runs/page.html').read_text(errors='ignore')
paths = set(re.findall(r'["\'](/(?:api|rest|v[0-9]|admin|user|order|upload|file)[A-Za-z0-9_\-/{}.:]{0,80})["\']', html))
print('\n'.join(sorted(paths)))
PY

# Download referenced scripts and extract endpoints:
grep -oE 'src="[^"]+\.js[^"]*"' runs/page.html | sed 's/src="//;s/"$//' | while read u; do
  case "$u" in http*) url="$u";; /*) url="https://target.example.com$u";; *) url="https://target.example.com/$u";; esac
  curl -s "$url" | grep -oE '["\'](/(api|rest|v[0-9])[A-Za-z0-9_\-/{}.:]{0,80})["\']' | tr -d '"'"'" >> runs/interfaces.txt
done
sort -u runs/interfaces.txt
```

## 2. Playwright CLI (Interactive Workflows / Waiting / Multi-Page)
Pre-installed at `~/.cache/ms-playwright/chromium-1243`. **Note: The default Chrome channel may fail; always pass `--browser chromium`**.

```bash
PW="npx --yes @playwright/cli@latest"
$PW -s=recon1 open --browser chromium "https://target.example.com/"   # Open session (-s session name)
$PW -s=recon1 snapshot                                                # Accessibility tree + @e references
$PW -s=recon1 eval "() => document.title"                             # Execute JS
$PW -s=recon1 find "Login"                                            # Search text in snapshot
$PW -s=recon1 click "@e5"                                             # Click element
$PW -s=recon1 fill "@e7" "admin"                                      # Fill input
$PW -s=recon1 screenshot --path runs/pw.png                           # Take screenshot
$PW -s=recon1 --persistent --profile runs/pw-profile open --browser chromium URL   # Session persistence
$PW -s=recon1 close                                                   # Close session
```

Session persistence: `--persistent --profile <dir>`; stores cookies across subsequent launches.
Common subcommands: `open / goto / snapshot / find / eval / click / fill / press / upload / screenshot / resize / reload / go-back / close / list`.

## 3. Tool Selection Guide
| Scenario | Recommended Approach |
|---|---|
| Page content / Screenshot / API extraction | Chromium CLI (Zero dependencies, fastest) |
| Form fills / Clicks / Waits / Multi-tab navigation | Playwright CLI (`--browser chromium`) |
| Real user session cookie reuse | Kimi WebBridge (Skill `kimi-webbridge`, requires extension) |

## Operational Notes
- `--no-sandbox` is strictly for local lab execution; do not use in production environments.
- Recorded URLs and titles should be updated via `redteam_asset_add` (`url` and `title` fields); endpoint inventories should be saved to `runs/` and linked in the attack chain.
- Screenshots and raw page dumps may contain sensitive data; save to `runs/` rather than committing to repository assets.
