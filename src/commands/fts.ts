import { z } from 'incur'
import { ftsSearch, backfillFts, listMonths } from '../archive'
import type { QuakeCli } from '../quake'
import { isMonth } from '../types'

/** 全文检索族:fts(本地归档 SQLite FTS5,离线零积分) */
export function registerFtsCommands(cli: QuakeCli): void {
  cli.command('fts', {
    description: '归档全文检索(FTS5:已归档资产的 title/body/server/host,离线)',
    hint: '检索本地月库已归档资产,不打网络不扣积分;MATCH 语法:FilesMan、title:b374k、server:Nginx AND host:qq.com、"短语"。新数据先 service-search 归档再 fts。',
    args: z.object({
      match: z.string().describe('FTS5 MATCH 表达式,如 FilesMan 或 title:b374k 或 server:"Apache" AND host:gov.cn'),
    }),
    options: z.object({
      size: z.coerce.number().default(20).describe('返回条数'),
      month: z.string().optional().describe('只搜某月库(YYYY-MM),缺省搜全部月库'),
      backfill: z.boolean().default(false).describe('先回填存量行再搜(旧库首次用 FTS 时需要)'),
    }),
    alias: { size: 'n' },
    examples: [
      { args: { match: 'FilesMan' }, description: '归档里搜 FilesMan 活壳' },
      { args: { match: 'title:b374k' }, description: '按 title 列搜' },
      { args: { match: 'server:"Apache" AND host:gov.cn' }, description: '列限定 + 布尔组合' },
    ],
    output: z.object({
      count: z.number(),
      months_searched: z.array(z.string()),
      hits: z.array(z.object({
        month: z.string(),
        doc_id: z.string(),
        ip: z.string(),
        port: z.number().nullable(),
        title: z.string(),
        snippet: z.string(),
      })),
    }),
    async run(c) {
      if (c.options.month && !isMonth(c.options.month)) {
        return c.error({
          code: 'USAGE',
          message: '--month 须为 YYYY-MM 形(可用月库: ' + listMonths().join(', ') + ')',
          retryable: false,
        })
      }
      const months = c.options.month
        ? [c.options.month as import('../types').Month]
        : undefined
      if (c.options.backfill) {
        for (const m of (months ?? listMonths())) backfillFts(m)
      }
      const hits = ftsSearch(c.args.match, { limit: c.options.size, months })
      return {
        count: hits.length,
        months_searched: months ?? listMonths(),
        hits,
        ...(hits.length > 0
          ? {
              cta: {
                description: '下一步:',
                commands: [
                  { command: 'export', args: {}, options: { sql: `SELECT * FROM assets WHERE ip = '${hits[0]!.ip}'` }, description: '导出命中资产全行' },
                ],
              },
            }
          : {}),
      }
    },
  })
}
