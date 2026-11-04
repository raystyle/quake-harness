import { z } from 'incur'
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { quakeHHome, quakeHCache, quakeHConfig, readUserEnvFallback } from '../cache'
import { getDb, listMonths } from '../archive'
import { peek } from '../ratelimit'
import { QUAKE_HOST, quakeRequest, type QuakeCli } from '../quake'

/** 环境体检族:doctor(离线为主,--net 免费探活) */

interface CheckItem {
  name: string
  status: 'ok' | 'warn' | 'fail'
  detail: string
}

/** token 三级回落链逐层探测:命中即返回来源与掩码值 */
function probeToken(): { found: boolean; source: string | null; masked: string | null } {
  const chain: Array<{ value: string | undefined; source: string }> = [
    { value: process.env.QUAKE_API_KEY, source: 'process-env:QUAKE_API_KEY' },
    { value: process.env.QUAKE_TOKEN, source: 'process-env:QUAKE_TOKEN' },
    { value: process.env.QuakeAPIKey, source: 'process-env:QuakeAPIKey(cwd .env)' },
    { value: readUserEnvFallback('QUAKE_API_KEY'), source: 'user-config:.env:QUAKE_API_KEY' },
    { value: readUserEnvFallback('QuakeAPIKey'), source: 'user-config:.env:QuakeAPIKey' },
  ]
  for (const { value, source } of chain) {
    if (value) {
      const masked = value.length <= 8
        ? '****'
        : `${value.slice(0, 4)}…${value.slice(-4)}`
      return { found: true, source, masked }
    }
  }
  return { found: false, source: null, masked: null }
}

/** 目录可写探针:建目录 + 写删临时文件 */
function probeDir(dir: string): { ok: boolean; detail: string } {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, `.doctor-${process.pid}-${Date.now()}.tmp`)
    writeFileSync(probe, 'ok')
    unlinkSync(probe)
    return { ok: true, detail: '存在且可写' }
  } catch (err) {
    return { ok: false, detail: `不可写: ${(err as Error).message}` }
  }
}

