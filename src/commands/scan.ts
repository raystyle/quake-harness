import { z } from 'incur'
import { quakeRequest, pickToken, stringList, type QuakeCli } from '../quake'
import { getDb, upsertScanTask } from '../archive'
import { isTaskId, scanStatus, scanStatusToString, type TaskId } from '../types'

/** 主动扫描族:scan / scan-status / scan-result / scan-ls */
export function registerScanCommands(cli: QuakeCli): void {
  cli.command('scan', {
    description: '主动扫描任务(实测:query + port_list 必填,返回任务 id)',
    args: z.object({
      target: z.string().describe('扫描目标,Quake 检索语法或 IP/域名'),
    }),
    options: z.object({
      portList: stringList('扫描端口,逗号分隔,如 80,443').optional(),
      description: z.string().optional().describe('任务备注'),
    }),
    output: z.object({ task_id: z.string() }),
    examples: [
      { args: { target: 'example.com' }, options: { portList: ['80', '443'] }, description: '对目标 80/443 发起主动扫描' },
    ],
    async run(c) {
      const token = pickToken(c)
      if (!c.options.portList?.length) {
        return c.error({
          code: 'USAGE',
          message: 'scan 需要 --port-list 端口列表(服务端必填),如 --port-list 80,443',
          retryable: false,
        })
      }
      const json = (await quakeRequest('/api/v3/fast_scan', token, {
        method: 'POST',
        body: {
          query: c.args.target,
          port_list: c.options.portList!.join(','),
          ...(c.options.description ? { description: c.options.description } : {}),
        },
      })) as { data?: unknown; message?: string }
      // 任务 id 主路径在 data(字符串形);message 字段为兼容回落(24 位 hex 校验)。守卫窄化进 TaskId 域
      const fromData = typeof json.data === 'string' ? json.data : String((json.data as Record<string, unknown>)?.id ?? '')
      const rawTaskId = fromData || (json.message && isTaskId(json.message) ? json.message : '')
      const taskId: TaskId | null = rawTaskId && isTaskId(rawTaskId) ? rawTaskId : null
      // 长时任务登记进 runs 库:跨会话可查,状态由 scan-status 刷新
      if (taskId) {
        upsertScanTask(getDb(), {
          taskId, target: c.args.target, portList: c.options.portList!.join(','),
          status: 'Running', progress: 0,
        })
      }
      // 解析失败:任务确已提交但拿不到 id,显式告知而非发空 id CTA
      if (!taskId) {
        return c.error({
          code: 'ENGINE_PARSE',
          message: '任务已提交但响应中未解析到任务 id(24 位 hex),请用 scan-ls 查看登记任务',
          retryable: false,
          cta: {
            description: '下一步:',
            commands: [{ command: 'scan-ls', description: '列全部登记任务' }],
          },
        })
      }
      return {
        task_id: taskId,
        cta: {
          description: '下一步:',
          commands: [
            { command: 'scan-status', args: { taskId }, description: '查任务状态(进度/时间线)' },
            { command: 'scan-ls', description: '列全部任务' },
          ],
        },
      }
    },
  })

  cli.command('scan-status', {
    description: '查询主动扫描任务状态(进度/状态时间线)',
    output: z.object({}).passthrough(),
    args: z.object({
      taskId: z.string().describe('任务 id,来自 scan 的返回'),
    }),
    async run(c) {
      const token = pickToken(c)
      // API 边界守卫:非法任务 id 快速失败,不落到服务端
      if (!isTaskId(c.args.taskId)) {
        return c.error({
          code: 'USAGE',
          message: 'taskId 须为 24 位 hex(来自 scan 返回的 task_id)',
          retryable: false,
        })
      }
      const json = (await quakeRequest(`/api/v3/fast_scan/${c.args.taskId}`, token)) as {
        data?: Record<string, unknown>
      }
      const d = json.data ?? {}
      // 刷新任务库状态;状态经 scanStatus 联合窄化(未知词表不丢原文)
      const st = typeof d.status === 'string' ? scanStatus(d.status) : scanStatus('Unknown')
      upsertScanTask(getDb(), {
        taskId: c.args.taskId,
        target: String(d.target ?? ''),
        portList: String(d.port_list ?? ''),
        status: scanStatusToString(st),
        progress: Number(d.progress ?? 0),
        total: (d.total as number) ?? null,
        send: (d.send as number) ?? null,
        success: (d.success as number) ?? null,
        failed: (d.failed as number) ?? null,
      })
      return d
    },
  })

  cli.command('scan-result', {
    description: '获取主动扫描任务结果',
    output: z.object({
      total: z.number().nullable(),
      results: z.array(z.unknown()),
    }),
    args: z.object({
      taskId: z.string().describe('任务 id'),
    }),
    options: z.object({
      start: z.coerce.number().default(0).describe('结果偏移'),
      size: z.coerce.number().default(10).describe('返回条数'),
    }),
    async run(c) {
      const token = pickToken(c)
      if (!isTaskId(c.args.taskId)) {
        return c.error({
          code: 'USAGE',
          message: 'taskId 须为 24 位 hex(来自 scan 返回的 task_id)',
          retryable: false,
        })
      }
      const json = (await quakeRequest(
        `/api/v3/fast_scan/result/${c.args.taskId}?start=${c.options.start}&size=${c.options.size}`,
        token,
      )) as { data?: unknown; meta?: { pagination?: { total?: number } } }
      const total = json.meta?.pagination?.total ?? null
      // 只更新结果计数,不改状态:服务端状态由 scan-status 权威刷新
      // (total>0 推 Done 会把「完成但零结果」错标 Running)
      upsertScanTask(getDb(), {
        taskId: c.args.taskId, target: '', portList: '',
        status: '', progress: 0, resultCount: total,
      })
      return {
        total,
        results: (json.data ?? []) as unknown[],
      }
    },
  })

  cli.command('scan-ls', {
    description: '列出本地登记的全部扫描任务(含状态与进度)',
    hint: 'API 无任务列表端点(已实测钉死),本地簿是唯一「查所有任务」途径。--refresh 顺带拉服务端最新状态;--from-cache 从 raw 缓存找回未登记的失联任务 id。',
    output: z.object({
      count: z.number(),
      recovered: z.number().optional(),
      refreshed: z.number().optional(),
      tasks: z.array(z.unknown()),
    }),
    options: z.object({
      status: z.string().optional().describe('按状态过滤,如 Running/Finished'),
      refresh: z.boolean().default(false).describe('逐任务拉服务端最新状态并回写本地簿'),
      fromCache: z.boolean().default(false).describe('扫 raw 缓存目录,把未登记的任务 id 找回本地簿(API 无列表,失联 id 唯一恢复途径)'),
    }),
    alias: { fromCache: 'C' },
    examples: [
      { description: '列全部任务' },
      { options: { refresh: true }, description: '列之前先拉服务端最新状态' },
      { options: { fromCache: true }, description: '从缓存找回失联任务 id' },
    ],
    async run(c) {
      // --from-cache:raw 缓存里 scan-status/scan-result 的路径即任务 id
      // (路径形 /fast_scan/<24hex> 或 /fast_scan/result/<24hex>),本地簿没有的登记回来
      let recovered = 0
      if (c.options.fromCache) {
        const { readdirSync, existsSync } = await import('node:fs')
        const { join } = await import('node:path')
        const { quakeHCache } = await import('../cache')
        const base = join(quakeHCache(), 'raw')
        const known = new Set(
          (getDb().query('SELECT task_id FROM scan_tasks').all() as Array<{ task_id: string }>).map((r) => r.task_id),
        )
        if (existsSync(base)) {
          for (const m of readdirSync(base)) {
            if (m !== 'scan_status' && m !== 'scan_result') continue
            const dir = join(base, m)
            for (const date of readdirSync(dir)) {
              const ddir = join(dir, date)
              try {
                for (const f of readdirSync(ddir)) {
                  const id = f.replace(/\.json$/, '')
                  if (isTaskId(id) && !known.has(id)) {
                    upsertScanTask(getDb(), { taskId: id, target: '(从缓存找回)', portList: '', status: 'Recovered', progress: 0 })
                    known.add(id)
                    recovered++
                  }
                }
              } catch { /* 目录被并发清理等,跳过 */ }
            }
          }
        }
      }

      // --refresh:逐任务拉服务端最新状态回写本地簿
      let refreshed = 0
      if (c.options.refresh) {
        const token = pickToken(c)
        const ids = getDb().query('SELECT task_id FROM scan_tasks').all() as Array<{ task_id: string }>
        for (const { task_id } of ids) {
          try {
            const json = (await quakeRequest(`/api/v3/fast_scan/${task_id}`, token)) as {
              data?: Record<string, unknown>
            }
            const d = json.data ?? {}
            const st = typeof d.status === 'string' ? scanStatus(d.status) : scanStatus('Unknown')
            upsertScanTask(getDb(), {
              taskId: task_id as import('../types').TaskId,
              target: String(d.target ?? ''),
              portList: String(d.port_list ?? ''),
              status: scanStatusToString(st),
              progress: Number(d.progress ?? 0),
              total: (d.total as number) ?? null,
              send: (d.send as number) ?? null,
              success: (d.success as number) ?? null,
              failed: (d.failed as number) ?? null,
            })
            refreshed++
          } catch {
            // 单任务拉失败不挡列表(任务可能已被服务端清理)
          }
        }
      }

      const rows = c.options.status
        ? getDb().query('SELECT task_id, target, port_list, status, progress, total, send, success, failed, result_count, updated_at FROM scan_tasks WHERE status = ? ORDER BY updated_at DESC').all(c.options.status)
        : getDb().query('SELECT task_id, target, port_list, status, progress, total, send, success, failed, result_count, updated_at FROM scan_tasks ORDER BY updated_at DESC').all()
      return {
        count: rows.length,
        ...(recovered ? { recovered } : {}),
        ...(refreshed ? { refreshed } : {}),
        tasks: rows,
      }
    },
  })
}
