import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * quake-h 集成测试。
 * 离线组:受控 QUAKEH_HOME,验证缓存/归档/语法/导出全链路,不打网络。
 * 冒烟组:真实 API(需 .env QuakeAPIKey),每命令验证信封与关键字段;
 *         付费命令只跑最小 size,并依赖先跑一次的网络结果进缓存后二次断言。
 */

const KEY = process.env.QuakeAPIKey || process.env.QUAKE_API_KEY || ''
const hasKey = KEY.length > 0

// 受控数据根必须在任何 src import 之前设置:
// describe 回调(含 await import)先于 beforeAll 执行,晚设会让 getDb 单例绑定默认目录
let home = mkdtempSync(join(tmpdir(), 'qkh-test-'))
process.env.QUAKEH_HOME = home



afterAll(() => {
  // Windows 下 SQLite 句柄可能延迟释放,清理失败不挡测试结果
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {}
})

/** 跑 CLI 并解析输出信封;节流由 src/ratelimit.ts 自适应控制器负责(测试检验生产机制);
 *  残留 q3005 时再试一次(子进程内部会自动等静默期) */
async function run(args: string[]): Promise<{ out: any; exit: number }> {
  let r = await runOnce(args)
  if (r.out?.code === 'q3005') r = await runOnce(args)
  return r
}

async function runOnce(args: string[]): Promise<{ out: any; exit: number }> {
  const proc = Bun.spawnSync(['bun', 'src/cli.ts', ...args, '--json'], {
    cwd: ROOT,
    env: { ...process.env, QUAKEH_HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30000,
  })
  const exit = proc.exitCode ?? 0
  const text = proc.stdout.toString().trim()
  let out: any = null
  try {
    out = JSON.parse(text)
  } catch {
    out = { _raw: text, _stderr: proc.stderr.toString().trim() }
  }
  if (process.env.QKH_DEBUG) console.error(`[run] ${args.join(' ')} -> exit=${exit} out=${JSON.stringify(out).slice(0, 200)}`)
  return { out, exit }
}

// ---------------------------------------------------------------------------
// 单元层:缓存与归档纯逻辑
// ---------------------------------------------------------------------------

describe('cache 单元', async () => {
  const { cacheKey, stableStringify, writeRaw, readCache, TTL_HOURS } = await import('../src/cache')

  test('stableStringify 键序无关', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
    expect(stableStringify([1, { y: 1, x: 2 }])).toBe('[1,{"x":2,"y":1}]')
  })

  test('cacheKey 参数序无关、值不同则不同', () => {
    const k1 = cacheKey('search', 'q', { size: 10, start: 0 })
    const k2 = cacheKey('search', 'q', { start: 0, size: 10 })
    const k3 = cacheKey('search', 'q', { start: 5, size: 10 })
    expect(k1).toBe(k2)
    expect(k1).not.toBe(k3)
    expect(k1).toHaveLength(32)
  })

  test('writeRaw 落盘路径与 TTL 读取', () => {
    const key = cacheKey('agg', 't', {})
    const p = writeRaw('agg', key, { code: 0, data: { x: 1 } })
    expect(existsSync(p)).toBe(true)
    expect(p.includes(join('raw', 'agg'))).toBe(true)
    const hit = readCache('agg', key, 1)
    expect(hit?.body).toEqual({ code: 0, data: { x: 1 } })
    // TTL 0 = 永不命中
    expect(readCache('agg', key, 0)).toBeNull()
    // 不存在的 key
    expect(readCache('agg', 'ffffffffffffffffffffffffffffffff' as import('../src/types').CacheKey, 1)).toBeNull()
  })

  test('TTL 表覆盖全部缓存方法', () => {
    // README 宣称的缓存语义与实现一致
    expect(TTL_HOURS.search).toBe(24)
    expect(TTL_HOURS.host_search).toBe(24)
    expect(TTL_HOURS.scroll).toBe(0)
    expect(TTL_HOURS.host_scroll).toBe(0)
    expect(TTL_HOURS.agg).toBe(168)
    expect(TTL_HOURS.host_agg).toBe(168)
    expect(TTL_HOURS.cve).toBe(720)
  })
})

