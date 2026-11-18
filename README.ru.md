# zed-deepseek-budget

Локальный HTTP-прокси, который задаёт дневной лимит в **юанях** для встроенного
агента [Zed](https://zed.dev) при работе с официальным DeepSeek API.

В Zed у провайдера `deepseek` есть только `api_url`; лимита по модели или по
дню нет. Штатные spend limits Zed относятся к Zed-hosted моделям, а не к
вашему ключу DeepSeek. Прокси стоит между Zed и `https://api.deepseek.com`,
считает стоимость по `usage` из ответа и после исчерпания лимита возвращает
`402`, не отправляя запрос в DeepSeek.

## Возможности

- OpenAI-совместимые `chat/completions` и Responses API.
- Потоковые SSE-ответы и обычный JSON.
- Добавляет `stream_options.include_usage`, чтобы стрим возвращал `usage`.
- Тарифы DeepSeek с пиковыми/непиковыми часами и cache hit/miss.
- Сброс лимита в заданной таймзоне.
- Общий файл состояния с плагином `dsh-daily-budget` для DeepSeek Harness.
- Эндпоинт `/healthz` и простой лог.
- Docker-образ, Compose и переменные окружения для Docker Desktop.

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

Или через Compose:

```sh
cp .env.example .env
# при необходимости поправьте .env
docker compose up -d --build
```

Проверка:

```sh
curl http://127.0.0.1:8787/healthz
```

### Docker Desktop

При запуске образа укажите:

- **Port:** host `8787` → container `8787`
- **Environment:** `DAILY_LIMIT_CNY=15` (при необходимости `USD_TO_CNY`,
  `RESET_TIME_ZONE`)
- **Volume:** именованный volume или каталог хоста в `/data`

Контейнер слушает `0.0.0.0:8787`; снаружи доступен только опубликованный порт.

## Настройка Zed

В `settings.json`:

```json
{
  "language_models": {
    "deepseek": {
      "api_url": "http://127.0.0.1:8787/v1"
    }
  }
}
```

Перезапустите Zed или откройте новый тред агента. Прокси должен быть запущен
до первого запроса к DeepSeek.

## Переменные окружения

Переменные окружения перекрывают `config.json`.

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `DAILY_LIMIT_CNY` | `15` | Дневной лимит в юанях. `0` блокирует все запросы. |
| `USD_TO_CNY` | `7.2` | Курс для USD-тарифов DeepSeek и лимита в юанях. |
| `HOST` | `127.0.0.1` (`0.0.0.0` в Docker) | Адрес прослушивания. |
| `PORT` | `8787` | Порт. |
| `UPSTREAM` | `https://api.deepseek.com` | Origin DeepSeek. |
| `STATE_FILE` | `$DSH_HOME/limits/daily-budget.json` или `~/.dsh/limits/daily-budget.json` | Файл счётчика. В Docker: `/data/daily-budget.json`. |
| `LOG_FILE` | `.../zed-agent-budget.log` | Лог. В Docker: `/data/zed-agent-budget.log`. |
| `RESET_TIME_ZONE` | системная зона | IANA-зона для смены дня. |
| `HOLIDAYS` | пусто | Праздники КНР через запятую (`YYYY-MM-DD`, Пекин) по непиковому тарифу. |

Пример:

```sh
DAILY_LIMIT_CNY=25 USD_TO_CNY=7.3 docker compose up -d
```

## Без Docker

```sh
node server.mjs
```

Нужен Node 20+ (рекомендуется Node 24). Зависимостей npm нет.

## Как это работает

1. Запрос `POST /v1/chat/completions` или `/v1/responses` проверяет счётчик.
   Если лимит исчерпан, прокси возвращает `402` с OpenAI-style ошибкой и не
   вызывает DeepSeek.
2. Для стрима добавляется `stream_options.include_usage: true`.
3. Ответ проходит в Zed; последний `usage` из SSE или JSON оценивается по
   тарифу.
4. Стоимость атомарно записывается в файл состояния под межпроцессной
   блокировкой.
5. `GET /v1/models` и прочие не-billable запросы проходят без проверки.

Файл состояния общий с плагином `dsh-daily-budget`, поэтому нативный Zed Agent
и DeepSeek Harness расходуют один дневной лимит.

## Тарифы

Источник: <https://api-docs.deepseek.com/quick_start/pricing/>.

Цены — USD за 1M токенов в пиковые часы; вне пика DeepSeek берёт половину.
Пик: 01:00–04:00 и 06:00–10:00 UTC, понедельник–пятница, кроме праздников КНР.

| Модель | cache hit | cache miss | output |
|---|---:|---:|---:|
| `deepseek-flash` | $0.006 | $0.3 | $1.2 |
| `deepseek-v4-pro` | $0.044 | $1.32 | $3.96 |

`prompt_cache_hit_tokens` считается по cache hit, `prompt_cache_miss_tokens` —
по cache miss. Если этих полей нет, весь `prompt_tokens` идёт по cache miss.
`completion_tokens` — по output.

## Ограничения

- Запрос, оборванный до `usage`, не учитывается, хотя DeepSeek мог его
  зачислить.
- Праздники КНР по умолчанию пусты: в праздничный день возможен пиковый тариф
  (консервативно).
- Курс USD→CNY фиксирован в конфиге.
- Параллельные запросы могут превысить лимит на стоимость одного запроса.
- Если прокси не запущен, провайдер `deepseek` в Zed недоступен.

## Безопасность

Прокси пробрасывает `Authorization` из Zed, не хранит ключ, а в логе оставляет
только id модели, количество токенов и стоимость. Слушайте localhost (или
публикуйте Docker-порт только на `127.0.0.1`).

## TLS-инспекция и корпоративные прокси

Если антивирус или корпоративный прокси перехватывает TLS (например,
Kaspersky), Node в контейнере должен доверять его корневому сертификату.
Экспортируйте корневой CA в PEM и смонтируйте его:

```sh
docker run ... \
  -v "$PWD/certs:/certs:ro" \
  -e NODE_EXTRA_CA_CERTS=/certs/root-ca.pem \
  zed-deepseek-budget
```

В Docker Desktop добавьте тот же volume и переменную окружения. Не
отключайте проверку TLS.

## Автор

Gennady Artamonov

## Лицензия

[PolyForm Noncommercial License 1.0.0](LICENSE). Коммерческое использование
самого кода и продуктов на его основе требует отдельной лицензии от автора.
