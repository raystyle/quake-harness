import { Cli, Errors, z } from 'incur'
import { cacheKey, readCache, writeRaw, TTL_HOURS, readUserEnvFallback } from './cache'
import { getDb, recordRun, type AssetRow } from './archive'
import { acquire, reportOk, reportLimited, LIMITS } from './ratelimit'
import { isDocId, type DocId, type RawMethod, type CacheableMethod } from './types'
import { parseEnvelope } from './schemas'

const { IncurError } = Errors

const QUAKE_HOST = process.env.QUAKE_HOST || 'https://qiye.quake.360.net'

/**
 * Quake API 统一请求:服务端错误(code != 0)抛 IncurError,
 * 由 incur 外层 catch 统一转错误信封;code 保留 Quake 错误码(q2001/q3012 等),
 * 提示以『下一步:』前缀拼在 message 尾部(IncurError 无独立 hint 字段)。
 */
async function quakeRequest(
  path: string,
  token: string,
  init?: { method?: 'GET' | 'POST'; body?: unknown },
): Promise<unknown> {
  // 统一认证边界:空 token 在此拦截,不再依赖各命令自查
  if (!token) {
    throw new IncurError({
      code: 'NOT_AUTHENTICATED',
      message: '未设置 QUAKE_API_KEY 环境变量 下一步: 在项目 .env 写入 QuakeAPIKey=<key> 或导出 QUAKE_API_KEY 后重试',
      retryable: false,
    })
  }
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
  const env = parseEnvelope(json)
  if (env.kind === 'err') {
    const msg = env.message
    const needPermission = msg.includes('Missing permission') || msg.includes('权限')
    const noCredit = msg.includes('积分')
    const next = needPermission
      ? ' 下一步: 该接口需向 quake@360.cn 申请权限,可先 quake-h user 查看当前角色。'
      : noCredit
        ? ' 下一步: quake-h user 查月度剩余额度,或缩小 --size 减少扣费。'
        : ''
    throw new IncurError({
      code: env.code,
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
 * noCache 参数对应各命令的 --ignore-cache / scroll 翻页语义:
 * 只跳过「读」,网络响应仍原样落盘 + 记 query_runs(翻页结果下次可审计)。
 */
async function cachedQuake(
  method: RawMethod,
  query: string,
  params: Record<string, unknown>,
  token: string,
  init: { method?: 'GET' | 'POST'; path: string; body?: unknown },
  opts?: { noCache?: boolean; ttlHours?: number },
): Promise<{ json: unknown; cacheHit: boolean; rawPath?: string; cacheKeyStr: string }> {
  const key = cacheKey(method, query, params)
  const ttl = opts?.ttlHours ?? (method in TTL_HOURS ? TTL_HOURS[method as CacheableMethod] : 0)
  if (!opts?.noCache && ttl > 0) {
    const hit = readCache(method, key, ttl)
    if (hit) return { json: hit.body, cacheHit: true, cacheKeyStr: key }
  }

  // 自适应限流闸门:到点自动发,未到点自动等到点(cooldown 最长等一轮);
  // q3005 反馈进控制器(指数减速+静默),连续成功反馈收紧间隔:调用方无感知
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

/** 服务文档 -> 归档资产行;非法/缺失 doc id 返回 null(调用方过滤并计数拒收),
 *  禁止空串构造品牌值:空串会令多条非法文档共享月库主键互相覆盖 */
function toAssetRow(it: unknown): AssetRow | null {
  const d = it as {
    id?: string; ip?: string; port?: number; transport?: string; hostname?: string;
    time?: string; service?: { name?: string }; location?: { country_cn?: string }
  }
  const id = d.id ?? ''
  if (!isDocId(id)) return null
  return {
    doc_id: id,
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

/** 逗号分隔或重复旗标均可:--include ip,port 或 --include ip --include port */
const stringList = (description: string) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) =>
      (typeof v === 'string' ? v.split(',') : v).map((s) => s.trim()).filter(Boolean),
    )
    .describe(description)

const cli = Cli.create('quake-h', {
  version: '0.2.1',
  description: '360 Quake 网络空间测绘 API 客户端(服务查询/主机查询/聚合/CVE 详情/对比/主动扫描)',
  mcp: {
    // 常规直出面:每个命令注册为独立 MCP 工具(带完整 inputSchema),
    // 而非缺省的 search_tools 渐进发现四件套;24 个命令规模直出无压力
    tools: { discovery: 'direct' },
  },
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
      'quake-h doctor',
      'quake-h service-agg "app:\"Nginx\"" --by country_cn --size 5',
      'quake-h service-search "service: http" --size 1',
      'quake-h fts title:login',
      'quake-h cve CVE-2021-44228',
    ],
  },
})

/** 命令注册函数的形参类型:沿用 cli 工厂返回值的完整泛型 */
export type QuakeCli = typeof cli

export {
  QUAKE_HOST,
  quakeRequest,
  cachedQuake,
  toAssetRow,
  pickToken,
  stringList,
  cli,
}
