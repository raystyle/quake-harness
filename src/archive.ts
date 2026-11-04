import { Database } from 'bun:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { quakeHHome, quakeHCache } from './cache'
import type { DocId, TaskId, Month } from './types'

/**
 * B 层归档:按数据时间(年月)分库 + 三时间语义分离(见 src/types.ts TimeAxis)。
 *
 * 三时间一览(每行一个语义,勿混):
 * - data_time:Quake 引擎采集该资产的时刻(文档 time 字段);
 *   文档缺 time 时回落本地查询时刻,且 data_time_is_observed=1 打标(可信度降级)
 * - first_seen:本地首次观测(查询到)该资产的时刻,UPSERT 不改
 * - last_seen:本地最近观测时刻,每次重查 UPSERT 推进
 * 分库:assets 落 data_time 对应的 YYYYMM.sqlite;跨库查询经 export --sql
 * 的 ATTACH 自动聚合。query_runs/aggs 是查询行为记录,不随数据分库,恒在 runs 库。
 */

export interface AssetRow {
  /** 文档身份(非端点身份):同一 ip:port 的不同 vhost 是不同 doc_id 多行 */
  doc_id: DocId
  /** 端点业务身份三件套(AssetKey):统计资产数按 ip+port+transport 去重 */
  ip: string
  port: number | null
  transport: string
  service_name: string
  hostname: string
  country: string
  /** Quake 采集时间(ISO);空则由写入方回落查询时刻 */
  time: string
  raw_json: string
}

/** 数据时间的年月分桶(2026-11-03T.. -> 202611);无时间归 observation 兜底桶 */
export function dataMonth(iso: string, fallbackNow = new Date()): Month {
  const t = iso ? Date.parse(iso) : NaN
  const d = Number.isNaN(t) ? fallbackNow : new Date(t)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` as Month
}

/** runs 库(查询行为与聚合,不分月) */
let runsDbSingleton: Database | null = null
export function getDb(): Database {
  if (!runsDbSingleton) runsDbSingleton = openRunsDb()
  return runsDbSingleton
}

function openRunsDb(): Database {
  const p = join(quakeHHome(), 'runs.sqlite')
  mkdirSync(dirname(p), { recursive: true })
  const db = new Database(p, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS query_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      method TEXT NOT NULL,
      query TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      total INTEGER,
      count INTEGER,
      pagination_id TEXT,
      raw_path TEXT
    );
    CREATE TABLE IF NOT EXISTS aggs (
      query_key TEXT NOT NULL,
      facet TEXT NOT NULL,
      bucket_key TEXT NOT NULL,
      doc_count INTEGER NOT NULL,
      ts TEXT NOT NULL,
      PRIMARY KEY (query_key, facet, bucket_key, ts)
    );
    CREATE TABLE IF NOT EXISTS scan_tasks (
      task_id TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      port_list TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Running',
      progress REAL NOT NULL DEFAULT 0,
      total INTEGER,
      send INTEGER,
      success INTEGER,
      failed INTEGER,
      result_count INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  return db
}

/** scan 任务登记/刷新 */
export interface ScanTaskRecord {
  taskId: TaskId
  target: string
  portList: string
  status: string
  progress: number
  total?: number | null
  send?: number | null
  success?: number | null
  failed?: number | null
  resultCount?: number | null
}

export function upsertScanTask(db: Database, r: ScanTaskRecord): void {
  const now = new Date().toISOString()
  db.query(`
    INSERT INTO scan_tasks (task_id, target, port_list, status, progress, total, send, success, failed, result_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      status = excluded.status,
      progress = excluded.progress,
      total = excluded.total,
      send = excluded.send,
      success = excluded.success,
      failed = excluded.failed,
      result_count = excluded.result_count,
      updated_at = excluded.updated_at
  `).run(
    r.taskId, r.target, r.portList, r.status, r.progress,
    r.total ?? null, r.send ?? null, r.success ?? null, r.failed ?? null, r.resultCount ?? null,
    now, now,
  )
}

/** 月库缓存:YYYYMM.sqlite */
const monthDbs = new Map<string, Database>()

export function getMonthDb(month: Month): Database {
  let db = monthDbs.get(month)
  if (!db) {
    const p = join(quakeHHome(), `${month}.sqlite`)
    mkdirSync(dirname(p), { recursive: true })
    db = new Database(p, { create: true })
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS assets (
        doc_id TEXT PRIMARY KEY,
        ip TEXT NOT NULL,
        port INTEGER,
        transport TEXT NOT NULL DEFAULT '',
        service_name TEXT NOT NULL DEFAULT '',
        hostname TEXT NOT NULL DEFAULT '',
        country TEXT NOT NULL DEFAULT '',
        data_time TEXT NOT NULL DEFAULT '',
        data_time_is_observed INTEGER NOT NULL DEFAULT 0,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_assets_ip ON assets(ip);
      CREATE INDEX IF NOT EXISTS idx_assets_data_time ON assets(data_time);
    `)
    ensureFts(db)
    monthDbs.set(month, db)
  }
  return db
}

