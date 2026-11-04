/**
 * fixture 预载(bun --preload 注入):子进程内替换全局 fetch,
 * quake.360.net 请求路由到 tests/fixtures/quake_responses.json,
 * 其余域放行。配 QUAKE_FIXTURES= 指定 fixture 文件路径。
 * 仅测试用;生产入口零改动。
 */
const path = require('node:path') as typeof import('node:path')
const fs = require('node:fs') as typeof import('node:fs')

const fixturesPath = process.env.QUAKE_FIXTURES ||
  path.join(__dirname, 'fixtures', 'quake_responses.json')
const FIXTURES: Record<string, unknown> = JSON.parse(fs.readFileSync(fixturesPath, 'utf-8'))

function fixtureFor(urlPath: string): unknown {
  if (urlPath.includes('user/info')) return FIXTURES.user
  if (urlPath.includes('search/quake_service')) return FIXTURES.service_search
  if (urlPath.includes('scroll/quake_service')) return FIXTURES.service_scroll
  if (urlPath.includes('aggregation/quake_service')) return FIXTURES.agg
  if (urlPath.includes('search/quake_host')) return FIXTURES.host_search
  if (urlPath.includes('scroll/quake_host')) return FIXTURES.host_scroll
  if (urlPath.includes('aggregation/quake_host')) return FIXTURES.agg
  if (urlPath.includes('scroll/quake_vulnerability')) return FIXTURES.vuln_scroll
  if (urlPath.includes('cve/detail')) return FIXTURES.cve
  if (urlPath.includes('similar_icon')) return FIXTURES.icon
  if (urlPath.includes('compare/docs')) return FIXTURES.compare
  if (urlPath.includes('fast_scan/6aead05')) return FIXTURES.scan_status
  if (urlPath.includes('filterable/field/quake_service')) return FIXTURES.fields_service
  throw new Error(`fixture missing for ${urlPath}`)
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.includes('quake.360.net')) {
    const p = url.replace(/^https?:\/\/[^/]+/, '')
    return new Response(JSON.stringify(fixtureFor(p)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return realFetch(input as never)
}) as typeof fetch