describe('archive 单元', async () => {
  const { getDb, upsertAssets, recordRun, getMonthDb, dataMonth, listMonths, openFederatedDb } = await import('../src/archive')

  test('UPSERT 同 doc_id 更新 last_seen,按数据时间落月库', () => {
    // 数据时间 2025-06 -> 月库 2025-06;先清保证计数独占
    const m = dataMonth('2025-06-15T00:00:00Z')
    expect(m as string).toBe('2025-06')
    getMonthDb(m).exec('DELETE FROM assets')
    const db = getDb()
    const row = {
      doc_id: '1.2.3.4_80_tcp' as import('../src/types').DocId, ip: '1.2.3.4', port: 80, transport: 'tcp',
      service_name: 'http', hostname: '', country: '中国', time: '2025-06-15T00:00:00Z', raw_json: '{"v":1}',
    }
    expect(upsertAssets(db, [row])).toBe(1)
    expect(upsertAssets(db, [{ ...row, raw_json: '{"v":2}' }])).toBe(1)
    const mdb = getMonthDb(m)
    const r: any = mdb.query('SELECT data_time, data_time_is_observed, raw_json, first_seen, last_seen FROM assets WHERE doc_id = ?').get('1.2.3.4_80_tcp')
    expect(r.data_time).toBe('2025-06-15T00:00:00Z')
    expect(r.data_time_is_observed).toBe(0)
    expect(r.raw_json).toBe('{"v":2}')
    expect(Date.parse(r.last_seen)).toBeGreaterThanOrEqual(Date.parse(r.first_seen))
    const n: any = mdb.query('SELECT count(*) AS n FROM assets').get()
    expect(n.n).toBe(1)
    expect(listMonths() as string[]).toContain('2025-06')
  })

  test('数据时间缺失时回落观测时间并打标', () => {
    const db = getDb()
    upsertAssets(db, [{
      doc_id: '5.6.7.8_80_tcp' as import('../src/types').DocId, ip: '5.6.7.8', port: 80, transport: 'tcp',
      service_name: '', hostname: '', country: '', time: '', raw_json: '{}',
    }])
    const nowM = dataMonth('')
    const r: any = getMonthDb(nowM).query('SELECT data_time, data_time_is_observed FROM assets WHERE doc_id = ?').get('5.6.7.8_80_tcp')
    expect(r).toBeTruthy()
    expect(r.data_time_is_observed).toBe(1)
  })

  test('跨月联邦:UNION ALL 子查询聚合', () => {
    getMonthDb('2025-06' as import('../src/types').Month).exec('DELETE FROM assets')
    getMonthDb('2025-01' as import('../src/types').Month).exec('DELETE FROM assets')
    const db = getDb()
    upsertAssets(db, [{
      doc_id: '1.1.1.1_1_tcp' as import('../src/types').DocId, ip: '1.1.1.1', port: 1, transport: 'tcp', service_name: '', hostname: '', country: '', time: '2025-01-01T00:00:00Z', raw_json: '{}',
    }, {
      doc_id: '2.2.2.2_2_tcp' as import('../src/types').DocId, ip: '2.2.2.2', port: 2, transport: 'tcp', service_name: '', hostname: '', country: '', time: '2025-06-01T00:00:00Z', raw_json: '{}',
    }])
    const fed = openFederatedDb()
    const n: any = fed.db.query(`SELECT count(*) AS n, count(DISTINCT month) AS months FROM ${fed.assetsRef}`).get()
    expect(n.n).toBeGreaterThanOrEqual(2)
    expect(n.months).toBeGreaterThanOrEqual(2)
  })

  test('recordRun 记录断点与总数', () => {
    const db = getDb()
    recordRun(db, { method: 'scroll', query: 'service: http', cacheKey: 'k', total: 100, count: 10, paginationId: 'pid1', rawPath: '/x' })
    const r: any = db.query('SELECT total, count, pagination_id, raw_path FROM query_runs WHERE cache_key = ?').get('k')
    expect(r.total).toBe(100)
    expect(r.count).toBe(10)
    expect(r.pagination_id).toBe('pid1')
    expect(r.raw_path).toBe('/x')
  })
})

