import { z } from 'incur'
import { quakeRequest, pickToken, type QuakeCli } from '../quake'
import { isDocId } from '../types'

/** 多文档对比族:compare */
export function registerCompareCommands(cli: QuakeCli): void {
  cli.command('compare', {
    description: '多文档对比(至少 3 个 doc id,需 front.api.doc.compare 权限)',
    args: z.object({
      docIds: z.array(z.string()).min(3).describe('doc id 列表,来自 search 结果的 id 字段,至少 3 个'),
    }),
    output: z.object({}).passthrough(),
    examples: [
      {
        args: { docIds: ['8.149.67.89_2121_tcp', '47.99.142.226_2121_tcp', '147.224.236.5_2121_tcp'] },
        description: '对比 3 个服务文档',
      },
    ],
    async run(c) {
      const token = pickToken(c)
      // doc id 守卫:非法 id 本地拦截,不落服务端 q2001
      const bad = c.args.docIds.filter((d) => !isDocId(d))
      if (bad.length > 0) {
        return c.error({
          code: 'USAGE',
          message: `doc id 须为 24 位 hex / ip_port_transport / host_port_transport 形,无效输入: ${bad[0]!.slice(0, 40)}`,
          retryable: false,
        })
      }
      const json = (await quakeRequest('/api/v3/search/compare/docs', token, {
        method: 'POST',
        body: { doc_ids: c.args.docIds },
      })) as { data?: unknown }
      return {
        ...(json.data ?? {}) as Record<string, unknown>,
        cta: {
          description: '下一步:',
          commands: [
            { command: 'service-search', args: { query: 'service: http' }, options: { size: 3 }, description: '取更多 doc id 扩对比集' },
          ],
        },
      }
    },
  })
}
