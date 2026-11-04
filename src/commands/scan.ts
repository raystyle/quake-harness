import { z } from 'incur'
import { quakeRequest, pickToken, stringList, type QuakeCli } from '../quake'
import { getDb, upsertScanTask } from '../archive'
import { isTaskId, scanStatus, scanStatusToString, type TaskId } from '../types'

/** 主动扫描族:scan / scan-status / scan-result / scan-ls */
export function registerScanCommands(cli: QuakeCli): void {
  cli.command('scan', {
    description: '主动扫描任务(query 检索语法 / ip_list / domain_list 三种目标形,port_list 必填)',
    hint: '提交形三选一(官方 API):--ip-list 数组、--domain-list 数组、缺省走 query 检索语法。建议 IP 与域名分开下两次(用户实践,分发更快)。',
    args: z.object({
      target: z.string().optional().describe('扫描目标,Quake 检索语法(与 --ip-list/--domain-list 三选一)'),
    }),
    options: z.object({
      portList: stringList('扫描端口,逗号分隔,如 80,443').optional(),
      ipList: stringList('IP 列表,逗号分隔(数组形提交,与 target 三选一)').optional(),
      domainList: stringList('域名列表,逗号分隔(数组形提交,与 target 三选一)').optional(),
      description: z.string().optional().describe('任务备注'),
    }),
    output: z.object({ task_id: z.string() }),
    examples: [
      { args: { target: 'example.com' }, options: { portList: ['80', '443'] }, description: 'query 形:对目标 80/443 发起主动扫描' },
      { options: { ipList: ['1.1.1.1'], portList: ['443'] }, description: 'ip_list 形:单 IP' },
      { options: { domainList: ['a.com', 'b.com'], portList: ['80', '443'] }, description: 'domain_list 形:域名列表' },
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
      // 目标形三选一守卫
      const hasIp = Boolean(c.options.ipList?.length)
      const hasDomain = Boolean(c.options.domainList?.length)
      const hasQuery = Boolean(c.args.target)
      if ([hasIp, hasDomain, hasQuery].filter(Boolean).length !== 1) {
        return c.error({
          code: 'USAGE',
          message: '目标形三选一:--ip-list / --domain-list / 位置参 query(检索语法),勿混用或全缺',
          retryable: false,
        })
      }
      const body: Record<string, unknown> = {
        port_list: c.options.portList!.join(','),
        ...(c.options.description ? { description: c.options.description } : {}),
      }
      if (hasIp) body.ip_list = c.options.ipList
      else if (hasDomain) body.domain_list = c.options.domainList
      else body.query = c.args.target
      const targetLabel = hasIp ? `ip:${c.options.ipList!.join(',')}`
        : hasDomain ? `domain:${c.options.domainList!.join(',')}`
        : c.args.target!
      const json = (await quakeRequest('/api/v3/fast_scan', token, {
        method: 'POST',
        body,
      })) as { data?: unknown; message?: string }
      // 任务 id 主路径在 data(字符串形);message 字段为兼容回落(24 位 hex 校验)。守卫窄化进 TaskId 域
      const fromData = typeof json.data === 'string' ? json.data : String((json.data as Record<string, unknown>)?.id ?? '')
      const rawTaskId = fromData || (json.message && isTaskId(json.message) ? json.message : '')
      const taskId: TaskId | null = rawTaskId && isTaskId(rawTaskId) ? rawTaskId : null
      // 长时任务登记进 runs 库:跨会话可查,状态由 scan-status 刷新
      if (taskId) {
        upsertScanTask(getDb(), {
          taskId, target: targetLabel, portList: c.options.portList!.join(','),
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
      // runtime_id 回填:扫描产出经 task.runtime_id 检索服务索引获取(延迟入库)
      const runtimeId = typeof d.runtime_id === 'string' ? d.runtime_id : ''
      upsertScanTask(getDb(), {
        taskId: c.args.taskId,
        status: scanStatusToString(st),
        progress: Number(d.progress ?? 0),
        total: typeof d.total === 'number' ? d.total : undefined,
        send: typeof d.send === 'number' ? d.send : undefined,
        success: typeof d.success === 'number' ? d.success : undefined,
        failed: typeof d.failed === 'number' ? d.failed : undefined,
        runtimeId,
        // target/portList/resultCount 不传:详情端点无 target 回显,
        // 传空串会抹掉簿内登记值(部分更新语义,undefined = 不改)
      })
      return {
        ...d,
        ...(runtimeId
          ? {
              cta: {
                description: '下一步:',
                commands: [
                  {
                    command: 'service-search',
                    args: { query: `task.runtime_id:"${runtimeId}"` },
                    description: '查扫描采集结果(入服务索引,延迟较高,Finished 后需等)',
                  },
                  { command: 'scan-result', args: { taskId: c.args.taskId }, description: '查扫描风险项' },
                ],
              },
            }
          : {}),
      }
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
      // 只更新结果计数,状态由 scan-status 权威刷新;
      // 其余列不传 = 不改(部分更新语义),不会抹掉簿内登记
      upsertScanTask(getDb(), {
        taskId: c.args.taskId,
        status: '',
        resultCount: total,
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
              status: scanStatusToString(st),
              progress: Number(d.progress ?? 0),
              total: typeof d.total === 'number' ? d.total : undefined,
              send: typeof d.send === 'number' ? d.send : undefined,
              success: typeof d.success === 'number' ? d.success : undefined,
              failed: typeof d.failed === 'number' ? d.failed : undefined,
              runtimeId: typeof d.runtime_id === 'string' ? d.runtime_id : '',
            })
            refreshed++
          } catch {
            // 单任务拉失败不挡列表(任务可能已被服务端清理)
          }
        }
      }

      const rows = c.options.status
        ? getDb().query('SELECT task_id, target, port_list, status, progress, total, send, success, failed, result_count, runtime_id, updated_at FROM scan_tasks WHERE status = ? ORDER BY updated_at DESC').all(c.options.status)
        : getDb().query('SELECT task_id, target, port_list, status, progress, total, send, success, failed, result_count, runtime_id, updated_at FROM scan_tasks ORDER BY updated_at DESC').all()
      return {
        count: rows.length,
        ...(recovered ? { recovered } : {}),
        ...(refreshed ? { refreshed } : {}),
        tasks: rows,
      }
    },
  })
}
