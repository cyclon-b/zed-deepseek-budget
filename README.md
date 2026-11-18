# zed-deepseek-budget

A small local HTTP proxy that enforces a daily **CNY** budget for the native
[Zed](https://zed.dev) Agent when it uses the official DeepSeek API.

Zed's `language_models.deepseek` provider exposes only `api_url`; there is no
per-model or daily spend limit. Zed's own spend limits apply to Zed-hosted
models, not to your DeepSeek API key. This proxy sits between Zed and
`https://api.deepseek.com`, prices every response from its `usage` block, and
returns `402` once the daily limit is reached.

## Features

- OpenAI-compatible `chat/completions` and Responses API requests.
- Streaming SSE and non-streaming JSON.
- Injects `stream_options.include_usage` so streaming requests report usage.
- DeepSeek peak/off-peak prices, including cache hit/miss input tokens.
- Daily reset in a configurable timezone.
- Shared state file with the optional `dsh-daily-budget` plugin for the
  DeepSeek Harness.
- `/healthz` endpoint and a small JSON log.
- Docker image, Compose file, and Docker Desktop-friendly environment variables.

## Docker

```sh
docker build -t zed-deepseek-budget .

docker run -d --name zed-deepseek-budget \
  -p 127.0.0.1:8787:8787 \
  -e DAILY_LIMIT_CNY=15 \
  -e USD_TO_CNY=7.2 \
  -e RESET_TIME_ZONE=Europe/Moscow \
  -v zed-deepseek-budget-data:/data \
  --restart unless-stopped \
  zed-deepseek-budget
```

Or with Compose:

```sh
cp .env.example .env
# edit .env if needed
docker compose up -d --build
```

Check:

```sh
curl http://127.0.0.1:8787/healthz
```

### Docker Desktop

Run the image with:

- **Port:** host `8787` → container `8787`
- **Environment:** `DAILY_LIMIT_CNY=15` (and optionally `USD_TO_CNY`,
  `RESET_TIME_ZONE`)
- **Volume:** a named volume or a host directory mounted at `/data`

The container listens on `0.0.0.0:8787`; the published port is the only way in.
Bind the host port to `127.0.0.1` in production if the Docker daemon is shared.

## Configure Zed

In `settings.json`:

```json
{
  "language_models": {
    "deepseek": {
      "api_url": "http://127.0.0.1:8787/v1"
    }
  }
}
```

Restart Zed or open a new agent thread. The proxy must be running before Zed
makes the first DeepSeek request.

## Environment variables

Environment variables override `config.json`.

| Variable | Default | Description |
|---|---|---|
| `DAILY_LIMIT_CNY` | `15` | Daily budget in CNY. `0` blocks every request. |
| `USD_TO_CNY` | `7.2` | Rate used to convert DeepSeek's USD prices and the CNY limit. |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Listen address. |
| `PORT` | `8787` | Listen port. |
| `UPSTREAM` | `https://api.deepseek.com` | DeepSeek origin. |
| `STATE_FILE` | `$DSH_HOME/limits/daily-budget.json` or `~/.dsh/limits/daily-budget.json` | Counter file. Docker default: `/data/daily-budget.json`. |
| `LOG_FILE` | `.../zed-agent-budget.log` | Log file. Docker default: `/data/zed-agent-budget.log`. |
| `RESET_TIME_ZONE` | system zone | IANA zone used for the daily reset. |
| `HOLIDAYS` | empty | Comma-separated Chinese holidays (`YYYY-MM-DD`, Beijing) billed at off-peak. |

Example:

```sh
DAILY_LIMIT_CNY=25 USD_TO_CNY=7.3 docker compose up -d
```

## Native Node

```sh
node server.mjs
```

Node 20+ (Node 24 recommended). There are no npm dependencies.

## How it works

1. A `POST /v1/chat/completions` or `/v1/responses` request checks the shared
   counter. If the daily limit is spent, the proxy returns `402` with an
   OpenAI-style error and does not call DeepSeek.
2. For streaming requests it adds `stream_options.include_usage: true`.
3. The response is forwarded to Zed; the last `usage` block from the SSE or JSON
   body is priced.
4. The cost is written atomically to the state file under a cross-process lock.
5. `GET /v1/models` and other non-billable requests are forwarded without a
   budget check.

The state file is shared with the `dsh-daily-budget` plugin, so the native Zed
Agent and the DeepSeek Harness share one daily limit.

## Pricing

Source: <https://api-docs.deepseek.com/quick_start/pricing/>.

Prices below are USD per 1M tokens at peak; off-peak is half. Peak is
01:00–04:00 and 06:00–10:00 UTC, Monday–Friday, excluding Chinese public
holidays.

| Model | cache hit | cache miss | output |
|---|---:|---:|---:|
| `deepseek-flash` | $0.006 | $0.3 | $1.2 |
| `deepseek-v4-pro` | $0.044 | $1.32 | $3.96 |

`prompt_cache_hit_tokens` is billed at the cache-hit rate,
`prompt_cache_miss_tokens` at the cache-miss rate. If the cache fields are
absent, the whole `prompt_tokens` value is billed as cache miss.
`completion_tokens` is billed as output.

## Limitations

- A request aborted before its `usage` block is not counted, although DeepSeek
  may have charged it.
- Chinese holidays are empty by default, so a holiday may be billed at the peak
  rate (conservative).
- The USD→CNY rate is fixed in the configuration.
- Concurrent requests can overshoot the limit by the cost of one request.
- If the proxy is down, Zed's DeepSeek provider is unavailable.

## Security

The proxy forwards the `Authorization` header from Zed. It never stores the API
key, and the log contains only model ids, token counts, and costs. Keep the
listen address on localhost (or bind the published Docker port to
`127.0.0.1`).

## TLS inspection and corporate proxies

If an antivirus or corporate proxy intercepts TLS (for example, Kaspersky),
Node inside the container must trust its root certificate. Export the root
CA as PEM and mount it:

```sh
docker run ... \
  -v "$PWD/certs:/certs:ro" \
  -e NODE_EXTRA_CA_CERTS=/certs/root-ca.pem \
  zed-deepseek-budget
```

In Docker Desktop add the same volume and environment variable. Do not
disable TLS verification.

## Author

Gennady Artamonov

## License

[PolyForm Noncommercial License 1.0.0](LICENSE). Commercial use of the software
or of products based on it requires a separate license from the author.
