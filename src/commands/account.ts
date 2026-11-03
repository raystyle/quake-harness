import { z } from 'incur'
import { quakeRequest, pickToken, type QuakeCli } from '../quake'

/** 账户族:user */
export function registerAccountCommands(cli: QuakeCli): void {
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
}
