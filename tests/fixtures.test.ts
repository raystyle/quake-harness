import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * 全端点离线回归:真实付费响应转 fixture(2026-11-04 付费回归当日收割),
 * mock fetch 后逐命令跑全业务逻辑,断言 output schema 对真实数据的匹配度。
 * 价值:响应形漂移(如 scroll meta.total 裸数值形)在此离线可测,不再依赖积分与网络。
 */

let home = mkdtempSync(join(tmpdir(), 'qkh-fx-'))
process.env.QUAKEH_HOME = home

// fixture 预载经 bun --preload 注入子进程(见 tests/fixture_preload.ts),
// 生产入口零改动;写路径全部进受控 home
process.on('exit', () => {
  try { rmSync(home, { recursive: true, force: true }) } catch {}
})

async function run(args: string[]): Promise<{ out: any; exit: number }> {
  const proc = Bun.spawnSync(['bun', '--preload', './tests/fixture_preload.ts', 'src/cli.ts', ...args, '--json'], {
    cwd: ROOT,
    env: { ...process.env, QUAKEH_HOME: home, QuakeAPIKey: 'fx-test-key' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30000,
  })
  const exit = proc.exitCode ?? 0
  let out: any = null
  try { out = JSON.parse(proc.stdout.toString().trim()) } catch { out = { _raw: proc.stdout.toString().slice(0, 200) } }
  return { out, exit }
}

describe('全端点 fixture 回归(真实付费响应,离线 mock)', () => {
  test('user: 账户信封', async () => {
    const { out, exit } = await run(['user'])
    expect(exit).toBe(0)
    expect(out.username).toBe('360_APT_Research')
    expect(out.roles.length).toBeGreaterThan(0)
  })

  test('service-search: docs 形与归档', async () => {
    const { out, exit } = await run(['service-search', 'service: http', '--size', '2'])
    expect(exit).toBe(0)
    expect(out.count).toBeGreaterThanOrEqual(1)
    expect(out.total).toBeGreaterThan(0)
    const doc = out.docs[0]
    expect(doc.ip).toBeTruthy()
    expect(['tcp', 'udp']).toContain(doc.transport)
    expect(out.archived).toBe(out.count)  // 全量归档
  })

  test('service-scroll: 裸数值 total 形(线上踩过的漂移)', async () => {
    const { out, exit } = await run(['service-scroll', 'service: http', '--size', '1'])
    expect(exit).toBe(0)
    expect(out.total).toBeGreaterThan(0)      // 不再被 {value} 假设吃掉
    expect(out.pagination_id).toBeTruthy()    // 游标在
    expect(out.docs.length).toBeGreaterThanOrEqual(1)
  })

  test('service-agg: facet buckets', async () => {
    const { out, exit } = await run(['service-agg', 'app:"PHP"', '--by', 'service', '--size', '2'])
    expect(exit).toBe(0)
    const buckets = out.aggregations.service ?? out.aggregations.app
    expect(buckets.length).toBeGreaterThan(0)
    expect(buckets[0].doc_count).toBeGreaterThan(0)
  })

  test('host-search: 主机视图 services 数组', async () => {
    const { out, exit } = await run(['host-search', 'ip:"103.198.42.236"', '--size', '1'])
    expect(exit).toBe(0)
    expect(out.hosts[0].ip).toBeTruthy()
    expect(Array.isArray(out.hosts[0].services)).toBe(true)
  })

  test('host-scroll: 裸数值 total 形', async () => {
    const { out, exit } = await run(['host-scroll', 'country:"中国"', '--size', '1'])
    expect(exit).toBe(0)
    expect(out.total).toBeGreaterThan(0)
    expect(out.pagination_id).toBeTruthy()
  })

  test('host-agg: 免费聚合', async () => {
    const { out, exit } = await run(['host-agg', 'country:"中国"', '--by', 'service', '--size', '2'])
    expect(exit).toBe(0)
    expect(Object.keys(out.aggregations).length).toBeGreaterThan(0)
  })

  test('host-honeypot: 启发式判定走 mock 主机数据', async () => {
    const { out, exit } = await run(['host-honeypot', '103.198.42.236'])
    expect(exit).toBe(0)
    expect(typeof out.suspicious).toBe('boolean')
    expect(out.service_count).toBeGreaterThanOrEqual(0)
  })

  test('vuln-scroll: 漏洞文档形', async () => {
    const { out, exit } = await run(['vuln-scroll', 'Log4j2', '--size', '1'])
    expect(exit).toBe(0)
    expect(out.total).toBeGreaterThan(0)
    expect(out.docs[0].ip).toBeTruthy()
    expect(Array.isArray(out.docs[0].vuln_ids)).toBe(true)
  })

  test('domain: 归档与投影', async () => {
    const { out, exit } = await run(['domain', 'qq.com', '--size', '2'])
    expect(exit).toBe(0)
    expect(out.total).toBeGreaterThan(0)
    expect(out.docs[0].domain).toBeTruthy()
    expect(out.archived).toBe(out.count)
  })

  test('cve: 详情透传', async () => {
    const { out, exit } = await run(['cve', 'CVE-2026-46300'])
    expect(exit).toBe(0)
    expect(out.vul_qhv_id).toBe('QH-202605-4784')   // fixture 收割自该 CVE 的真实详情
    expect(out.vul_type).toBeTruthy()
  })

  test('compare: 多文档对比透传形', async () => {
    const { out, exit } = await run(['compare', '8.149.67.89_2121_tcp', '47.99.142.226_2121_tcp', '147.224.236.5_2121_tcp'])
    expect(exit).toBe(0)
    expect(Object.keys(out).length).toBeGreaterThan(2)
  })

  test('fields: 字段清单', async () => {
    const { out, exit } = await run(['fields', 'service'])
    expect(exit).toBe(0)
    expect(out.count).toBeGreaterThan(5)
    expect(out.fields).toContain('ip')
  })

  test('icon: favicon 聚合', async () => {
    const { out, exit } = await run(['icon', '827fd6c561d4b1f932f75e0f9a17f766', '--size', '1'])
    expect(exit).toBe(0)
    expect(out.icons[0].key).toBeTruthy()
    expect(out.icons[0].doc_count).toBeGreaterThan(1000)
  })

  test('scan-status: 任务状态刷新', async () => {
    const { out, exit } = await run(['scan-status', '6aead05b701f0f2b355dcb78'])
    expect(exit).toBe(0)
    expect(out.id).toBe('6aead05b701f0f2b355dcb78')
    expect(out.status).toBe('Finished')               // fixture 为真实四态时间线样本
    expect(typeof out.progress).toBe('number')
    expect(out.runtime_id).toBe('6aead05b701f0f2b355dcb77')
  })

  test('service-search 二段: 缓存命中不重复归档', async () => {
    // 独立参数(size 3)避开前测预热,验证 miss -> hit 全链
    const first = await run(['service-search', 'service: ssh', '--size', '3'])
    expect(first.out.cache_hit).toBe(false)
    expect(first.out.archived).toBe(first.out.count)
    const second = await run(['service-search', 'service: ssh', '--size', '3'])
    expect(second.out.cache_hit).toBe(true)
    expect(second.out.archived).toBe(0)   // 缓存命中不重复扣行
  })
})
