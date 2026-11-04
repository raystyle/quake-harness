import { z } from 'incur'
import { type QuakeCli } from '../quake'
import { getDb, openFederatedDb } from '../archive'
import { SECTIONS, OPERATORS } from '../syntax'
import { peek, resetState, LIMITS } from '../ratelimit'

/** 离线/本地族:syntax / rate / cache / export */
export function registerLocalCommands(cli: QuakeCli): void {
  cli.command('syntax', {
    description: 'Quake 检索语法字段参考(离线,不耗积分),按关键词过滤字段',
    args: z.object({
      keyword: z.string().optional().describe('过滤关键词,匹配字段名/中文名/分组,如 cert、tls、备案'),
    }),
    options: z.object({
      section: z.string().optional().describe('只看某分组,如 tls、http'),
      list: z.boolean().default(false).describe('只列分组名不展开'),
    }),
    alias: { section: 's' },
    examples: [
      { args: { keyword: 'tls' }, description: '查 TLS 证书类字段' },
      { args: { keyword: '备案' }, description: '按中文名搜' },
      { options: { list: true }, description: '列全部分组' },
    ],
    run(c) {
      if (c.options.list) {
        return { sections: SECTIONS.map((s) => ({ name: s.section, fields: s.entries.length })), operators: OPERATORS }
      }
      const kw = c.args.keyword?.toLowerCase()
      const matched = SECTIONS
        .filter((s) => !c.options.section || s.section === c.options.section)
        .map((s) => ({
          section: s.section,
          entries: s.entries.filter(
            (e) =>
              !kw ||
              e.field.toLowerCase().includes(kw) ||
              e.name.includes(kw) ||
              s.section.toLowerCase().includes(kw),
          ),
        }))
        .filter((s) => s.entries.length > 0)
      if (matched.length === 0) {
        return c.error({
          code: 'NOT_FOUND',
          message: `没有匹配 "${c.args.keyword}" 的字段`,
          retryable: false,
          cta: {
            description: '下一步:',
            commands: [{ command: 'syntax', options: { list: true }, description: '列出全部分组' }],
          },
        })
      }
      const total = matched.reduce((n, s) => n + s.entries.length, 0)
      return { total, sections: matched, operators: OPERATORS }
    },
  })

  cli.command('rate', {
    description: '查看/管理自适应限流节奏(ratelimit.json 状态)',
    output: z.object({}).passthrough(),
    options: z.object({
      reset: z.boolean().default(false).describe('节奏复位到初始值(3s 间隔,清统计)'),
    }),
    examples: [
      { description: '查看当前节奏' },
      { options: { reset: true }, description: '复位节奏' },
    ],
    run(c) {
      if (c.options.reset) {
        resetState()
        const after = peek()
        return { reset: true, minIntervalMs: after.minIntervalMs }
      }
      const p = peek()
      return {
        当前最小间隔ms: p.minIntervalMs,
        静默期激活: p.cooldownActive,
        静默剩余ms: p.cooldownRemainMs,
        连续成功: p.consecutiveOk,
        连续限流: p.consecutiveLimited,
        累计调用: p.totalCalls,
        累计q3005: p.totalLimited,
        下一步: p.cooldownActive
          ? `静默期剩 ${Math.ceil(p.cooldownRemainMs / 1000)}s,期间网络命令自动等待`
          : `连续成功会逐步收紧到 ${LIMITS.MIN_MS}ms,撞 q3005 则翻倍退避`,
      }
    },
  })

  cli.command('cache', {
    description: '查询缓存历史(query_runs 表视图)',
    output: z.object({ runs: z.array(z.unknown()) }),
    options: z.object({
      limit: z.coerce.number().default(20).describe('返回条数'),
      method: z.string().optional().describe('按方法过滤: search/scroll/agg/cve'),
    }),
    alias: { limit: 'n' },
    examples: [{ description: '最近 20 次查询记录' }],
    run(c) {
      const db = getDb()
      const rows = c.options.method
        ? db.query('SELECT ts, method, query, total, count, pagination_id, raw_path FROM query_runs WHERE method = ? ORDER BY id DESC LIMIT ?')
            .all(c.options.method, c.options.limit)
        : db.query('SELECT ts, method, query, total, count, pagination_id, raw_path FROM query_runs ORDER BY id DESC LIMIT ?')
            .all(c.options.limit)
      return { runs: rows }
    },
  })

  cli.command('export', {
    description: '归档库导出(SQL 查询 → JSON/CSV/Parquet 文件)',
    options: z.object({
      sql: z.string().optional().describe('只读 SQL,如 SELECT * FROM assets;缺省导出全 assets 表'),
      as: z.enum(['json', 'csv', 'parquet']).default('json').describe('导出格式(避开全局 --format 才叫 as)'),
      out: z.string().optional().describe('输出文件路径(parquet 必填;csv 可选;json 缺省 stdout)'),
      rowGroupSize: z.coerce.number().default(10_000).describe('parquet 行组大小'),
    }),
    alias: { out: 'o', as: 't' },
    examples: [
      { options: { sql: 'SELECT service_name, count(*) AS n FROM assets GROUP BY service_name ORDER BY n DESC LIMIT 10' }, description: '按服务名统计(json 到 stdout)' },
      { options: { as: 'parquet', out: 'assets.parquet' }, description: '全量资产导出 Parquet' },
      { options: { sql: 'SELECT ip, port, service_name FROM assets WHERE country = "中国"', as: 'parquet', out: 'cn.parquet' }, description: '筛选导出' },
    ],
    async run(c) {
      const runsDb = getDb()
      const { db: fedDb, assetsRef, months } = openFederatedDb()
      // 用户 SQL 里的 assets 引用改写为跨月 UNION ALL 子查询
      const rewrite = (q: string) => q.replace(/\bFROM\s+assets\b/g, `FROM ${assetsRef} AS assets`)
      const sql = (c.options.sql ?? (c.options.as === 'parquet' ? 'SELECT doc_id, ip, port, transport, service_name, hostname, country, data_time, data_time_is_observed, first_seen, last_seen FROM assets' : null))?.trim()
      if (!sql) {
        const stats = fedDb.query(`SELECT count(*) AS assets FROM ${assetsRef}`).get() as Record<string, number>
        const runStats = runsDb.query(
          'SELECT (SELECT count(*) FROM query_runs) AS runs, (SELECT count(*) FROM aggs) AS agg_rows',
        ).get() as Record<string, number>
        return {
          assets: (stats.assets as number) ?? 0,
          ...runStats,
          months: months.length,
          month_list: months,
          cta: {
            description: '下一步:',
            commands: [
              { command: 'export', options: { sql: true }, description: '传 --sql 导出数据行;--as parquet --out file 全表落盘' },
            ],
          },
        }
      }
      const finalSql = rewrite(sql)
      if (!/^select\b/i.test(sql)) {
        return c.error({
          code: 'USAGE',
          message: 'export 只接受 SELECT 语句',
          retryable: false,
        })
      }
      if (c.options.as === 'parquet') {
        const out = c.options.out
        if (!out) {
          return c.error({
            code: 'USAGE',
            message: 'parquet 格式需要 --out 文件路径',
            retryable: false,
            cta: {
              description: '下一步:',
              commands: [{ command: 'export', options: { as: 'parquet', out: 'assets.parquet' }, description: '示例:导出到 assets.parquet' }],
            },
          })
        }
        // 流式导出:SQLite 游标逐行喂 parquetWriteRows,fileWriter 1MB 块刷盘,
        // 峰值内存只受 rowGroupSize 约束,与总行数无关
        const { statSync } = await import('node:fs')
        const hw = await import('hyparquet-writer')
        const writer = hw.fileWriter(out)
        const stmt = fedDb.query(finalSql)
        const firstRow = (stmt.get() ?? null) as Record<string, unknown> | null
        if (!firstRow) {
          return c.error({ code: 'NOT_FOUND', message: '查询结果为空,未生成文件', retryable: false })
        }
        const columns = Object.keys(firstRow).map((name) => ({ name }))
        const cursor: AsyncIterable<Record<string, unknown>> = {
          [Symbol.asyncIterator]: async function* () {
            for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) yield row
          },
        }
        await (hw.parquetWriteRows as any)({
          writer,
          rows: cursor,
          columns,
          rowGroupSize: c.options.rowGroupSize,
          codec: 'SNAPPY',
          kvMetadata: [{ key: 'quake-h.schema', value: 'assets-export-v1' }],
        })
        const st = statSync(out)
        return {
          format: 'parquet',
          path: out,
          bytes: st.size,
          rowGroupSize: c.options.rowGroupSize,
          columns: columns.map((col) => col.name),
          note: '流式写入,峰值内存受 rowGroupSize 约束',
        }
      }

      const rows = fedDb.query(finalSql).all() as Record<string, unknown>[]

      if (c.options.as === 'csv') {
        const keys = rows.length ? Object.keys(rows[0]!) : []
        const csv = [
          keys.join(','),
          ...rows.map((r) => keys.map((k) => {
            const v = r[k]
            const s = v === null || v === undefined ? '' : String(v)
            return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
          }).join(',')),
        ].join('\n')
        if (c.options.out) {
          const { writeFileSync } = await import('node:fs')
          writeFileSync(c.options.out, csv, 'utf-8')
          return { format: 'csv', rows: rows.length, path: c.options.out }
        }
        return csv
      }

      return { rows }
    },
  })
}
