# Optional local SearXNG provider

This directory runs a local SearXNG container for the `secure_web_search` extension.
It follows the SearXNG container docs, which recommend Docker/Podman Compose and
persistent mounts for `/etc/searxng` and `/var/cache/searxng`:

https://docs.searxng.org/admin/installation-docker.html#installation-container

## Start

```bash
cd web-search/optional-packages/searxng
./init.sh
docker compose up -d
```

Check the local JSON API:

```bash
curl 'http://127.0.0.1:8080/search?q=pi&format=json'
```

Configure Pi:

```text
/web-search-config searxng http://127.0.0.1:8080/search
/web-search-config provider searxng
```

Use `provider searxng` for strict SearXNG-only mode. Leave provider as `auto` to
fall back to DuckDuckGo HTML if the local SearXNG container is down.

## Stop / update

```bash
docker compose down
docker compose pull
docker compose up -d
```

View status/logs:

```bash
docker compose ps
docker compose logs -f core
```

## Security notes

- The compose file binds SearXNG to `127.0.0.1:8080` by default.
- The web-search extension accepts HTTP SearXNG provider URLs only for loopback
  hosts (`localhost`, `127.x.x.x`, `::1`). Public/non-loopback providers must use
  HTTPS.
- Search result URLs still go through the normal `secure_web_search` HTTPS,
  redirect, DNS, DNSBL, size, and content-risk checks.
- `core-config/settings.yml` enables JSON output and removes Google engines by
  default so this local package does not route searches to Google unless you edit
  the SearXNG config deliberately.
- Do not expose this container publicly without adding HTTPS, rate limiting, and
  reviewing the upstream SearXNG admin docs.
