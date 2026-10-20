// Loopback-only fixtures for an isolated DSH_HOME. Never use production keys.
import { createServer } from 'node:http'
const port = Number(process.argv[2] ?? 33200)
const resetAt = Date.now() + 2 * 3600000
const models = [{ id: 'fixture/reasoner', name: 'Fixture Reasoner', context_length: 100000, supported_endpoints: ['/chat/completions'] },
  { id: 'fixture/vision', name: 'Fixture Vision', context_length: 200000, supported_endpoints: ['/chat/completions'] }]
// Optional larger catalog for checking the model list's scrolling in the isolated preview.
for (let i = 3; i <= Number(process.argv[3] ?? 2); i++) {
  models.push({ id: `fixture/model-${i}`, name: `Fixture Model ${i}`, context_length: 100000, supported_endpoints: ['/chat/completions'] })
}
const catalog = models.map((model) => ({ slug: model.id.replace('/', '-'), id: model.id, name: model.name, minPlanName: 'GOAT', vision: true, reasoning: true }))
let generations = 0
createServer(async (req, res) => {
  const json = (value) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
  if (req.url === '/counts') return json({ generations })
  if (req.url.endsWith('/models')) return json({ data: models })
  if (req.url.startsWith('/docs/')) {
    const escaped = JSON.stringify(catalog).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return res.end(`<script>self.__next_f.push([1,"${escaped}"])</script>`)
  }
  if (req.url.endsWith('/whoami')) return json({ user: { id: 'offline-fixture', userName: 'Fixture' } })
  if (req.url.endsWith('/summary')) return json({ totalCount: 100, completedCount: 1, successRate: 1, totalTokens: 1000, totalCost: 1 })
  if (req.url.endsWith('/credits')) return json({ credits: { monthlyCredits: 4, purchasedCredits: 0, freeCredits: 0 }, windowLimits: { fiveHour: { used: 90, cap: 100, resetAt } } })
  if (req.url.endsWith('/subscriptions')) return json({ data: { planId: 'individual-goat' } })
  if (req.url.endsWith('/chat/completions')) {
    generations++
    let body = ''
    for await (const chunk of req) body += chunk
    const request = JSON.parse(body)
    if (request.stream) {
      res.setHeader('content-type', 'text/event-stream')
      return res.end('data: {"choices":[{"delta":{"content":"fixture pong"}}]}\n\ndata: [DONE]\n\n')
    }
    return json({ choices: [{ message: request.tools ? { tool_calls: [{ function: { name: 'diagnostic_ping', arguments: '{}' } }] } : { content: 'fixture pong' }, finish_reason: 'stop' }] })
  }
  res.statusCode = 404; json({ error: 'unknown fixture endpoint' })
}).listen(port, '127.0.0.1', () => console.log(`Fixture listening on 127.0.0.1:${port}`))
