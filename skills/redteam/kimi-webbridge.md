---
name: kimi-webbridge
description: "Control real user Chrome/Chromium via Moonshot Kimi browser extension (WebBridge): navigate, inspect DOM, click, fill forms, execute JS, and capture screenshots"
whenToUse: "When re-using existing authenticated browser sessions to access admin portals, inspecting JS-rendered SPAs, or requiring authentic client-side browser fingerprints"
role: recon
enabled: true
---

# Kimi WebBridge (Browser Extension + Local Daemon)

Installed and operational: Daemon **v2.0.8** (systemd service `kimi-webbridge`, enabled on boot), listening on `127.0.0.1:10086`, binary at `~/.kimi-webbridge/bin/kimi-webbridge`.

## Current Status

- Daemon: **Managed via systemd** (`/etc/systemd/system/kimi-webbridge.service`, `enabled` + `active`, `Restart=on-failure`).
  Inspect status: `systemctl status kimi-webbridge`; restart using `sudo systemctl restart kimi-webbridge`.
  **Do NOT run `kimi-webbridge start` / `upgrade` manually**, as this creates orphaned processes and destabilizes systemd state. To upgrade:
  `sudo systemctl stop kimi-webbridge && ~/.kimi-webbridge/bin/kimi-webbridge upgrade && sudo systemctl start kimi-webbridge`.
- Extension: **Kimi WebBridge v2.0.8, automatically provisioned via enterprise policy from the Chrome Web Store** (Extension ID `fldmhceldgbpfpkbgopacenieobmligc`).
  Policy files `/etc/opt/chrome/policies/managed/kimi-webbridge.json` and `/etc/chromium/policies/managed/kimi-webbridge.json`
  configure `ExtensionSettings.force_installed` + `ExtensionInstallForcelist`, ensuring **all Chrome / Chromium profiles automatically run the extension, update automatically, and stay persistently active**.
- Modern Chrome ignores `--load-extension` flags, so unpacked manual loading is unsupported.
- If `status` reports `extension_connected: false`: The browser instance is simply not currently running. Launching any browser (`kimi-chrome` or desktop icon) establishes the connection within 5 seconds.
- For basic DOM retrieval, prefer `browser-automation` (faster, headless, no active GUI window needed); **use this skill when authenticated browser session reuse is required**.

## Prerequisites

1. Verify daemon is running: `~/.kimi-webbridge/bin/kimi-webbridge status` should return `"running": true`.
2. **A browser instance must be running** (the extension communicates only while browser processes exist). Launcher: `~/.local/bin/kimi-chrome`:
   - Defaults to Chrome **default profile** (carries live authentication cookies and session state).
   - `KIMI_BROWSER=chromium kimi-chrome` launches Chromium; `KIMI_PROFILE=/path kimi-chrome` launches an isolated profile without existing session state.
3. Verify connection:
```bash
curl -s http://127.0.0.1:10086/status | python3 -m json.tool
# Must return "extension_connected": true before proceeding
```

## Invocation Pattern

```bash
WB=http://127.0.0.1:10086/command
call() { printf '%s' "$2" > /tmp/wb.json; curl -s -X POST $WB -H 'Content-Type: application/json' --data-binary @/tmp/wb.json; }
```
> Transmit complex JSON payloads via temporary files and `--data-binary` to avoid shell escaping issues.

### Common Actions

```bash
# Navigate to page in new tab
call navigate '{"action":"navigate","args":{"url":"https://target.example.com/login","newTab":true,"group_title":"recon"},"session":"recon1"}'

# Extract page visible text (Most common)
call evaluate '{"action":"evaluate","args":{"code":"(() => document.body.innerText.slice(0,6000))()"},"session":"recon1"}'

# Capture accessibility snapshot (Includes @e element references for subsequent click/fill)
call snapshot '{"action":"snapshot","args":{},"session":"recon1"}'

# Execute arbitrary JavaScript: Extract API endpoints from DOM and resource timings
call evaluate '{"action":"evaluate","args":{"code":"(() => {const s=new Set();for(const e of performance.getEntriesByType(\"resource\"))s.add(e.name);const m=document.documentElement.innerHTML.match(/[\\\"\\x27]\\/(api|v[0-9])\\/[a-zA-Z0-9_\\-\\/{}]+/g)||[];m.forEach(x=>s.add(x));return [...s].slice(0,200).join(\"\\n\")})()"},"session":"recon1"}'

# Click element / Fill input
call click '{"action":"click","args":{"ref":"@e12"},"session":"recon1"}'
call fill  '{"action":"fill","args":{"ref":"@e15","value":"admin"},"session":"recon1"}'

# Capture screenshot (Returns absolute file path)
call screenshot '{"action":"screenshot","args":{"path":"$DSH_HOME/redteam/engagements/<target>/runs/shot.png"},"session":"recon1"}'

# Monitor network activity (Discover internal APIs)
call network '{"action":"network","args":{},"session":"recon1"}'

# Tab management
call list_tabs '{"action":"list_tabs","args":{},"session":"recon1"}'
call close_session '{"action":"close_session","args":{},"session":"recon1"}'
```

Raw CDP passthrough (advanced): `{"action":"cdp","args":{"method":"Network.getAllCookies"}}`.

## Red Team Workflow Applications

- **API Discovery**: Load the web app -> execute `evaluate` to gather resource timing entries and frontend JS route paths -> feed route inventory to exploit agents for IDOR and unauthorized access tests.
- **Authenticated Sessions**: For portals where the operator has already logged in via browser, issue `navigate` + `evaluate` to directly interact with backend views without repeating credentials.
- **SPA Rendering**: Extracts rendered DOM states from client-heavy applications that curl cannot render.
- Discovered URLs and titles must be registered into `redteam_asset_add` (`tool="kimi-webbridge"`).

## Operational Constraints

- **Requires Active Display**: Must run inside a desktop GUI session (`DISPLAY=:10.0` or equivalent).
- Supports Chrome and Edge; cross-origin iframes cannot be pierced; `click`/`fill` dispatch synthetic events that may not satisfy bank-grade active controls.
- Extension and daemon versions are tightly coupled: when `update_available` appears in status output, perform the systemd upgrade procedure.
- Linux is not officially supported by vendor; functionality is provided as-is.

## Headless Fallback

When a GUI session is absent, use `browser-automation` (zero-dependency headless Chromium automation).
