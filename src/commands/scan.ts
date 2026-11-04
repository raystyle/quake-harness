import { z } from 'incur'
import { quakeRequest, pickToken, stringList, type QuakeCli } from '../quake'
import { getDb, upsertScanTask } from '../archive'
import { isTaskId, type TaskId } from '../types'

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
      // 实测返回:任务 id 在 message 字段(24 位 hex),data 为空对象;守卫窄化进 TaskId 域
      const fromData = typeof json.data === 'string' ? json.data : String((json.data as Record<string, unknown>)?.id ?? '')
      const rawTaskId = fromData || (json.message && isTaskId(json.message) ? json.message : '')
      const taskId: TaskId | '' = rawTaskId && isTaskId(rawTaskId) ? rawTaskId : ''
      // 长时任务登记进 runs 库:跨会话可查,状态由 scan-status 刷新
      if (taskId) {
        upsertScanTask(getDb(), {
          taskId, target: c.args.target, portList: c.options.portList!.join(','),
          status: 'Running', progress: 0,
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
      // 刷新任务库状态
      upsertScanTask(getDb(), {
        taskId: c.args.taskId,
        target: String(d.target ?? ''),
        portList: String(d.port_list ?? ''),
        status: String(d.status ?? 'Unknown'),
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
      upsertScanTask(getDb(), {
        taskId: c.args.taskId, target: '', portList: '',
        status: total && total > 0 ? 'Done' : 'Running', progress: 1, resultCount: total,
      })
      return {
        total,
        results: json.data ?? [],
      }
    },
  })

  cli.command('scan-ls', {
    description: '列出本地登记的全部扫描任务(含状态与进度)',
    options: z.object({
      status: z.string().optional().describe('按状态过滤,如 Running/Done'),
    }),
    examples: [{ description: '列全部任务' }],
    run(c) {
      const rows = c.options.status
        ? getDb().query('SELECT task_id, target, port_list, status, progress, total, send, success, failed, result_count, updated_at FROM scan_tasks WHERE status = ? ORDER BY updated_at DESC').all(c.options.status)
        : getDb().query('SELECT task_id, target, port_list, status, progress, total, send, success, failed, result_count, updated_at FROM scan_tasks ORDER BY updated_at DESC').all()
      return { count: rows.length, tasks: rows }
    },
  })
}
