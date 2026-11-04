import { z } from 'incur'
import { cachedQuake, pickToken, stringList, type QuakeCli } from '../quake'
import { isCveId } from '../types'

/** 漏洞库族:cve */
export function registerCveCommands(cli: QuakeCli): void {
  cli.command('cve', {
    description: '查询漏洞库 CVE 详情(免费,不扣积分)',
    args: z.object({
      cveId: z.string().describe('CVE 编号,如 CVE-2021-44228'),
    }),
    options: z.object({
      fields: stringList('只输出指定字段,逗号分隔,如 vul_name,vul_dork').optional(),
    }),
    alias: { fields: 'f' },
    output: z.object({}).passthrough(),
    examples: [{ args: { cveId: 'CVE-2021-44228' }, description: '查 Log4Shell 详情' }],
    async run(c) {
      const token = pickToken(c)
      // CVE 编号守卫:格式错直接 USAGE,不落到服务端 NOT_FOUND
      if (!isCveId(c.args.cveId)) {
        return c.error({
          code: 'USAGE',
          message: 'cveId 须为 CVE-YYYY-NNNN 形,如 CVE-2021-44228',
          retryable: false,
        })
      }
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
}
