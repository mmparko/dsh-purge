---
name: passive-recon
description: Passive reconnaissance: Gather target asset intelligence using public data sources without contacting target hosts
whenToUse: When gathering asset intelligence without direct network exposure
role: recon
enabled: true
---

## Data Sources
- Certificate Transparency logs (crt.sh): `curl -s "https://crt.sh/?q=%25.<domain>&output=json" | jq -r '.[].name_value' | sort -u`
- DNS records: `dig +short <domain> A/AAAA/MX/TXT/NS`
- WHOIS: Registrant, IP ranges, ASN
- Search engines and code hosting platforms: Leaked subdomains, credentials, internal endpoints
- Public port mapping services (Shodan, Censys, FOFA, etc., via authorized API)

## Database Logging Requirements
Record each finding via `redteam_asset_upsert`, setting provenance strictly to `passive`, and recording the exact data source in `tool`.
