import { z } from 'incur'
import { parseListBody } from '../schemas'
import { cachedQuake, pickToken, type QuakeCli } from '../quake'

/** 漏洞数据索引族:vuln-scroll(需漏洞数据角色) */
export function registerVulnScrollCommands(cli: QuakeCli): void {
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
    output: z.object({
      total: z.number().nullable(),
      count: z.number(),
      cache_key: z.string(),
      raw_path: z.string().nullable(),
      pagination_id: z.string().nullable(),
      docs: z.array(z.object({
        ip: z.string(),
        org: z.string(),
        is_domain: z.boolean(),
        vuln_ids: z.array(z.string()),
        evidence_prefix: z.string(),
        raw: z.unknown(),
      })),
    }),
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
      const { items, total, paginationId } = parseListBody(json)
      return {
        total,
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
            // vuln_ids 上游形漂移容错:实测 number 为 string[],非数组回落空
            vuln_ids: Array.isArray(v.number) ? (v.number as string[]) : [],
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
}
