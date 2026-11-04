import { z } from 'incur'
import { cachedQuake, pickToken, stringList, type QuakeCli } from '../quake'
import { getDb, saveAgg } from '../archive'
import {isBalancedQuery,  isIpCidr, validSize, API_SIZE_MAX } from '../types'
import { parseListBody, parseAggBody } from '../schemas'

/** 主机数据族:host-search / host-scroll / host-agg / host-honeypot */

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

export function registerHostCommands(cli: QuakeCli): void {
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
    output: z.object({
      total: z.number().nullable(),
      count: z.number(),
      cache_hit: z.boolean(),
      cache_key: z.string(),
      raw_path: z.string().nullable(),
      hosts: z.array(z.object({ raw_host: z.unknown() }).passthrough()),
    }),
    examples: [
      { args: { query: 'ip:"1.1.1.1"' }, description: '查单 IP 全部端口服务' },
      { args: { query: 'service: http' }, options: { size: 5 }, description: '有 http 服务的主机' },
    ],
    async run(c) {
      const token = pickToken(c)
      // 语法平衡守卫:未闭合引号/括号本地拦截,免 t6003 网络往返
      if (!isBalancedQuery(c.args.query)) {
        return c.error({
          code: 'USAGE',
          message: 'query 引号/括号未闭合(语法形检查,语义校验在服务端)',
          retryable: false,
        })
      }
      const o = c.options
      // 积分事故防线:每 IP 扣 1 积分,入口拦超限
      if (!validSize(o.size)) {
        return c.error({
          code: 'USAGE',
          message: `size 须为 1 到 ${API_SIZE_MAX} 的整数(每条结果扣 1 积分;批量拉取走 host-scroll)`,
          retryable: false,
        })
      }
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
      const { items, total } = parseListBody(json)
      return {
        total,
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
    output: z.object({
      total: z.number().nullable(),
      count: z.number(),
      cache_key: z.string(),
      raw_path: z.string().nullable(),
      pagination_id: z.string().nullable(),
      hosts: z.array(z.object({ raw_host: z.unknown() }).passthrough()),
    }),
    examples: [{ args: { query: 'country:"China" AND service: ssh' }, description: '中国 ssh 主机' }],
    async run(c) {
      const token = pickToken(c)
      // 语法平衡守卫:未闭合引号/括号本地拦截,免 t6003 网络往返
      if (!isBalancedQuery(c.args.query)) {
        return c.error({
          code: 'USAGE',
          message: 'query 引号/括号未闭合(语法形检查,语义校验在服务端)',
          retryable: false,
        })
      }
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
      const { items, total, paginationId } = parseListBody(json)
      return {
        total,
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
    output: z.object({
      cache_hit: z.boolean(),
      cache_key: z.string(),
      raw_path: z.string().nullable(),
      aggregations: z.record(z.string(), z.array(z.object({ key: z.unknown(), doc_count: z.number() }))),
    }),
    examples: [{ args: { query: 'country:"China"' }, options: { by: ['service'], size: 5 }, description: '中国主机服务分布' }],
    async run(c) {
      const token = pickToken(c)
      // 语法平衡守卫:未闭合引号/括号本地拦截,免 t6003 网络往返
      if (!isBalancedQuery(c.args.query)) {
        return c.error({
          code: 'USAGE',
          message: 'query 引号/括号未闭合(语法形检查,语义校验在服务端)',
          retryable: false,
        })
      }
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
      const aggregations = parseAggBody(json)
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
    description: '主机蜜罐辅助判断:判定逻辑本地启发式;数据取 host 查询(缓存未命中会联网)',
    args: z.object({
      ip: z.string().describe('IP 或 CIDR'),
    }),
    hint: '判定为本地启发式(端口面过宽/蜜罐协议组合),非官方判定;底层仍走一次 host 查询取数据(24h 缓存)。需权威结论用 web 端蜜罐识别。',
    output: z.object({
      ip: z.string(),
      service_count: z.number(),
      ports: z.array(z.number().nullable()),
      common_honeypot_port_hits: z.number(),
      suspicious: z.boolean(),
      verdict: z.string(),
    }),
    examples: [{ args: { ip: '1.1.1.1' }, description: '查单 IP 服务指纹' }],
    async run(c) {
      const token = pickToken(c)
      // IP/CIDR 守卫:非法形本地拦截,不落服务端 t6003
      if (!isIpCidr(c.args.ip)) {
        return c.error({
          code: 'USAGE',
          message: 'ip 须为 IPv4 或 CIDR 形,如 1.1.1.1 或 10.0.0.0/8',
          retryable: false,
        })
      }
      const body = { query: `ip:"${c.args.ip}"`, start: 0, size: 1, ignore_cache: false }
      const { json } = await cachedQuake('host_search', c.args.ip, body, token, {
        method: 'POST',
        path: '/api/v3/search/quake_host',
        body,
      })
      const { items } = parseListBody(json)
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
}