/** 已存在的月库列表(升序) */
export function listMonths(): Month[] {
  const home = quakeHHome()
  if (!existsSync(home)) return []
  const { readdirSync } = require('node:fs') as typeof import('node:fs')
  return readdirSync(home)
    .filter((f) => /^\d{4}-\d{2}\.sqlite$/.test(f))
    .map((f) => f.slice(0, -'.sqlite'.length) as Month)
    .sort()
}

/**
 * 跨月聚合:ATTACH 全部月库,给出 assets 的 UNION ALL 子查询引用。
 * 直接查 attached 库(SQLite 的 VIEW 不能引用 attached 库,子查询可以),
 * 不物化全表,parquet 流式导出经它逐月拉取。
 */
export function openFederatedDb(): { db: Database; assetsRef: string; months: string[] } {
  const db = new Database(':memory:')
  const months = listMonths()
  for (const m of months) {
    // 别名横线换下划线:SQL 标识符不允许裸 -
    db.exec(`ATTACH DATABASE '${join(quakeHHome(), `${m}.sqlite`)}' AS m${m.replaceAll('-', '_')}`)
  }
  const assetsRef = months.length
    ? `(${months.map((m) => `SELECT *, '${m}' AS month FROM m${m.replaceAll('-', '_')}.assets`).join(' UNION ALL ')})`
    : '(SELECT NULL AS doc_id, NULL AS ip, NULL AS port, NULL AS transport, NULL AS service_name, NULL AS hostname, NULL AS country, NULL AS data_time, NULL AS data_time_is_observed, NULL AS first_seen, NULL AS last_seen, NULL AS raw_json, NULL AS month WHERE 0)'
  return { db, assetsRef, months }
}

export interface RunRecord {
  method: string  // RawMethod;入 DB 列为 TEXT,历史行含未知键,收裸 string
  query: string
  cacheKey: string
  total?: number | null
  count?: number
  paginationId?: string | null
  rawPath?: string
}

export function recordRun(db: Database, r: RunRecord): void {
  db.query(
    'INSERT INTO query_runs (ts, method, query, cache_key, total, count, pagination_id, raw_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    new Date().toISOString(),
    r.method,
    r.query,
    r.cacheKey,
    r.total ?? null,
    r.count ?? null,
    r.paginationId ?? null,
    r.rawPath ?? null,
  )
}

export function upsertAssets(_runsDb: Database, rows: AssetRow[]): number {
  if (rows.length === 0) return 0
  const now = new Date().toISOString()
  // 按数据年月分组,各组写自己的月库
  const byMonth = new Map<Month, AssetRow[]>()
  for (const a of rows) {
    // 数据时间为空:回落观测时刻并打标(data_time_is_observed=1)
    const hasDataTime = Boolean(a.time)
    const effective = hasDataTime ? a.time : now
    const m = dataMonth(effective)
    const enriched: AssetRow = { ...a, time: effective }
    const bucket = byMonth.get(m) ?? []
    bucket.push(enriched)
    byMonth.set(m, bucket)
    enrichedRows.set(a.doc_id, hasDataTime ? 0 : 1)
  }
  const stmt = `
    INSERT INTO assets (doc_id, ip, port, transport, service_name, hostname, country, data_time, data_time_is_observed, first_seen, last_seen, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(doc_id) DO UPDATE SET
      data_time = excluded.data_time,
      data_time_is_observed = excluded.data_time_is_observed,
      last_seen = excluded.last_seen,
      raw_json = excluded.raw_json,
      service_name = excluded.service_name,
      hostname = excluded.hostname,
      country = excluded.country
  `
  let n = 0
  for (const [month, batch] of byMonth) {
    const db = getMonthDb(month)
    const tx = db.transaction((rows: AssetRow[]) => {
      for (const a of rows) {
        db.query(stmt).run(
          a.doc_id, a.ip, a.port, a.transport, a.service_name, a.hostname, a.country,
          a.time, enrichedRows.get(a.doc_id) ?? 0, now, now, a.raw_json,
        )
        // FTS 同步:按 doc_id 查真实 rowid 回填。
        // 坑:ON CONFLICT DO UPDATE 的 lastInsertRowid 在冲突更新时指向
        // 冲突探测行(新分配的 abort rowid),不是被更新行,不能用于 FTS 定位
        const rowid = (db.query('SELECT rowid FROM assets WHERE doc_id = ?').get(a.doc_id) as { rowid: number | bigint } | null)?.rowid
        if (rowid !== undefined) ftsUpsert(db, rowid, a.raw_json)
      }
    })
    tx(batch)
    n += batch.length
  }
  enrichedRows.clear()
  return n
}

