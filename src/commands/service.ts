import { z } from 'incur'
import { cachedQuake, pickToken, stringList, toAssetRow, type QuakeCli } from '../quake'
import { getDb, upsertAssets, saveAgg } from '../archive'
import {isBalancedQuery,  validSize, API_SIZE_MAX } from '../types'
import { parseListBody, parseAggBody } from '../schemas'

/** 服务数据查询族:search / scroll / agg */

const includeServiceFields = stringList(
  '返回字段白名单,逗号分隔,如 ip,port,service.name',
).optional()

export function registerServiceCommands(cli: QuakeCli): void {
  cli.command('service-search', {
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
    output: z.object({
      total: z.number().nullable(),
      count: z.number(),
      cache_hit: z.boolean(),
      archived: z.number(),
      cache_key: z.string(),
      raw_path: z.string().nullable(),
      docs: z.array(z.object({
        id: z.string(),
        ip: z.string(),
        port: z.number().nullable(),
        transport: z.string(),
        service: z.string(),
        country: z.string(),
        time: z.string(),
      })),
    }),
    examples: [
      { args: { query: 'service: http' }, options: { size: 5 }, description: '查 http 服务前 5 条' },
      { args: { query: 'domain: "example.com"' }, description: '按域名查询' },
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
      // 积分事故防线:size 每条 1 积分,入口拦下超限请求
      if (!validSize(o.size)) {
        return c.error({
          code: 'USAGE',
          message: `size 须为 1 到 ${API_SIZE_MAX} 的整数(每条结果扣 1 积分;批量拉取走 service-scroll)`,
          retryable: false,
        })
      }
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
      const { items, total } = parseListBody(json)
      const rows = items.map(toAssetRow).filter((r): r is import('../archive').AssetRow => r !== null)
      const archived = cacheHit ? 0 : upsertAssets(getDb(), rows)
      return {
        total,
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
            { command: 'service-scroll', args: { query: c.args.query }, description: '深度翻页拉取更多' },
            { command: 'service-agg', args: { query: c.args.query }, description: '聚合统计分布' },
          ],
        },
      }
    },
  })

  cli.command('service-scroll', {
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
    output: z.object({
      total: z.number().nullable(),
      count: z.number(),
      archived: z.number(),
      cache_key: z.string(),
      raw_path: z.string().nullable(),
      pagination_id: z.string().nullable(),
      docs: z.array(z.object({
        id: z.string(),
        ip: z.string(),
        port: z.number().nullable(),
        service: z.string(),
      })),
    }),
    examples: [
      { args: { query: 'service: nginx' }, description: '首页' },
      { args: { query: 'service: nginx' }, options: { paginationId: '66c5937994...' }, description: '下一页(其余参数保持不变)' },
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
      const { items, total, paginationId } = parseListBody(json)
      const rows = items.map(toAssetRow).filter((r): r is import('../archive').AssetRow => r !== null)
    const archived = upsertAssets(getDb(), rows)
      return {
        total,
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
                    command: 'service-scroll',
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

  cli.command('service-agg', {
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
    output: z.object({
      cache_hit: z.boolean(),
      cache_key: z.string(),
      raw_path: z.string().nullable(),
      aggregations: z.record(z.string(), z.array(z.object({ key: z.unknown(), doc_count: z.number() }))),
    }),
    examples: [
      { args: { query: 'country: "China"' }, options: { by: ['service'], size: 10 }, description: '中国资产服务类型分布' },
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
      const aggregations = parseAggBody(json)
      if (!cacheHit) {
        const queryKey = `${c.args.query}|${o.by.join(',')}`
        for (const [facet, buckets] of Object.entries(aggregations)) {
          saveAgg(getDb(), { queryKey, facet, buckets })
        }
      }
      return { cache_hit: cacheHit, cache_key: cacheKeyStr, raw_path: rawPath ?? null, aggregations }
    },
  })
}