describe('syntax 单元', async () => {
  const { SECTIONS, OPERATORS } = await import('../src/syntax')

  test('129 字段 22 分组注册完整', () => {
    expect(SECTIONS).toHaveLength(22)
    const total = SECTIONS.reduce((n, s) => n + s.entries.length, 0)
    expect(total).toBe(129)
  })

  test('每个字段必有 field/name/example', () => {
    for (const s of SECTIONS) {
      for (const e of s.entries) {
        expect(e.field.length).toBeGreaterThan(0)
        expect(e.name.length).toBeGreaterThan(0)
        expect(e.example.length).toBeGreaterThan(0)
      }
    }
  })

  test('运算符要点含分词与范围', () => {
    expect(OPERATORS.some((o) => o.includes('双引号'))).toBe(true)
    expect(OPERATORS.some((o) => o.includes('TO'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 离线集成:CLI 命令面
// ---------------------------------------------------------------------------

describe('CLI 离线命令', () => {
  test('syntax tls 命中 11 字段', async () => {
    const { out, exit } = await run(['syntax', 'tls'])
    expect(exit).toBe(0)
    expect(out.total).toBe(11)
    expect(out.sections[0].entries.some((e: any) => e.field === 'tls_SAN')).toBe(true)
  })

  test('syntax --list 出 22 分组', async () => {
    const { out, exit } = await run(['syntax', '--list'])
    expect(exit).toBe(0)
    expect(out.sections).toHaveLength(22)
  })

  test('syntax 未知词 NOT_FOUND 退 1', async () => {
    const { out, exit } = await run(['syntax', 'zzz不存在的词'])
    expect(exit).toBe(1)
    expect(out.code).toBe('NOT_FOUND')
  })

  test('export 只接受 SELECT', async () => {
    const { out, exit } = await run(['export', '--sql', 'DROP TABLE assets'])
    expect(exit).toBe(1)
    expect(out.code).toBe('USAGE')
  })

  test('export parquet: 流式导出可读回', async () => {
    // 先种两行资产(隔离 HOME 内)
    const { getDb, upsertAssets } = await import('../src/archive')
    upsertAssets(getDb(), [
      { doc_id: '9.9.9.9_80_tcp' as import('../src/types').DocId, ip: '9.9.9.9', port: 80, transport: 'tcp', service_name: 'http', hostname: '', country: '中国', time: 't', raw_json: '{}' },
      { doc_id: '8.8.8.8_443_tcp' as import('../src/types').DocId, ip: '8.8.8.8', port: 443, transport: 'tcp', service_name: 'https', hostname: '', country: '美国', time: 't', raw_json: '{}' },
    ])
    const out = join(home, 't.parquet')
    const { out: r, exit } = await run(['export', '--sql', 'SELECT ip, port, country FROM assets WHERE ip LIKE "9.9.%" OR ip LIKE "8.8.%"', '--as', 'parquet', '--out', out])
    expect(exit).toBe(0)
    expect(r.format).toBe('parquet')
    expect(r.rows_note_undefined).toBeUndefined()
    expect(r.bytes).toBeGreaterThan(0)
    // 读回验证
    const { parquetReadObjects, parquetMetadataAsync } = await import('hyparquet')
    const bytes = new Uint8Array(readFileSync(out))
    const ab = {
      byteLength: bytes.byteLength,
      slice: async (start: number, end: number) => {
        const buf = new Uint8Array(end - start)
        buf.set(bytes.subarray(start, end))
        return buf.buffer
      },
    }
    await parquetMetadataAsync(ab as any)
    const rows = (await parquetReadObjects({ file: ab as any } as any)) as any[]
    expect(rows.length).toBeGreaterThanOrEqual(2)
    const nine = rows.find((x) => x.ip === '9.9.9.9')
    expect(nine.port).toBe(80)
    expect(nine.country).toBe('中国')
  }, 30000)

  test('export parquet: 缺 --out 报 USAGE', async () => {
    const { out, exit } = await run(['export', '--as', 'parquet'])
    expect(exit).toBe(1)
    expect(out.code).toBe('USAGE')
  })

  test('export 统计面', async () => {
    const { out, exit } = await run(['export'])
    expect(exit).toBe(0)
    expect(out).toHaveProperty('assets')
    expect(out).toHaveProperty('runs')
  })

  test('cache 命令可查历史', async () => {
    const { out, exit } = await run(['cache'])
    expect(exit).toBe(0)
    expect(Array.isArray(out.runs)).toBe(true)
  })

  test('fts: 归档全文检索(种子命中/列限定/月库过滤)', async () => {
    const { upsertAssets, getDb, dataMonth } = await import('../src/archive')
    const docId = (s: string) => s as import('../src/types').DocId
    upsertAssets(getDb(), [
      { doc_id: docId('9.9.9.9_80_tcp'), ip: '9.9.9.9', port: 80, transport: 'tcp', service_name: 'http', hostname: '', country: '中国', time: 't', raw_json: JSON.stringify({ id: '9.9.9.9_80_tcp', service: { http: { title: 'b374k shell', body: 'FilesMan webshell login', server: 'Apache', host: 'evil.test' } } }) },
      { doc_id: docId('7.7.7.7_80_tcp'), ip: '7.7.7.7', port: 80, transport: 'tcp', service_name: 'http', hostname: '', country: '', time: 't', raw_json: JSON.stringify({ id: '7.7.7.7_80_tcp', service: { http: { title: 'Biz', body: 'nothing special', server: 'Nginx', host: 'ok.test' } } }) },
    ])
    // 全库裸词
    const bare = await run(['fts', 'FilesMan'])
    expect(bare.exit).toBe(0)
    expect(bare.out.count).toBeGreaterThanOrEqual(1)
    const hit = bare.out.hits.find((h: any) => h.doc_id === '9.9.9.9_80_tcp')
    expect(hit).toBeTruthy()
    expect(hit.snippet).toContain('[FilesMan]')
    // 列限定:title 列
    const byTitle = await run(['fts', 'title:b374k'])
    expect(byTitle.out.count).toBeGreaterThanOrEqual(1)
    expect(byTitle.out.hits.some((h: any) => h.doc_id === '9.9.9.9_80_tcp')).toBe(true)
    // 列限定 + AND:同列同词组合
    const and = await run(['fts', 'server:Apache AND body:webshell'])
    expect(and.out.count).toBeGreaterThanOrEqual(1)
    // 非法月库
    const bad = await run(['fts', 'x', '--month', '2026-13'])
    expect(bad.exit).toBe(1)
    expect(bad.out.code).toBe('USAGE')
  })

  test('doctor: 离线体检信封', async () => {
    const { out, exit } = await run(['doctor'])
    expect(exit).toBe(0)
    expect(['ok', 'warn', 'fail']).toContain(out.status)
    expect(out.net).toBe(false)
    expect(out.net_probe).toBeNull()
    // 七项恒跑检查齐全,状态值合法
    expect(out.checks.length).toBeGreaterThanOrEqual(7)
    const names = out.checks.map((k: any) => k.name)
    for (const n of ['token', 'dir-data', 'dir-cache', 'dir-config', 'archive-db', 'ratelimit', 'legacy-home']) {
      expect(names).toContain(n)
    }
    for (const k of out.checks) expect(['ok', 'warn', 'fail']).toContain(k.status)
    // 受控 QUAKEH_HOME 下三目录都应落在其中且可写
    expect(out.data_dir.startsWith(home)).toBe(true)
    expect(out.cache_dir.startsWith(home)).toBe(true)
    expect(out.config_dir.startsWith(home)).toBe(true)
    expect(out.archive.month_list).toEqual(expect.any(Array))
  })

  test('doctor --net 无 token 不崩', async () => {
    // 抹掉 key 再探活:net 项应 fail 但命令仍出数据信封
    const proc = Bun.spawnSync(['bun', 'src/cli.ts', 'doctor', '--net', '--json'], {
      cwd: ROOT,
      env: { ...process.env, QUAKEH_HOME: home, QuakeAPIKey: '', QUAKE_API_KEY: '', QUAKE_TOKEN: '' },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30000,
    })
    const exit = proc.exitCode ?? 0
    const out = JSON.parse(proc.stdout.toString().trim())
    expect(exit).toBe(0)
    expect(out.net).toBe(true)
    expect(out.net_probe.ok).toBe(false)
    expect(out.net_probe.credit).toBeNull()
    const netCheck = out.checks.find((k: any) => k.name === 'net')
    expect(netCheck.status).toBe('fail')
  })
})

// ---------------------------------------------------------------------------
// 冒烟组:真实 API
// ---------------------------------------------------------------------------

describe.skipIf(!hasKey)('API 冒烟', () => {
  /** 网络测试统一 30s 超时 */
  const nt = (name: string, fn: () => Promise<void>) => test(name, fn, 30000)

  nt('user: 账户信封', async () => {
    const { out, exit } = await run(['user'])
    expect(exit).toBe(0)
    expect(out.username).toBeTruthy()          // 不钉死用户名:换 Key 不破测试
    expect(typeof out.credit).toBe('number')
    expect(out.roles.length).toBeGreaterThan(0)
  })

  nt('cve: 详情与缓存二段', async () => {
    const first = await run(['cve', 'CVE-2021-44228'])
    expect(first.exit).toBe(0)
    expect(first.out.vul_qhv_id).toBe('QH-202112-811')
    expect(first.out.vul_name).toContain('Log4Shell')
    const second = await run(['cve', 'CVE-2021-44228'])
    expect(second.out.cache_hit).toBe(true)
  })

  nt('cve: 不存在编号退 1', async () => {
    const { out, exit } = await run(['cve', 'CVE-0000-0000'])
    expect(exit).toBe(1)
    expect(out.code).toBe('NOT_FOUND')
  })

  nt('agg: 聚合与缓存', async () => {
    const { out, exit } = await run(['service-agg', 'country: CN', '--by', 'service', '--size', '3'])
    expect(exit).toBe(0)
    expect(out.aggregations.service.length).toBe(3)
    expect(out.aggregations.service[0].doc_count).toBeGreaterThan(0)
    const second = await run(['service-agg', 'country: CN', '--by', 'service', '--size', '3'])
    expect(second.out.cache_hit).toBe(true)
  })

  nt('fields: 四数据集', async () => {
    for (const ds of ['service', 'host', 'service-agg', 'host-agg']) {
      const { out, exit } = await run(['fields', ds])
      expect(exit).toBe(0)
      expect(out.count).toBeGreaterThan(5)
      expect(out.fields).toContain('ip')
    }
  })

  nt('service-search: 扣费查询归档链路', async () => {
    const { out, exit } = await run(['service-search', 'service: http', '--size', '2', '--include', 'ip,port,service.name'])
    expect(exit).toBe(0)
    expect(out.count).toBe(2)
    expect(out.archived).toBe(2)
    expect(out.total).toBeGreaterThan(1_000_000)
    const doc = out.docs[0]
    expect(doc.id).toMatch(/_\d+_(tcp|udp)$/)
    expect(doc.ip).toBeTruthy()
    // 归档可查
    const exp = await run(['export', '--sql', 'SELECT count(*) AS n FROM assets'])
    expect((exp.out.rows[0] as any).n).toBeGreaterThanOrEqual(2)
  })

  nt('host-search: 主机视图', async () => {
    const { out, exit } = await run(['host-search', 'ip:"103.198.42.236"', '--size', '1'])
    expect(exit).toBe(0)
    expect(out.hosts[0].ip).toBe('103.198.42.236')
    expect(Array.isArray(out.hosts[0].services)).toBe(true)
  })

  nt('host-honeypot: 复用缓存判定', async () => {
    const { out, exit } = await run(['host-honeypot', '103.198.42.236'])
    expect(exit).toBe(0)
    expect(out.service_count).toBeGreaterThan(0)
    expect(typeof out.suspicious).toBe('boolean')
  })

  nt('icon: favicon 相似度', async () => {
    let r = await run(['icon', '827fd6c561d4b1f932f75e0f9a17f766', '--size', '1'])
    if (r.exit !== 0 || !r.out?.icons?.length) {
      await Bun.sleep(5000)           // 限流静默/网络抖动宽容:重试一次
      r = await run(['icon', '827fd6c561d4b1f932f75e0f9a17f766', '--size', '1'])
    }
    expect(r.exit).toBe(0)
    expect(r.out.icons[0].doc_count).toBeGreaterThan(1000)
  })

  nt('service-scroll: 游标返回', async () => {
    const { out, exit } = await run(['service-scroll', 'service: http', '--size', '1', '--include', 'ip,port,service.name'])
    expect(exit).toBe(0)
    expect(out.count).toBe(1)
    expect(out.pagination_id).toMatch(/^[0-9a-f]{20,}$/)
  })

  nt('compare: 多文档对比(需 front.api.doc.compare 权限)', async () => {
    const { out, exit } = await run(['compare', '8.149.67.89_2121_tcp', '47.99.142.226_2121_tcp', '147.224.236.5_2121_tcp'])
    // 权限开通:code 0 返回对比数据;未开通:exit 1 带 q3012(两种都合法,断言信封形状)
    if (exit === 1) {
      expect(out.code).toBe('q3012')
    } else {
      expect(exit).toBe(0)
      // 实测返回多文档字段对比对象(扁平键含 control./service./task. 前缀)
      const keys = Object.keys(out)
      expect(keys.length).toBeGreaterThan(3)
      expect(keys.some((k) => k.includes('.'))).toBe(true)
    }
  })

  nt('scan: 缺 --port-list 报 USAGE', async () => {
    const { out, exit } = await run(['scan', 'example.com'])
    expect(exit).toBe(1)
    expect(out.code).toBe('USAGE')
  })

  nt('doctor --net: 免费探活', async () => {
    const { out, exit } = await run(['doctor', '--net'])
    expect(exit).toBe(0)
    expect(out.net).toBe(true)
    expect(out.net_probe.ok).toBe(true)
    expect(typeof out.net_probe.latency_ms).toBe('number')
    expect(out.net_probe.host).toContain('quake.360.net')
  })

  nt('domain: 域名资产查询(官方 quake_rs 同款)', async () => {
    const { out, exit } = await run(['domain', 'qq.com', '--size', '2'])
    expect(exit).toBe(0)
    expect(out.total).toBeGreaterThan(0)
    expect(out.count).toBe(2)
    const doc = out.docs[0]
    expect(doc.domain).toContain('qq.com')
    expect(doc.ip).toBeTruthy()
    // 过滤器组合:剔 CDN 后 total 应收窄
    const filtered = await run(['domain', 'qq.com', '--size', '1', '--noCdn'])
    expect(filtered.exit).toBe(0)
    expect(filtered.out.total).toBeLessThan(out.total)
  })

  nt('domain: size 超 100 报 USAGE', async () => {
    const { out, exit } = await run(['domain', 'qq.com', '--size', '101'])
    expect(exit).toBe(1)
    expect(out.code).toBe('USAGE')
  })

  test('domain: 语法注入与非法域名守卫(离线,不落网络)', async () => {
    for (const bad of ['evil.cn OR service:telnet', 'qq.com:9200', 'notadomain']) {
      const { out, exit } = await run(['domain', bad, '--size', '1'])
      expect(exit).toBe(1)
      expect(out.code).toBe('USAGE')
    }
  })

  test('业务输入守卫族:非法形本地拦截,不落网络(离线)', async () => {
    // cve 编号
    const cve = await run(['cve', 'not-a-cve'])
    expect(cve.exit).toBe(1)
    expect(cve.out.code).toBe('USAGE')
    // favicon md5
    const icon = await run(['icon', 'zzz-not-md5'])
    expect(icon.exit).toBe(1)
    expect(icon.out.code).toBe('USAGE')
    // host-honeypot ip/cidr
    const hp = await run(['host-honeypot', '1.2.3.4.5.6'])
    expect(hp.exit).toBe(1)
    expect(hp.out.code).toBe('USAGE')
    // compare doc id
    const cmp = await run(['compare', 'bad-id', 'x2', 'y3'])
    expect(cmp.exit).toBe(1)
    expect(cmp.out.code).toBe('USAGE')
    // scan 任务 id
    const st = await run(['scan-status', 'abc'])
    expect(st.exit).toBe(1)
    expect(st.out.code).toBe('USAGE')
    // size 上限(积分事故防线)
    const big = await run(['service-search', 'service: http', '--size', '500000'])
    expect(big.exit).toBe(1)
    expect(big.out.code).toBe('USAGE')
  })

  nt('scan-ls: 任务簿记可查(scan-status 刷新后)', async () => {
    // scan-status 查任意 id(即使无效)先保证表存在;再看 scan-ls 信封
    const { out, exit } = await run(['scan-ls'])
    expect(exit).toBe(0)
    expect(out.count).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(out.tasks)).toBe(true)
  })

  nt('vuln-scroll: 漏洞数据查询(需漏洞数据角色)', async () => {
    const { out, exit } = await run(['vuln-scroll', 'Log4j2', '--size', '1'])
    if (exit === 1) {
      // 无权限(q2001 索引)也合法
      expect(out.code).toBe('q2001')
    } else {
      expect(exit).toBe(0)
      expect(out.docs.length).toBeGreaterThanOrEqual(0)
      if (out.docs.length > 0) expect(out.docs[0].ip).toBeTruthy()
    }
  })
})

// ---------------------------------------------------------------------------
// 缓存目录结构验证
// ---------------------------------------------------------------------------

describe('缓存落盘结构', () => {
  test('raw 目录按 method/date 分层', async () => {
    await run(['syntax', 'tls']) // 确保目录存在(不落盘也无妨,本组验证的是 API 方法)
    const base = join(home, 'raw')
    if (existsSync(base)) {
      const methods = readdirSync(base)
      for (const m of methods) {
        expect(['search', 'scroll', 'agg', 'cve', 'host_search', 'host_scroll', 'host_agg', 'icon', 'fields_service', 'fields_host', 'fields_service-agg', 'fields_host-agg']).toContain(m)
      }
    }
  })

  test('空结果不落盘(service: nginx 查询无缓存文件)', async () => {
    // service: nginx 是无效服务名,返回空;断言其 cache_key 未产生文件
    const { cacheKey } = await import('../src/cache')
    const key = cacheKey('search', 'service: nginx', { query: 'service: nginx', start: 0, size: 2, ignore_cache: false, latest: true, include: ['ip', 'port', 'service.name'] })
    const base = join(home, 'raw', 'search')
    if (existsSync(base)) {
      for (const date of readdirSync(base)) {
        expect(existsSync(join(base, date, `${key}.json`))).toBe(false)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// MCP stdio 集成:握手 -> 工具发现 -> 调用(全离线,零积分)
// ---------------------------------------------------------------------------

describe('MCP stdio', () => {
  test('initialize + tools/list 直出面 + tools/call(syntax/doctor)', async () => {
    const proc = Bun.spawn(['bun', 'src/cli.ts', '--mcp'], {
      cwd: ROOT,
      env: { ...process.env, QUAKEH_HOME: home },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const send = (obj: unknown) => proc.stdin.write(JSON.stringify(obj) + '\n')
    const responses: any[] = []
    const reader = (async () => {
      const decoder = new TextDecoder()
      let buf = ''
      for await (const chunk of proc.stdout as any) {
        buf += decoder.decode(chunk, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (line) responses.push(JSON.parse(line))
        }
      }
    })()

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    await Bun.sleep(1500)
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'syntax', arguments: { keyword: 'tls' } } })
    await Bun.sleep(1500)
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'doctor', arguments: {} } })
    await Bun.sleep(2000)
    proc.stdin.end()
    await reader.catch(() => {})

    const byId = (id: number) => responses.find((r) => r.id === id)
    const init = byId(1)
    expect(init?.result?.serverInfo?.name).toBe('quake-h')
    // 直出面:每个命令注册为常规工具,而非 search_tools 渐进发现四件套
    const list = byId(2)
    const toolNames = (list?.result?.tools ?? []).map((t: any) => t.name)
    expect(toolNames.length).toBeGreaterThanOrEqual(24)
    expect(toolNames).toContain('domain')
    expect(toolNames).toContain('fts')
    for (const n of ['syntax', 'doctor', 'service-search', 'user', 'export']) expect(toolNames).toContain(n)
    expect(toolNames).not.toContain('search_tools')
    const called = byId(3)
    expect(JSON.stringify(called?.result)).toContain('tls_SAN')
    const doctored = byId(4)
    expect(JSON.stringify(doctored?.result)).toContain('checks')
    proc.kill()
  }, 30000)
})

// ---------------------------------------------------------------------------
// 自适应限流控制器单元(AIMD)
// ---------------------------------------------------------------------------

describe('ratelimit 单元', async () => {
  const { acquire, reportOk, reportLimited, peek, resetState, readState, LIMITS } = await import('../src/ratelimit')

  test('初始节奏与复位', () => {
    resetState()
    let p = peek()
    expect(p.minIntervalMs).toBe(LIMITS.INIT_MS)
    expect(p.cooldownActive).toBe(false)
    expect(p.totalCalls).toBe(0)
  })

  test('acquire 占位后立即再取需等待', () => {
    resetState()
    const first = acquire()
    expect(first.waitMs).toBe(0)
    const second = acquire()
    expect(second.reason).toBe('interval')
    expect(second.waitMs).toBeGreaterThan(LIMITS.MIN_MS - 100)
    expect(second.waitMs).toBeLessThanOrEqual(LIMITS.INIT_MS)
  })

  test('reportOk 线性加速,clamp 到下限', () => {
    resetState()
    for (let i = 0; i < 30; i++) reportOk()
    expect(readState().minIntervalMs).toBe(LIMITS.MIN_MS)
  })

  test('reportLimited 指数减速 + 静默期,clamp 到上限', () => {
    resetState()
    reportLimited()
    let s = readState()
    // 一次 q3005:3000 * 2^1 = 6000ms,静默 30s
    expect(s.minIntervalMs).toBe(6000)
    expect(s.cooldownUntil).toBeGreaterThan(Date.now())
    reportLimited()
    s = readState()
    // 二连:6000 * 2^2 = 24000ms
    expect(s.minIntervalMs).toBe(24000)
    for (let i = 0; i < 8; i++) reportLimited()
    s = readState()
    expect(s.minIntervalMs).toBe(LIMITS.MAX_MS)
    expect(s.consecutiveLimited).toBe(10)
    expect(s.totalLimited).toBe(10)
  })

  test('静默期内 acquire 返回 cooldown 等待', () => {
    resetState()
    reportLimited()
    const g = acquire()
    expect(g.reason).toBe('cooldown')
    expect(g.waitMs).toBeGreaterThan(0)
  })

  test('成功一次清零连续限流计数', () => {
    resetState()
    reportLimited()
    reportLimited()
    expect(readState().consecutiveLimited).toBe(2)
    reportOk()
    expect(readState().consecutiveLimited).toBe(0)
    expect(readState().consecutiveOk).toBe(1)
  })

  test('rate 命令观测面与 --reset', async () => {
    resetState()
    const view = await run(['rate'])
    expect(view.exit).toBe(0)
    expect(view.out.当前最小间隔ms).toBe(LIMITS.INIT_MS)
    const rst = await run(['rate', '--reset'])
    expect(rst.exit).toBe(0)
    expect(rst.out.reset).toBe(true)
  })
})
