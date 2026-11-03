import { z } from 'incur'
import { cachedQuake, pickToken, stringList, type QuakeCli } from '../quake'

/** 字段参考与 favicon 相似度族:fields / icon */
export function registerReferenceCommands(cli: QuakeCli): void {
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
}
