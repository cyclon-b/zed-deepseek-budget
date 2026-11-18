const key = process.env.DEEPSEEK_API_KEY
if (!key) {
  console.error('DEEPSEEK_API_KEY is not set')
  process.exit(1)
}
const base = process.env.PROXY_URL || 'http://127.0.0.1:8787'
const response = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model: 'deepseek-flash',
    stream: true,
    max_tokens: 32,
    messages: [{ role: 'user', content: 'Say "ok" and nothing else.' }],
  }),
})
console.log('status', response.status)
if (!response.ok) {
  console.log(await response.text())
  process.exit(1)
}
const text = await response.text()
console.log(text.slice(0, 3000))
const health = await fetch(`${base}/healthz`).then((r) => r.json())
console.log('health', JSON.stringify(health))