/** doc_id -> data_time_is_observed 标记(写入期暂存,避免改 AssetRow 形状) */
const enrichedRows = new Map<string, number>()

// ---------------------------------------------------------------------------
// FTS5 全文索引:external content 表挂 assets,可检索文本列从 raw_json 提取
// ---------------------------------------------------------------------------

/** FTS 虚表建表 + 删行同步触发器(独立 FTS 表,非 external content) */
function ensureFts(db: Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(
      doc_id UNINDEXED,
      title, body, server, host
    );
    CREATE TRIGGER IF NOT EXISTS assets_fts_del AFTER DELETE ON assets BEGIN
      DELETE FROM assets_fts WHERE rowid = old.rowid;
    END;
  `)
}

/** raw_json 提取 FTS 文本列(title/body/server/host);缺失容错为空串 */
export function ftsColumns(rawJson: string): { title: string; body: string; server: string; host: string } {
  try {
    const d = JSON.parse(rawJson) as {
      service?: { http?: { title?: unknown; body?: unknown; server?: unknown; host?: unknown } }
    }
    const h = d.service?.http ?? {}
    const s = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')
    return { title: s(h.title, 500), body: s(h.body, 8000), server: s(h.server, 200), host: s(h.host, 300) }
  } catch {
    return { title: '', body: '', server: '', host: '' }
  }
}

/** 单行 FTS 写入(UPSERT 后调用;同 rowid 先删后插,幂等) */
function ftsUpsert(db: Database, rowid: number | bigint, rawJson: string): void {
  const c = ftsColumns(rawJson)
  db.query('DELETE FROM assets_fts WHERE rowid = ?').run(rowid)
  db.query(
    'INSERT INTO assets_fts(rowid, doc_id, title, body, server, host) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(rowid, ftsDocId(rowid, rawJson), c.title, c.body, c.server, c.host)
}

/** doc_id 从 raw_json 提取(FTS 行带 doc_id 便于直查);取不到回落 rowid 串 */
function ftsDocId(rowid: number | bigint, rawJson: string): string {
  try {
    const id = (JSON.parse(rawJson) as { id?: unknown }).id
    return typeof id === 'string' ? id : String(rowid)
  } catch {
    return String(rowid)
  }
}

/** 存量库回填(建虚表时已入库的行);重跑幂等 */
export function backfillFts(month: Month): number {
  const db = getMonthDb(month)
  const rows = db.query(
    'SELECT a.rowid AS rid, a.raw_json FROM assets a LEFT JOIN assets_fts f ON f.rowid = a.rowid WHERE f.rowid IS NULL',
  ).all() as Array<{ rid: number; raw_json: string }>
  const tx = db.transaction((list: typeof rows) => {
    for (const r of list) ftsUpsert(db, r.rid, r.raw_json)
  })
  tx(rows)
  return rows.length
}

/** 跨月 FTS 检索:各月库 MATCH 后 UNION,返回带月标与高亮片段的行 */
export function ftsSearch(
  match: string,
  opts: { limit?: number; months?: Month[] } = {},
): Array<{ month: string; doc_id: string; ip: string; port: number | null; title: string; snippet: string }> {
  const limit = opts.limit ?? 20
  const months = opts.months ?? listMonths()
  const out: Array<{ month: string; doc_id: string; ip: string; port: number | null; title: string; snippet: string }> = []
  for (const m of months) {
    const db = getMonthDb(m)
    const rows = db.query(`
      SELECT a.doc_id, a.ip, a.port, f.title AS title,
             snippet(assets_fts, 2, '[', ']', '…', 12) AS snip
      FROM assets_fts f JOIN assets a ON a.rowid = f.rowid
      WHERE assets_fts MATCH ?
        AND (f.title != '' OR f.body != '' OR f.server != '' OR f.host != '')
      LIMIT ?
    `).all(match, limit) as Array<{ doc_id: string; ip: string; port: number | null; title: string; snip: string }>
    for (const r of rows) out.push({ month: m, doc_id: r.doc_id, ip: r.ip, port: r.port, title: r.title, snippet: r.snip })
    if (out.length >= limit) break
  }
  return out.slice(0, limit)
}

export interface AggSnapshot {
  queryKey: string
  facet: string
  buckets: Array<{ key: string; doc_count: number }>
}

export function saveAgg(db: Database, s: AggSnapshot): number {
  const now = new Date().toISOString()
  const stmt = db.query(
    'INSERT OR REPLACE INTO aggs (query_key, facet, bucket_key, doc_count, ts) VALUES (?, ?, ?, ?, ?)',
  )
  for (const b of s.buckets) stmt.run(s.queryKey, s.facet, b.key, b.doc_count, now)
  return s.buckets.length
}

/** 数据目录导出用:cache 目录暴露(保持既有 import 兼容) */
export { quakeHCache }