export function registerDoctorCommands(cli: QuakeCli): void {
  cli.command('doctor', {
    description: '环境体检(离线:token 链/目录健康/归档库/限流节奏;--net 免费探活)',
    options: z.object({
      net: z.boolean().default(false).describe('额外探活:调 /api/v3/user/info(免费,不扣积分)'),
    }),
    examples: [
      { description: '离线体检' },
      { options: { net: true }, description: '带网络探活与积分余量' },
    ],
    output: z.object({
      status: z.enum(['ok', 'warn', 'fail']),
      net: z.boolean(),
      checks: z.array(z.object({
        name: z.string(),
        status: z.enum(['ok', 'warn', 'fail']),
        detail: z.string(),
      })),
      data_dir: z.string(),
      cache_dir: z.string(),
      config_dir: z.string(),
      token: z.object({
        found: z.boolean(),
        source: z.string().nullable(),
        masked: z.string().nullable(),
      }),
      archive: z.object({
        runs: z.number(),
        aggs: z.number(),
        scan_tasks: z.number(),
        months: z.number(),
        month_list: z.array(z.string()),
      }),
      ratelimit: z.object({
        min_interval_ms: z.number(),
        cooldown_active: z.boolean(),
        total_calls: z.number(),
        total_limited: z.number(),
      }),
      net_probe: z.object({
        ok: z.boolean(),
        host: z.string(),
        latency_ms: z.number().nullable(),
        credit: z.number().nullable(),
        month_remaining_credit: z.number().nullable(),
      }).nullable(),
    }),
    async run(c) {
      const checks: CheckItem[] = []

      const token = probeToken()
      checks.push(
        token.found
          ? { name: 'token', status: 'ok', detail: `已配置(${token.source}, ${token.masked})` }
          : {
              name: 'token', status: 'fail',
              detail: '未配置:在项目 .env 写入 QuakeAPIKey=<key>,或导出 QUAKE_API_KEY',
            },
      )

      const dataDir = quakeHHome()
      const cacheDir = quakeHCache()
      const configDir = quakeHConfig()
      for (const [name, dir] of [['dir-data', dataDir], ['dir-cache', cacheDir], ['dir-config', configDir]] as const) {
        const p = probeDir(dir)
        checks.push({ name, status: p.ok ? 'ok' : 'fail', detail: `${dir} ${p.detail}` })
      }

      let archive = { runs: 0, aggs: 0, scan_tasks: 0, months: 0, month_list: [] as string[] }
      try {
        const db = getDb()
        const runs = (db.query('SELECT count(*) AS n FROM query_runs').get() as { n: number }).n
        const aggs = (db.query('SELECT count(*) AS n FROM aggs').get() as { n: number }).n
        const scanTasks = (db.query('SELECT count(*) AS n FROM scan_tasks').get() as { n: number }).n
        const months = listMonths()
        archive = { runs, aggs, scan_tasks: scanTasks, months: months.length, month_list: months }
        checks.push({
          name: 'archive-db', status: 'ok',
          detail: `可开:runs=${runs} aggs=${aggs} scan_tasks=${scanTasks} 月表=${months.length}`,
        })
      } catch (err) {
        checks.push({ name: 'archive-db', status: 'fail', detail: `打开失败: ${(err as Error).message}` })
      }

      const rl = peek()
      const rlWarn = rl.cooldownActive || rl.consecutiveLimited > 0
      checks.push({
        name: 'ratelimit', status: rlWarn ? 'warn' : 'ok',
        detail: rlWarn
          ? `静默期激活(剩 ${Math.ceil(rl.cooldownRemainMs / 1000)}s)或近期撞过 q3005,节奏已放缓`
          : `节奏正常:最小间隔 ${rl.minIntervalMs}ms,累计调用 ${rl.totalCalls}`,
      })

      const legacy = join(homedir(), '.quake-h')
      if (existsSync(legacy) && legacy !== dataDir && legacy !== cacheDir && legacy !== configDir) {
        checks.push({
          name: 'legacy-home', status: 'warn',
          detail: `旧目录 ${legacy} 仍在(内容已自动迁移),确认后可手动删除`,
        })
      } else {
        checks.push({ name: 'legacy-home', status: 'ok', detail: '无旧目录残留' })
      }

      // --net 探活:免费端点,直连不走 cachedQuake(不进限流闸/缓存/查询记录)
      let netProbe: {
        ok: boolean; host: string; latency_ms: number | null
        credit: number | null; month_remaining_credit: number | null
      } | null = null
      if (c.options.net) {
        if (!token.found) {
          checks.push({ name: 'net', status: 'fail', detail: '未配置 token,无法探活' })
          netProbe = { ok: false, host: QUAKE_HOST, latency_ms: null, credit: null, month_remaining_credit: null }
        } else {
          // 取链上第一个实际值(与 probeToken 同序)
          const value =
            process.env.QUAKE_API_KEY || process.env.QUAKE_TOKEN || process.env.QuakeAPIKey ||
            readUserEnvFallback('QUAKE_API_KEY') || readUserEnvFallback('QuakeAPIKey') || ''
          const t0 = Date.now()
          try {
            const json = (await quakeRequest('/api/v3/user/info', value)) as {
              data?: { credit?: number; month_remaining_credit?: number }
            }
            const latency = Date.now() - t0
            netProbe = {
              ok: true, host: QUAKE_HOST, latency_ms: latency,
              credit: json.data?.credit ?? null,
              month_remaining_credit: json.data?.month_remaining_credit ?? null,
            }
            checks.push({
              name: 'net', status: 'ok',
              detail: `探活成功 ${latency}ms,积分余量 ${json.data?.month_remaining_credit ?? '未知'}`,
            })
          } catch (err) {
            netProbe = { ok: false, host: QUAKE_HOST, latency_ms: null, credit: null, month_remaining_credit: null }
            const e = err as { code?: string; message?: string }
            checks.push({ name: 'net', status: 'fail', detail: `${e.code ?? 'ERROR'}: ${e.message ?? ''}` })
          }
        }
      }

      const status: 'ok' | 'warn' | 'fail' =
        checks.some((k) => k.status === 'fail') ? 'fail'
        : checks.some((k) => k.status === 'warn') ? 'warn'
        : 'ok'
      return {
        status,
        net: c.options.net,
        checks,
        data_dir: dataDir,
        cache_dir: cacheDir,
        config_dir: configDir,
        token,
        archive,
        ratelimit: {
          min_interval_ms: rl.minIntervalMs,
          cooldown_active: rl.cooldownActive,
          total_calls: rl.totalCalls,
          total_limited: rl.totalLimited,
        },
        net_probe: netProbe,
      }
    },
  })
}
