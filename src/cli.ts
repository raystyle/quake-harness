#!/usr/bin/env bun
import { Cli, Errors, z } from 'incur'
import { cacheKey, readCache, writeRaw, TTL_HOURS, readUserEnvFallback } from './cache'
import { getDb, recordRun, upsertAssets, saveAgg, openFederatedDb, listMonths, upsertScanTask, type AssetRow } from './archive'
import { SECTIONS, OPERATORS } from './syntax'
import { acquire, reportOk, reportLimited, peek, resetState, LIMITS } from './ratelimit'

const { IncurError } = Errors

const QUAKE_HOST = process.env.QUAKE_HOST || 'https://qiye.quake.360.net'

interface QuakeErrorShape {
  code: string
  message: string
}

/** Quake 统一返回信封:code 非零即失败 */
function isQuakeError(body: unknown): body is QuakeErrorShape {
  return (
    typeof body === 'object' && body !== null &&
    'code' in body && 'message' in body &&
    (body as { code: unknown }).code !== 0
  )
}

/**
 * Quake API 统一请求:服务端错误(code != 0)抛 IncurError,
 * 由 incur 外层 catch 统一转错误信封;code 保留 Quake 错误码(q2001/q3012 等),
 * hint 即『下一步』提示。
 */
async function quakeRequest(
  path: string,
  token: string,
  init?: { method?: 'GET' | 'POST'; body?: unknown },
): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`${QUAKE_HOST}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        'X-QuakeToken': token,
        ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
  } catch (err) {
    throw new IncurError({
      code: 'NETWORK_ERROR',
      message: `网络错误: ${(err as Error).message}`,
      retryable: true,
    })
  }
  const json = (await res.json().catch(() => null)) as unknown
  if (isQuakeError(json)) {
    const msg = json.message
    const needPermission = msg.includes('Missing permission') || msg.includes('权限')
    const noCredit = msg.includes('积分')
    const next = needPermission
      ? ' 下一步: 该接口需向 quake@360.cn 申请权限,可先 quake-h user 查看当前角色。'
      : noCredit
        ? ' 下一步: quake-h user 查月度剩余额度,或缩小 --size 减少扣费。'
        : ''
    throw new IncurError({
      code: json.code,
      message: msg + next,
      retryable: noCredit,
    })
  }
  if (!res.ok) {
    throw new IncurError({
      code: `HTTP_${res.status}`,
      message: `HTTP ${res.status}`,
      retryable: true,
    })
  }
  return json
}

/**
 * 缓存包装:cache_key 命中且未 TTL 过期则直接回放缓存(不打网络不扣积分);
 * 未命中先过自适应限流闸门(ratelimit.json:AIMD 间隔控制 + q3005 指数退避),
 * 通过后走网络、原样落盘、记 query_runs;限流反馈自动调节奏,调用方无感。
 * noCache 参数对应各命令的 --ignore-cache / scroll 翻页语义。
 */
async function cachedQuake(
  method: string,
  query: string,
  params: Record<string, unknown>,
  token: string,
  init: { method?: 'GET' | 'POST'; path: string; body?: unknown },
  opts?: { noCache?: boolean; ttlHours?: number },
): Promise<{ json: unknown; cacheHit: boolean; rawPath?: string; cacheKeyStr: string }> {
  const key = cacheKey(method, query, params)
  const ttl = opts?.ttlHours ?? TTL_HOURS[method as keyof typeof TTL_HOURS] ?? 0
  if (!opts?.noCache && ttl > 0) {
    const hit = readCache(method, key, ttl)
    if (hit) return { json: hit.body, cacheHit: true, cacheKeyStr: key }
  }

  // 自适应限流闸门:到点自动发,未到点自动等到点(cooldown 最长等一轮);
  // q3005 反馈进控制器(指数减速+静默),连续成功反馈收紧间隔——调用方无感知
  for (let attempt = 0; ; attempt++) {
    const gate = acquire()
    if (gate.waitMs > 0) {
      // 超过一轮静默才放弃,防止严重限流时无限等待
      if (attempt > 0 || gate.waitMs > LIMITS.COOLDOWN_MS + 5_000) {
        throw new IncurError({
          code: 'RATE_LIMITED',
          message: `自适应限流等待超限(需 ${Math.ceil(gate.waitMs / 1000)}s,已重试),稍后再试`,
          retryable: true,
        })
      }
      if (gate.waitMs > 2_000) {
        // stderr 提示不污染 stdout 数据面;静默自适应,非报错
        process.stderr.write(`[rate] 自适应等待 ${Math.ceil(gate.waitMs / 1000)}s(${gate.reason})\n`)
      }
      await Bun.sleep(gate.waitMs + 100)
      continue
    }
    break
  }

  let json: unknown
  try {
    json = await quakeRequest(init.path, token, init)
    reportOk()
  } catch (err) {
    // q3005 喂给控制器:间隔翻倍+静默期,下次调用自动慢下来
    if (err instanceof IncurError && err.code === 'q3005') reportLimited()
    throw err
  }
  // 空结果不落盘:避免把偶发空响应(或无效查询)缓存住,白占 TTL
  const data = (json as { data?: unknown }).data
  const empty = data === undefined || (Array.isArray(data) && data.length === 0)
  const rawPath = empty ? undefined : writeRaw(method, key, json)
  const meta = (json as { meta?: Record<string, any> }).meta
  const total =
    meta?.pagination?.total ?? (typeof meta?.total?.value === 'number' ? meta.total.value : null)
  recordRun(getDb(), {
    method,
    query,
    cacheKey: key,
    total,
    count: Array.isArray(data) ? data.length : data ? Object.keys(data).length : 0,
    rawPath,
    paginationId: meta?.pagination_id ?? (typeof params.pagination_id === 'string' ? params.pagination_id : null),
  })
  return { json, cacheHit: false, rawPath, cacheKeyStr: key }
}

/** 服务文档 -> 归档资产行 */
function toAssetRow(it: unknown): AssetRow {
  const d = it as {
    id?: string; ip?: string; port?: number; transport?: string; hostname?: string;
    time?: string; service?: { name?: string }; location?: { country_cn?: string }
  }
  return {
    doc_id: d.id ?? '',
    ip: d.ip ?? '',
    port: d.port ?? null,
    transport: d.transport ?? '',
    service_name: d.service?.name ?? '',
    hostname: Array.isArray(d.hostname) ? d.hostname.join(',') : (d.hostname ?? ''),
    country: d.location?.country_cn ?? '',
    time: d.time ?? '',
    raw_json: JSON.stringify(d),
  }
}

const cli = Cli.create('quake-h', {
  version: '0.1.0',
  description: '360 Quake 网络空间测绘 API 客户端(服务查询/主机查询/聚合/CVE 详情/对比/主动扫描)',
  env: z.object({
    QUAKE_API_KEY: z.string().optional().describe('Quake API Key(主变量名)'),
    QUAKE_TOKEN: z.string().optional().describe('Quake API Key 备用变量名'),
    QuakeAPIKey: z.string().optional().describe('.env 自动加载的变量名(bun 原生读 .env)'),
    QUAKE_HOST: z
      .string()
      .optional()
      .describe('API 域名,默认 https://qiye.quake.360.net'),
  }),
  sync: {
    suggestions: [
      'quake-h search "service: http" --size 5',
      'quake-h user',
      'quake-h cve CVE-2021-44228',
    ],
  },
})

/**
 * 取 API Key,三级回落(业界 dotenv/gh 惯例):
 * 1. 进程环境变量 QUAKE_API_KEY / QUAKE_TOKEN(bun 已并入 cwd .env 的 QuakeAPIKey)
 * 2. cwd .env(bun 自动加载,QuakeAPIKey)
 * 3. 用户配置目录 .env 回落(%APPDATA%/quake-h 或 XDG_CONFIG_HOME/quake-h)
 * incur 0.7.1 子命令 c.env 只含命令级 schema,故直接读 process.env。
 */
function pickToken(c: { env?: { QUAKE_API_KEY?: string; QUAKE_TOKEN?: string } }): string {
  return (
    c.env?.QUAKE_API_KEY ||
    c.env?.QUAKE_TOKEN ||
    process.env.QUAKE_API_KEY ||
    process.env.QUAKE_TOKEN ||
    process.env.QuakeAPIKey ||
    readUserEnvFallback('QUAKE_API_KEY') ||
    readUserEnvFallback('QuakeAPIKey') ||
    ''
  )
}

// ---------------------------------------------------------------------------
// 账户
// ---------------------------------------------------------------------------

cli.command('user', {
  description: '查询账户信息与剩余积分',
  output: z.object({
    username: z.string(),
    fullname: z.string(),
    credit: z.number(),
    month_remaining_credit: z.number(),
    free_query_api_count: z.number(),
    persistent_credit: z.number(),
    roles: z.array(z.string()),
  }),
  examples: [{ description: '查当前 key 的积分状态' }],
  async run(c) {
    const token = pickToken(c)
    if (!token) {
      return c.error({
        code: 'NOT_AUTHENTICATED',
        message: '未设置 QUAKE_API_KEY 环境变量',
        retryable: false,
        cta: {
          description: '下一步: 在项目 .env 写入 QuakeAPIKey=<key> 或导出 QUAKE_API_KEY 后重试',
          commands: [],
        },
      })
    }
    const json = (await quakeRequest('/api/v3/user/info', token)) as {
      data: {
        user?: { username?: string; fullname?: string }
        credit?: number
        month_remaining_credit?: number
        free_query_api_count?: number
        persistent_credit?: number
        role?: Array<{ fullname?: string }>
      }
    }
    const d = json.data ?? {}
    return {
      username: d.user?.username ?? '',
      fullname: d.user?.fullname ?? '',
      credit: d.credit ?? 0,
      month_remaining_credit: d.month_remaining_credit ?? 0,
      free_query_api_count: d.free_query_api_count ?? 0,
      persistent_credit: d.persistent_credit ?? 0,
      roles: (d.role ?? []).map((r) => r.fullname ?? '').filter(Boolean),
    }
  },
})

// ---------------------------------------------------------------------------
// 服务数据查询
// ---------------------------------------------------------------------------

/** 逗号分隔或重复旗标均可:--include ip,port 或 --include ip --include port */
const stringList = (description: string) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) =>
      (typeof v === 'string' ? v.split(',') : v).map((s) => s.trim()).filter(Boolean),
    )
    .describe(description)

const includeServiceFields = stringList(
  '返回字段白名单,逗号分隔,如 ip,port,service.name',
).optional()

cli.command('search', {
  description: '服务数据实时查询(小批量,每条结果扣 1 积分)',
  args: z.object({
    query: z.string().describe('Quake 检索语法,如 "service: http AND country: CN"'),
  }),
  options: z.object({
    start: z.coerce.number().default(0).describe('结果下标偏移'),
    size: z.coerce.number().default(10).describe('返回条数(1 到 500)'),
    include: includeServiceFields,
    exclude: includeServiceFields,
    rule: z.string().optional().describe('服务端 IP 列表收藏名称(rule 与 ip_list 二选一)'),
    ipList: stringList('IP 列表,逗号分隔(与 rule 二选一)').optional(),
    shortcuts: stringList('Web 过滤器 id(过滤无效请求/排除蜜罐/排除CDN),值从 web url 获取').optional(),
    latest: z.boolean().default(true).describe('是否使用最新数据'),
    ignoreCache: z.boolean().default(false).describe('忽略缓存取最新'),
    startTime: z.string().optional().describe('起始时间,格式 2020-10-14 00:00:00,UTC'),
    endTime: z.string().optional().describe('截止时间,同上'),
  }),
  alias: { size: 'n', include: 'f' },
  examples: [
    { args: { query: 'service: http' }, options: { size: 5 }, description: '查 http 服务前 5 条' },
    { args: { query: 'domain: "example.com"' }, description: '按域名查询' },
  ],
  async run(c) {
    const token = pickToken(c)
    const o = c.options
    const body: Record<string, unknown> = {
      query: c.args.query,
      start: o.start,
      size: o.size,
      ignore_cache: o.ignoreCache,
      latest: o.latest,
    }
    if (o.include?.length) body.include = o.include
    if (o.exclude?.length) body.exclude = o.exclude
    if (o.rule) body.rule = o.rule
    if (o.ipList?.length) body.ip_list = o.ipList
    if (o.shortcuts?.length) body.shortcuts = o.shortcuts
    if (o.startTime) body.start_time = o.startTime
    if (o.endTime) body.end_time = o.endTime

    const { json, cacheHit, rawPath, cacheKeyStr } = await cachedQuake(
      'search',
      c.args.query,
      body,
      token,
      { method: 'POST', path: '/api/v3/search/quake_service', body },
      { noCache: o.ignoreCache },
    )
    const typed = json as { data?: unknown[]; meta?: { pagination?: { total?: number } } }
    const items = typed.data ?? []
    const archived = cacheHit ? 0 : upsertAssets(getDb(), items.map(toAssetRow))
    return {
      total: typed.meta?.pagination?.total ?? null,
      count: items.length,
      cache_hit: cacheHit,
      archived,
      cache_key: cacheKeyStr,
      raw_path: rawPath ?? null,
      docs: items.map((it) => {
        const d = it as { id?: string; ip?: string; port?: number; transport?: string; time?: string; service?: { name?: string }; location?: { country_cn?: string } }
        return {
          id: d.id ?? '',
          ip: d.ip ?? '',
          port: d.port ?? null,
          transport: d.transport ?? '',
          service: d.service?.name ?? '',
          country: d.location?.country_cn ?? '',
          time: d.time ?? '',
        }
      }),
      cta: {
        description: '下一步:',
        commands: [
          { command: 'scroll', args: { query: c.args.query }, description: '深度翻页拉取更多' },
          { command: 'agg', args: { query: c.args.query }, description: '聚合统计分布' },
        ],
      },
    }
  },
})

cli.command('scroll', {
  description: '服务数据深度查询(游标翻页,适合批量拉取)',
  args: z.object({
    query: z.string().describe('Quake 检索语法'),
  }),
  options: z.object({
    size: z.coerce.number().default(10).describe('单页条数'),
    paginationId: z.string().optional().describe('翻页游标,来自上次返回的 meta.pagination_id'),
    include: includeServiceFields,
    ignoreCache: z.boolean().default(false),
    startTime: z.string().optional().describe('起始时间,UTC'),
    endTime: z.string().optional().describe('截止时间,UTC'),
  }),
  alias: { paginationId: 'p' },
  examples: [
    { args: { query: 'service: nginx' }, description: '首页' },
    { args: { query: 'service: nginx' }, options: { paginationId: '66c5937994...' }, description: '下一页(其余参数保持不变)' },
  ],
  async run(c) {
    const token = pickToken(c)
    const o = c.options
    const body: Record<string, unknown> = {
      query: c.args.query,
      size: o.size,
      ignore_cache: o.ignoreCache,
    }
    if (o.paginationId) body.pagination_id = o.paginationId
    if (o.include?.length) body.include = o.include
    if (o.startTime) body.start_time = o.startTime
    if (o.endTime) body.end_time = o.endTime

    // scroll 带游标即翻页:结果随时不同,不做缓存读,只落盘归档
    const { json, rawPath, cacheKeyStr } = await cachedQuake(
      'scroll',
      c.args.query,
      body,
      token,
      { method: 'POST', path: '/api/v3/scroll/quake_service', body },
      { noCache: true },
    )
    const typed = json as { data?: unknown[]; meta?: { pagination_id?: string; total?: { value?: number } } }
    const items = typed.data ?? []
    const archived = upsertAssets(getDb(), items.map(toAssetRow))
    const paginationId = typed.meta?.pagination_id
    return {
      total: typed.meta?.total?.value ?? null,
      count: items.length,
      archived,
      cache_key: cacheKeyStr,
      raw_path: rawPath ?? null,
      pagination_id: paginationId ?? null,
      docs: items.map((it) => {
        const d = it as { id?: string; ip?: string; port?: number; service?: { name?: string } }
        return { id: d.id ?? '', ip: d.ip ?? '', port: d.port ?? null, service: d.service?.name ?? '' }
      }),
      ...(paginationId
        ? {
            cta: {
              description: '下一步:',
              commands: [
                {
                  command: 'scroll',
                  args: { query: c.args.query },
                  options: { paginationId },
                  description: '用游标取下一页(其余参数保持不变)',
                },
              ],
            },
          }
        : {}),
    }
  },
})

// ---------------------------------------------------------------------------
// 聚合
// ---------------------------------------------------------------------------

cli.command('agg', {
  description: '服务数据聚合统计(最多同时聚合 2 个字段)',
  args: z.object({
    query: z.string().describe('Quake 检索语法'),
  }),
  options: z.object({
    by: stringList('聚合字段列表,最多 2 个,如 service 或 service,country')
      .transform((v) => (v.length ? v : ['service']))
      .default(['service']),
    size: z.coerce.number().default(5).describe('每项聚合返回个数'),
    ignoreCache: z.boolean().default(false),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
  }),
  alias: { by: 'b' },
  examples: [
    { args: { query: 'country: "China"' }, options: { by: ['service'], size: 10 }, description: '中国资产服务类型分布' },
  ],
  async run(c) {
    const token = pickToken(c)
    const o = c.options
    const body = {
      query: c.args.query,
      aggregation_list: o.by,
      size: o.size,
      ignore_cache: o.ignoreCache,
      ...(o.startTime ? { start_time: o.startTime } : {}),
      ...(o.endTime ? { end_time: o.endTime } : {}),
    }
    const { json, cacheHit, rawPath, cacheKeyStr } = await cachedQuake(
      'agg',
      c.args.query,
      body,
      token,
      { method: 'POST', path: '/api/v3/aggregation/quake_service', body },
      { noCache: o.ignoreCache },
    )
    const typed = json as { data?: Record<string, Array<{ key: string; doc_count: number }>> }
    const aggregations = typed.data ?? {}
    if (!cacheHit) {
      const queryKey = `${c.args.query}|${o.by.join(',')}`
      for (const [facet, buckets] of Object.entries(aggregations)) {
        saveAgg(getDb(), { queryKey, facet, buckets })
      }
    }
    return { cache_hit: cacheHit, cache_key: cacheKeyStr, raw_path: rawPath ?? null, aggregations }
  },
})

// ---------------------------------------------------------------------------
// CVE 详情
// ---------------------------------------------------------------------------

cli.command('cve', {
  description: '查询漏洞库 CVE 详情(免费,不扣积分)',
  args: z.object({
    cveId: z.string().describe('CVE 编号,如 CVE-2021-44228'),
  }),
  options: z.object({
    fields: stringList('只输出指定字段,逗号分隔,如 vul_name,vul_dork').optional(),
  }),
  alias: { fields: 'f' },
  examples: [{ args: { cveId: 'CVE-2021-44228' }, description: '查 Log4Shell 详情' }],
  async run(c) {
    const token = pickToken(c)
    const { json, cacheHit } = await cachedQuake(
      'cve',
      c.args.cveId,
      { cveId: c.args.cveId },
      token,
      { method: 'GET', path: `/api/v3/vulnerability/db/cve/detail/${c.args.cveId}` },
    )
    const typed = json as { data?: Record<string, unknown> }
    const data = typed.data ?? {}
    if (Object.keys(data).length === 0) {
      return c.error({
        code: 'NOT_FOUND',
        message: `CVE ${c.args.cveId} 在漏洞库中不存在`,
        retryable: false,
        cta: {
          description: '下一步:',
          commands: [{ command: 'cve', args: { cveId: 'CVE-2021-44228' }, description: '示例: Log4Shell' }],
        },
      })
    }
    const picked = c.options.fields?.length
      ? Object.fromEntries(c.options.fields.filter((f) => f in data).map((f) => [f, data[f]]))
      : { cache_hit: cacheHit, ...data }
    return picked
  },
})

// ---------------------------------------------------------------------------
// 多文档对比
// ---------------------------------------------------------------------------

cli.command('compare', {
  description: '多文档对比(至少 3 个 doc id,需 front.api.doc.compare 权限)',
  args: z.object({
    docIds: z.array(z.string()).min(3).describe('doc id 列表,来自 search 结果的 id 字段,至少 3 个'),
  }),
  examples: [
    {
      args: { docIds: ['8.149.67.89_2121_tcp', '47.99.142.226_2121_tcp', '147.224.236.5_2121_tcp'] },
      description: '对比 3 个服务文档',
    },
  ],
  async run(c) {
    const token = pickToken(c)
    const json = (await quakeRequest('/api/v3/search/compare/docs', token, {
      method: 'POST',
      body: { doc_ids: c.args.docIds },
    })) as { data?: unknown }
    return json.data ?? {}
  },
})

// ---------------------------------------------------------------------------
// 主动扫描
// ---------------------------------------------------------------------------

cli.command('scan', {
  description: '主动扫描任务(实测:query + port_list 必填,返回任务 id)',
  args: z.object({
    target: z.string().describe('扫描目标,Quake 检索语法或 IP/域名'),
  }),
  options: z.object({
    portList: stringList('扫描端口,逗号分隔,如 80,443').optional(),
    description: z.string().optional().describe('任务备注'),
  }),
  examples: [
    { args: { target: 'example.com' }, options: { portList: ['80', '443'] }, description: '对目标 80/443 发起主动扫描' },
  ],
  async run(c) {
    const token = pickToken(c)
    if (!c.options.portList?.length) {
      return c.error({
        code: 'USAGE',
        message: 'scan 需要 --port-list 端口列表(服务端必填),如 --port-list 80,443',
        retryable: false,
      })
    }
    const json = (await quakeRequest('/api/v3/fast_scan', token, {
      method: 'POST',
      body: {
        query: c.args.target,
        port_list: c.options.portList!.join(','),
        ...(c.options.description ? { description: c.options.description } : {}),
      },
    })) as { data?: unknown; message?: string }
    // 实测返回:任务 id 在 message 字段(24 位 hex),data 为空对象
    const fromData = typeof json.data === 'string' ? json.data : String((json.data as Record<string, unknown>)?.id ?? '')
    const taskId = fromData || (json.message && /^[0-9a-f]{24}$/.test(json.message) ? json.message : '')
    // 长时任务登记进 runs 库:跨会话可查,状态由 scan-status 刷新
    if (taskId) {
      upsertScanTask(getDb(), {
        taskId, target: c.args.target, portList: c.options.portList!.join(','),
        status: 'Running', progress: 0,
      })
    }
    return {
      task_id: taskId,
      cta: {
        description: '下一步:',
        commands: [
          { command: 'scan-status', args: { taskId }, description: '查任务状态(进度/时间线)' },
          { command: 'scan-ls', description: '列全部任务' },
        ],
      },
    }
  },
})

cli.command('scan-status', {
  description: '查询主动扫描任务状态(进度/状态时间线)',
  args: z.object({
    taskId: z.string().describe('任务 id,来自 scan 的返回'),
  }),
  async run(c) {
    const token = pickToken(c)
    const json = (await quakeRequest(`/api/v3/fast_scan/${c.args.taskId}`, token)) as {
      data?: Record<string, unknown>
    }
    const d = json.data ?? {}
    // 刷新任务库状态
    upsertScanTask(getDb(), {
      taskId: c.args.taskId,
      target: String(d.target ?? ''),
      portList: String(d.port_list ?? ''),
      status: String(d.status ?? 'Unknown'),
      progress: Number(d.progress ?? 0),
      total: (d.total as number) ?? null,
      send: (d.send as number) ?? null,
      success: (d.success as number) ?? null,
      failed: (d.failed as number) ?? null,
    })
    return d
  },
})

cli.command('scan-result', {
  description: '获取主动扫描任务结果',
  args: z.object({
    taskId: z.string().describe('任务 id'),
  }),
  options: z.object({
    start: z.coerce.number().default(0).describe('结果偏移'),
    size: z.coerce.number().default(10).describe('返回条数'),
  }),
  async run(c) {
    const token = pickToken(c)
    const json = (await quakeRequest(
      `/api/v3/fast_scan/result/${c.args.taskId}?start=${c.options.start}&size=${c.options.size}`,
      token,
    )) as { data?: unknown; meta?: { pagination?: { total?: number } } }
    const total = json.meta?.pagination?.total ?? null
    upsertScanTask(getDb(), {
      taskId: c.args.taskId, target: '', portList: '',
      status: total && total > 0 ? 'Done' : 'Running', progress: 1, resultCount: total,
    })
    return {
      total,
      results: json.data ?? [],
    }
  },
})

cli.command('scan-ls', {
  description: '列出本地登记的全部扫描任务(含状态与进度)',
  options: z.object({
    status: z.string().optional().describe('按状态过滤,如 Running/Done'),
  }),
  examples: [{ description: '列全部任务' }],
  run(c) {
    const rows = c.options.status
      ? getDb().query('SELECT task_id, target, port_list, status, progress, total, send, success, failed, result_count, updated_at FROM scan_tasks WHERE status = ? ORDER BY updated_at DESC').all(c.options.status)
      : getDb().query('SELECT task_id, target, port_list, status, progress, total, send, success, failed, result_count, updated_at FROM scan_tasks ORDER BY updated_at DESC').all()
    return { count: rows.length, tasks: rows }
  },
})

// ---------------------------------------------------------------------------
// 漏洞数据索引(需漏洞数据角色)
// ---------------------------------------------------------------------------

cli.command('vuln-scroll', {
  description: '漏洞数据深度查询(实测:仅裸文本/引号短语,字段语法不支持;游标翻页)',
  args: z.object({
    query: z.string().describe('检索词,如 Log4j2 或 "Apache Log4j2"(字段形如 app: 不支持)'),
  }),
  options: z.object({
    size: z.coerce.number().default(10).describe('单页条数'),
    paginationId: z.string().optional().describe('翻页游标(meta.pagination_id,5 分钟有效)'),
    ignoreCache: z.boolean().default(false),
    startTime: z.string().optional().describe('起始时间,UTC'),
    endTime: z.string().optional().describe('截止时间,UTC'),
  }),
  alias: { paginationId: 'p' },
  examples: [
    { args: { query: 'Log4j2' }, description: '搜 Log4j2 相关漏洞资产' },
    { args: { query: '"Apache Log4j2"' }, description: '引号短语防分词' },
  ],
  async run(c) {
    const token = pickToken(c)
    const o = c.options
    const body: Record<string, unknown> = {
      query: c.args.query,
      size: o.size,
      ignore_cache: o.ignoreCache,
    }
    if (o.paginationId) body.pagination_id = o.paginationId
    if (o.startTime) body.start_time = o.startTime
    if (o.endTime) body.end_time = o.endTime

    const { json, rawPath, cacheKeyStr } = await cachedQuake(
      'vuln_scroll',
      c.args.query,
      body,
      token,
      { method: 'POST', path: '/api/v3/scroll/quake_vulnerability', body },
      { noCache: true },
    )
    const typed = json as {
      data?: Array<Record<string, unknown>>
      meta?: { pagination_id?: string; total?: { value?: number } }
    }
    const items = typed.data ?? []
    const paginationId = typed.meta?.pagination_id
    return {
      total: typed.meta?.total?.value ?? null,
      count: items.length,
      cache_key: cacheKeyStr,
      raw_path: rawPath ?? null,
      pagination_id: paginationId ?? null,
      docs: items.map((it) => {
        const v = (it as { vulnerability?: Record<string, unknown> }).vulnerability ?? {}
        return {
          ip: (it as { ip?: string }).ip ?? '',
          org: (it as { org?: string }).org ?? '',
          is_domain: (it as { is_domain?: boolean }).is_domain ?? false,
          vuln_ids: v.number ?? [],
          evidence_prefix: String(v.evidence_str ?? '').slice(0, 120),
          raw: it,
        }
      }),
      ...(paginationId
        ? {
            cta: {
              description: '下一步:',
              commands: [
                { command: 'vuln-scroll', args: { query: c.args.query }, options: { paginationId }, description: '取下一页' },
              ],
            },
          }
        : {}),
    }
  },
})

// ---------------------------------------------------------------------------
// 主机数据族
// ---------------------------------------------------------------------------

const hostIncludeFields = stringList(
  '主机返回字段白名单,逗号分隔,可传字段用 quake-h fields host 查',
).optional()

function hostRow(h: unknown) {
  const d = h as {
    id?: string; ip?: string; asn?: number; org?: string; hostname?: string; time?: string
    os_name?: string; os_version?: string
    location?: { country_cn?: string; province_cn?: string; city_cn?: string; isp?: string }
    services?: Array<{ port?: number; name?: string; transport?: string; time?: string }>
  }
  return {
    ip: d.ip ?? d.id ?? '',
    asn: d.asn ?? null,
    org: d.org ?? '',
    hostname: Array.isArray(d.hostname) ? d.hostname.join(',') : (d.hostname ?? ''),
    os: [d.os_name, d.os_version].filter(Boolean).join(' ') || '',
    country: d.location?.country_cn ?? '',
    province: d.location?.province_cn ?? '',
    city: d.location?.city_cn ?? '',
    isp: d.location?.isp ?? '',
    time: d.time ?? '',
    services: (d.services ?? []).map((s) => ({
      port: s.port ?? null,
      name: s.name ?? '',
      transport: s.transport ?? '',
      time: s.time ?? '',
    })),
    raw_host: d,
  }
}

cli.command('host-search', {
  description: '主机数据实时查询(每 IP 带 services 聚合视图,每条扣 1 积分)',
  args: z.object({
    query: z.string().describe('Quake 检索语法,如 ip:"1.1.1.1/24" 或 service: http'),
  }),
  options: z.object({
    start: z.coerce.number().default(0).describe('结果下标偏移'),
    size: z.coerce.number().default(10).describe('返回条数'),
    include: hostIncludeFields,
    ipList: stringList('IP 列表,逗号分隔,与服务端收藏规则二选一').optional(),
    ignoreCache: z.boolean().default(false),
    startTime: z.string().optional().describe('起始时间,UTC'),
    endTime: z.string().optional().describe('截止时间,UTC'),
  }),
  alias: { size: 'n' },
  examples: [
    { args: { query: 'ip:"1.1.1.1"' }, description: '查单 IP 全部端口服务' },
    { args: { query: 'service: http' }, options: { size: 5 }, description: '有 http 服务的主机' },
  ],
  async run(c) {
    const token = pickToken(c)
    const o = c.options
    const body: Record<string, unknown> = {
      query: c.args.query,
      start: o.start,
      size: o.size,
      ignore_cache: o.ignoreCache,
    }
    if (o.include?.length) body.include = o.include
    if (o.ipList?.length) body.ip_list = o.ipList
    if (o.startTime) body.start_time = o.startTime
    if (o.endTime) body.end_time = o.endTime

    const { json, cacheHit, rawPath, cacheKeyStr } = await cachedQuake(
      'host_search',
      c.args.query,
      body,
      token,
      { method: 'POST', path: '/api/v3/search/quake_host', body },
      { noCache: o.ignoreCache },
    )
    const typed = json as { data?: unknown[]; meta?: { pagination?: { total?: number } } }
    const items = typed.data ?? []
    return {
      total: typed.meta?.pagination?.total ?? null,
      count: items.length,
      cache_hit: cacheHit,
      cache_key: cacheKeyStr,
      raw_path: rawPath ?? null,
      hosts: items.map(hostRow),
    }
  },
})

cli.command('host-scroll', {
  description: '主机数据深度查询(游标翻页,结果归档)',
  args: z.object({
    query: z.string().describe('Quake 检索语法'),
  }),
  options: z.object({
    size: z.coerce.number().default(10).describe('单页条数'),
    paginationId: z.string().optional().describe('翻页游标(其余参数须与首次一致)'),
    include: hostIncludeFields,
    ignoreCache: z.boolean().default(false),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
  }),
  alias: { paginationId: 'p' },
  examples: [{ args: { query: 'country:"China" AND service: ssh' }, description: '中国 ssh 主机' }],
  async run(c) {
    const token = pickToken(c)
    const o = c.options
    const body: Record<string, unknown> = {
      query: c.args.query,
      size: o.size,
      ignore_cache: o.ignoreCache,
    }
    if (o.paginationId) body.pagination_id = o.paginationId
    if (o.include?.length) body.include = o.include
    if (o.startTime) body.start_time = o.startTime
    if (o.endTime) body.end_time = o.endTime

    const { json, rawPath, cacheKeyStr } = await cachedQuake(
      'host_scroll',
      c.args.query,
      body,
      token,
      { method: 'POST', path: '/api/v3/scroll/quake_host', body },
      { noCache: true },
    )
    const typed = json as { data?: unknown[]; meta?: { pagination_id?: string; total?: { value?: number } } }
    const items = typed.data ?? []
    const paginationId = typed.meta?.pagination_id
    return {
      total: typed.meta?.total?.value ?? null,
      count: items.length,
      cache_key: cacheKeyStr,
      raw_path: rawPath ?? null,
      pagination_id: paginationId ?? null,
      hosts: items.map(hostRow),
      ...(paginationId
        ? {
            cta: {
              description: '下一步:',
              commands: [
                { command: 'host-scroll', args: { query: c.args.query }, options: { paginationId }, description: '取下一页' },
              ],
            },
          }
        : {}),
    }
  },
})

cli.command('host-agg', {
  description: '主机数据聚合统计(免费,最多 2 字段)',
  args: z.object({
    query: z.string().describe('Quake 检索语法'),
  }),
  options: z.object({
    by: stringList('聚合字段,如 service 或 asn,country(字段面用 quake-h fields host-agg 查)')
      .transform((v) => (v.length ? v : ['service']))
      .default(['service']),
    size: z.coerce.number().default(5).describe('每项聚合返回个数'),
    ignoreCache: z.boolean().default(false),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
  }),
  alias: { by: 'b' },
  examples: [{ args: { query: 'country:"China"' }, options: { by: ['service'], size: 5 }, description: '中国主机服务分布' }],
  async run(c) {
    const token = pickToken(c)
    const o = c.options
    const body = {
      query: c.args.query,
      aggregation_list: o.by,
      size: o.size,
      ignore_cache: o.ignoreCache,
      ...(o.startTime ? { start_time: o.startTime } : {}),
      ...(o.endTime ? { end_time: o.endTime } : {}),
    }
    const { json, cacheHit, rawPath, cacheKeyStr } = await cachedQuake(
      'host_agg',
      c.args.query,
      body,
      token,
      { method: 'POST', path: '/api/v3/aggregation/quake_host', body },
      { noCache: o.ignoreCache },
    )
    const typed = json as { data?: Record<string, Array<{ key: string; doc_count: number }>> }
    const aggregations = typed.data ?? {}
    if (!cacheHit) {
      const queryKey = `host|${c.args.query}|${o.by.join(',')}`
      for (const [facet, buckets] of Object.entries(aggregations)) {
        saveAgg(getDb(), { queryKey, facet, buckets })
      }
    }
    return { cache_hit: cacheHit, cache_key: cacheKeyStr, raw_path: rawPath ?? null, aggregations }
  },
})

cli.command('host-honeypot', {
  description: '主机蜜罐辅助判断:列出 host services 中可疑蜜罐特征(本地启发式,离线)',
  args: z.object({
    ip: z.string().describe('IP 或 CIDR'),
  }),
  hint: '结果为本地启发式(蜜罐常见多端口全开/异常协议组合),非官方判定。需权威结论用 web 端蜜罐识别。',
  examples: [{ args: { ip: '1.1.1.1' }, description: '查单 IP 服务指纹' }],
  async run(c) {
    const token = pickToken(c)
    const body = { query: `ip:"${c.args.ip}"`, start: 0, size: 1, ignore_cache: false }
    const { json } = await cachedQuake('host_search', c.args.ip, body, token, {
      method: 'POST',
      path: '/api/v3/search/quake_host',
      body,
    })
    const typed = json as { data?: unknown[] }
    const items = typed.data ?? []
    if (items.length === 0) {
      return c.error({
        code: 'NOT_FOUND',
        message: `IP ${c.args.ip} 无主机数据`,
        retryable: false,
      })
    }
    const h = hostRow(items[0])
    // 本地启发式:端口数多且覆盖典型蜜罐协议组合
    const ports = h.services.map((s) => s.port)
    const honeypotPorts = [21, 22, 23, 25, 80, 110, 143, 443, 3306, 3389, 5432, 6379, 8080, 8443]
    const hits = ports.filter((p) => p !== null && honeypotPorts.includes(p))
    const suspicious = ports.length >= 10 || hits.length >= 8
    return {
      ip: h.ip,
      service_count: ports.length,
      ports,
      common_honeypot_port_hits: hits.length,
      suspicious,
      verdict: suspicious ? '疑似蜜罐(端口面过宽,建议人工核验)' : '未见明显蜜罐特征',
    }
  },
})

// ---------------------------------------------------------------------------
// 字段参考与 favicon 相似度
// ---------------------------------------------------------------------------

cli.command('fields', {
  description: '拉取服务端可筛选/聚合字段清单(免费,7d 缓存)',
  args: z.object({
    dataset: z.enum(['service', 'host', 'service-agg', 'host-agg']).describe('service/host 为可筛选字段,带 -agg 后缀为聚合字段'),
  }),
  examples: [{ args: { dataset: 'service' }, description: '服务数据可筛选字段' }],
  async run(c) {
    const token = pickToken(c)
    const path =
      c.args.dataset === 'service' ? '/api/v3/filterable/field/quake_service'
      : c.args.dataset === 'host' ? '/api/v3/filterable/field/quake_host'
      : c.args.dataset === 'service-agg' ? '/api/v3/aggregation/quake_service'
      : '/api/v3/aggregation/quake_host'
    const { json, cacheHit } = await cachedQuake(
      `fields_${c.args.dataset}`,
      c.args.dataset,
      { dataset: c.args.dataset },
      token,
      { method: 'GET', path },
      { ttlHours: 168 },
    )
    const typed = json as { data?: string[] }
    const fields = typed.data ?? []
    return { count: fields.length, cache_hit: cacheHit, fields }
  },
})

cli.command('icon', {
  description: 'favicon 相似度查询(按 md5 找同 favicon 资产,免费)',
  args: z.object({
    faviconHash: z.string().describe('favicon 的 md5 值'),
  }),
  options: z.object({
    similar: z.coerce.number().default(0.9).describe('相似度阈值 0-1'),
    size: z.coerce.number().default(10).describe('返回数量,最多 50'),
    ignoreCache: z.boolean().default(false),
    startTime: z.string().optional().describe('起始时间,格式 2020-10-14 00:00:00,UTC'),
    endTime: z.string().optional().describe('截止时间,同上'),
  }),
  examples: [{ args: { faviconHash: '827fd6c561d4b1f932f75e0f9a17f766' }, description: '找同 favicon 资产' }],
  async run(c) {
    const token = pickToken(c)
    const body = {
      favicon_hash: c.args.faviconHash,
      similar: c.options.similar,
      size: Math.min(c.options.size, 50),
      ignore_cache: c.options.ignoreCache,
      ...(c.options.startTime ? { start_time: c.options.startTime } : {}),
      ...(c.options.endTime ? { end_time: c.options.endTime } : {}),
    }
    const { json, cacheHit, rawPath } = await cachedQuake(
      'icon',
      c.args.faviconHash,
      body,
      token,
      { method: 'POST', path: '/api/v3/query/similar_icon/aggregation', body },
      { noCache: c.options.ignoreCache },
    )
    const typed = json as { data?: Array<{ key: string; doc_count: number; data?: string }> }
    const items = typed.data ?? []
    return {
      cache_hit: cacheHit,
      raw_path: rawPath ?? null,
      icons: items.map((i) => ({
        key: i.key,
        doc_count: i.doc_count,
        // favicon base64 太长,默认裁剪;display 全量走 --filter-output data
        data_prefix: (i.data ?? '').slice(0, 64),
      })),
    }
  },
})

// ---------------------------------------------------------------------------
// 检索语法参考(离线)
// ---------------------------------------------------------------------------

cli.command('syntax', {
  description: 'Quake 检索语法字段参考(离线,不耗积分),按关键词过滤字段',
  args: z.object({
    keyword: z.string().optional().describe('过滤关键词,匹配字段名/中文名/分组,如 cert、tls、备案'),
  }),
  options: z.object({
    section: z.string().optional().describe('只看某分组,如 tls、http'),
    list: z.boolean().default(false).describe('只列分组名不展开'),
  }),
  alias: { section: 's' },
  examples: [
    { args: { keyword: 'tls' }, description: '查 TLS 证书类字段' },
    { args: { keyword: '备案' }, description: '按中文名搜' },
    { options: { list: true }, description: '列全部分组' },
  ],
  run(c) {
    if (c.options.list) {
      return { sections: SECTIONS.map((s) => ({ name: s.section, fields: s.entries.length })), operators: OPERATORS }
    }
    const kw = c.args.keyword?.toLowerCase()
    const matched = SECTIONS
      .filter((s) => !c.options.section || s.section === c.options.section)
      .map((s) => ({
        section: s.section,
        entries: s.entries.filter(
          (e) =>
            !kw ||
            e.field.toLowerCase().includes(kw) ||
            e.name.includes(kw) ||
            s.section.toLowerCase().includes(kw),
        ),
      }))
      .filter((s) => s.entries.length > 0)
    if (matched.length === 0) {
      return c.error({
        code: 'NOT_FOUND',
        message: `没有匹配 "${c.args.keyword}" 的字段`,
        retryable: false,
        cta: {
          description: '下一步:',
          commands: [{ command: 'syntax', options: { list: true }, description: '列出全部分组' }],
        },
      })
    }
    const total = matched.reduce((n, s) => n + s.entries.length, 0)
    return { total, sections: matched, operators: OPERATORS }
  },
})

// ---------------------------------------------------------------------------
// 缓存与归档管理
// ---------------------------------------------------------------------------

cli.command('rate', {
  description: '查看/管理自适应限流节奏(ratelimit.json 状态)',
  options: z.object({
    reset: z.boolean().default(false).describe('节奏复位到初始值(3s 间隔,清统计)'),
  }),
  examples: [
    { description: '查看当前节奏' },
    { options: { reset: true }, description: '复位节奏' },
  ],
  run(c) {
    if (c.options.reset) {
      resetState()
      const after = peek()
      return { reset: true, minIntervalMs: after.minIntervalMs }
    }
    const p = peek()
    return {
      当前最小间隔ms: p.minIntervalMs,
      静默期激活: p.cooldownActive,
      静默剩余ms: p.cooldownRemainMs,
      连续成功: p.consecutiveOk,
      连续限流: p.consecutiveLimited,
      累计调用: p.totalCalls,
      累计q3005: p.totalLimited,
      下一步: p.cooldownActive
        ? `静默期剩 ${Math.ceil(p.cooldownRemainMs / 1000)}s,期间网络命令自动等待`
        : `连续成功会逐步收紧到 ${LIMITS.MIN_MS}ms,撞 q3005 则翻倍退避`,
    }
  },
})

cli.command('cache', {
  description: '查询缓存历史(query_runs 表视图)',
  options: z.object({
    limit: z.coerce.number().default(20).describe('返回条数'),
    method: z.string().optional().describe('按方法过滤: search/scroll/agg/cve'),
  }),
  alias: { limit: 'n' },
  examples: [{ description: '最近 20 次查询记录' }],
  run(c) {
    const db = getDb()
    const rows = c.options.method
      ? db.query('SELECT ts, method, query, total, count, pagination_id, raw_path FROM query_runs WHERE method = ? ORDER BY id DESC LIMIT ?')
          .all(c.options.method, c.options.limit)
      : db.query('SELECT ts, method, query, total, count, pagination_id, raw_path FROM query_runs ORDER BY id DESC LIMIT ?')
          .all(c.options.limit)
    return { runs: rows }
  },
})

cli.command('export', {
  description: '归档库导出(SQL 查询 → JSON/CSV/Parquet 文件)',
  options: z.object({
    sql: z.string().optional().describe('只读 SQL,如 SELECT * FROM assets;缺省导出全 assets 表'),
    as: z.enum(['json', 'csv', 'parquet']).default('json').describe('导出格式(避开全局 --format 才叫 as)'),
    out: z.string().optional().describe('输出文件路径(parquet 必填;csv 可选;json 缺省 stdout)'),
    rowGroupSize: z.coerce.number().default(10_000).describe('parquet 行组大小'),
  }),
  alias: { out: 'o', as: 't' },
  examples: [
    { options: { sql: 'SELECT service_name, count(*) AS n FROM assets GROUP BY service_name ORDER BY n DESC LIMIT 10' }, description: '按服务名统计(json 到 stdout)' },
    { options: { as: 'parquet', out: 'assets.parquet' }, description: '全量资产导出 Parquet' },
    { options: { sql: 'SELECT ip, port, service_name FROM assets WHERE country = "中国"', as: 'parquet', out: 'cn.parquet' }, description: '筛选导出' },
  ],
  async run(c) {
    const runsDb = getDb()
    const { db: fedDb, assetsRef, months } = openFederatedDb()
    // 用户 SQL 里的 assets 引用改写为跨月 UNION ALL 子查询
    const rewrite = (q: string) => q.replace(/\bFROM\s+assets\b/g, `FROM ${assetsRef} AS assets`)
    const sql = (c.options.sql ?? (c.options.as === 'parquet' ? 'SELECT doc_id, ip, port, transport, service_name, hostname, country, data_time, data_time_is_observed, first_seen, last_seen FROM assets' : null))?.trim()
    if (!sql) {
      const stats = fedDb.query(`SELECT count(*) AS assets FROM ${assetsRef}`).get() as Record<string, number>
      const runStats = runsDb.query(
        'SELECT (SELECT count(*) FROM query_runs) AS runs, (SELECT count(*) FROM aggs) AS agg_rows',
      ).get() as Record<string, number>
      return {
        assets: (stats.assets as number) ?? 0,
        ...runStats,
        months: months.length,
        month_list: months,
        cta: {
          description: '下一步:',
          commands: [
            { command: 'export', options: { sql: true }, description: '传 --sql 导出数据行;--as parquet --out file 全表落盘' },
          ],
        },
      }
    }
    const finalSql = rewrite(sql)
    if (!/^select\b/i.test(sql)) {
      return c.error({
        code: 'USAGE',
        message: 'export 只接受 SELECT 语句',
        retryable: false,
      })
    }
    if (c.options.as === 'parquet') {
      const out = c.options.out
      if (!out) {
        return c.error({
          code: 'USAGE',
          message: 'parquet 格式需要 --out 文件路径',
          retryable: false,
          cta: {
            description: '下一步:',
            commands: [{ command: 'export', options: { as: 'parquet', out: 'assets.parquet' }, description: '示例:导出到 assets.parquet' }],
          },
        })
      }
      // 流式导出:SQLite 游标逐行喂 parquetWriteRows,fileWriter 1MB 块刷盘,
      // 峰值内存只受 rowGroupSize 约束,与总行数无关
      const { statSync } = await import('node:fs')
      const hw = await import('hyparquet-writer')
      const writer = hw.fileWriter(out)
      const stmt = fedDb.query(finalSql)
      const firstRow = (stmt.get() ?? null) as Record<string, unknown> | null
      if (!firstRow) {
        return c.error({ code: 'NOT_FOUND', message: '查询结果为空,未生成文件', retryable: false })
      }
      const columns = Object.keys(firstRow).map((name) => ({ name }))
      const cursor: AsyncIterable<Record<string, unknown>> = {
        [Symbol.asyncIterator]: async function* () {
          for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) yield row
        },
      }
      await (hw.parquetWriteRows as any)({
        writer,
        rows: cursor,
        columns,
        rowGroupSize: c.options.rowGroupSize,
        codec: 'SNAPPY',
        kvMetadata: [{ key: 'quake-h.schema', value: 'assets-export-v1' }],
      })
      const st = statSync(out)
      return {
        format: 'parquet',
        path: out,
        bytes: st.size,
        rowGroupSize: c.options.rowGroupSize,
        columns: columns.map((col) => col.name),
        note: '流式写入,峰值内存受 rowGroupSize 约束',
      }
    }

    const rows = fedDb.query(finalSql).all() as Record<string, unknown>[]

    if (c.options.as === 'csv') {
      const keys = rows.length ? Object.keys(rows[0]!) : []
      const csv = [
        keys.join(','),
        ...rows.map((r) => keys.map((k) => {
          const v = r[k]
          const s = v === null || v === undefined ? '' : String(v)
          return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
        }).join(',')),
      ].join('\n')
      if (c.options.out) {
        const { writeFileSync } = await import('node:fs')
        writeFileSync(c.options.out, csv, 'utf-8')
        return { format: 'csv', rows: rows.length, path: c.options.out }
      }
      return csv
    }

    return { rows }
  },
})


// SIGINT/SIGTERM:清理后非零退出(Windows 下 SIGTERM 由 Bun 模拟)
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

// 仅作为入口执行时解析 argv;被测试导入时(bun test)跳过
if (import.meta.main) cli.serve()

// 注意:不要 `export default cli`——cli 带 .fetch 方法,Bun 会把它当
// Workers 应用自动起 dev server(端口 3000);CLI 场景不需要。
// `incur gen` 类型生成如需导入,改用具名导出。
export { cli }
