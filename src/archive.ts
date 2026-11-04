import { Database } from 'bun:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { quakeHHome, quakeHCache } from './cache'
import type { DocId, TaskId, Month } from './types'
import { isMonth, isDocId } from './types'

/**
 * B 层归档:按数据时间(年月)分库 + 三时间语义分离(见 src/types.ts TimeAxis)。
 *
 * 三时间一览(每行一个语义,勿混):
 * - data_time:Quake 引擎采集该资产的时刻(文档 time 字段);
 *   time 缺失或非法(Date.parse 不可解析)均回落本地查询时刻,
 *   且 data_time_is_observed=1 打标(可信度降级)
 * - first_seen:本地首次观测(查询到)该资产的时刻,UPSERT 不改
 * - last_seen:本地最近观测时刻,每次重查 UPSERT 推进
 * 分库:assets 落 data_time 对应年月的 YYYY-MM.sqlite;无/非法 time
 * 回落到「查询时刻所在月」,无特殊桶。跨库查询经 export --sql 的
 * ATTACH 自动聚合。query_runs/aggs 是查询行为记录,不随数据分库,恒在 runs 库。
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

/** 数据时间的年月分桶:'2026-11-03T..' -> '2026-11';无/非法时间回落 fallbackNow 所在月 */
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
  // 旧库迁移:runtime_id 列(扫描结果经 task.runtime_id 检索服务索引获取,延迟入库)
  try {
    db.exec("ALTER TABLE scan_tasks ADD COLUMN runtime_id TEXT NOT NULL DEFAULT ''")
  } catch { /* 列已存在 */ }
  return db
}

/** scan 任务登记/刷新 */
export interface ScanTaskRecord {
  taskId: TaskId
  /** 部分更新语义:undefined = 不改该列;仅 scan 提交时必传 */
  target?: string
  portList?: string
  /** 服务端状态原词(scanStatus 联合的列存形);空串 = 不改状态(scan-result 语义) */
  status: string
  /** 部分更新语义:未传时 status 空串场景下保持原值 */
  progress?: number
  /** 扫描批次 id(详情端点 data.runtime_id);扫描产出经 task.runtime_id 检索服务索引,延迟入库 */
  runtimeId?: string
  total?: number | null
  send?: number | null
  success?: number | null
  failed?: number | null
  resultCount?: number | null
}

export function upsertScanTask(db: Database, r: ScanTaskRecord): void {
  const now = new Date().toISOString()
  // status 为空串 = 不改状态(scan-result 只更新结果计数,状态由 scan-status 权威刷新)
  // 部分更新语义:undefined = 不改该列;显式传值(含 null)才覆盖。
  // SQL 层用 COALESCE(excluded.x, scan_tasks.x) 实现:未传的列在 INSERT 侧
  // 填当前值占位,冲突更新时保持不变。status 空串另有「不改状态」语义(scan-result)
  const cur = db.query('SELECT target, port_list, status, progress, total, send, success, failed, result_count, runtime_id FROM scan_tasks WHERE task_id = ?').get(r.taskId) as Record<string, unknown> | null
  const prev = cur ?? {}
  const pick = <T,>(next: T | undefined, key: string): T | null => {
    if (next !== undefined) return next as T | null
    const p = prev[key]
    return (p === undefined || p === null ? null : p) as T | null
  }
  db.query(`
    INSERT INTO scan_tasks (task_id, target, port_list, status, progress, total, send, success, failed, result_count, runtime_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      target = excluded.target,
      port_list = excluded.port_list,
      status = CASE WHEN excluded.status = '' THEN scan_tasks.status ELSE excluded.status END,
      progress = CASE WHEN excluded.status = '' THEN scan_tasks.progress ELSE excluded.progress END,
      total = excluded.total,
      send = excluded.send,
      success = excluded.success,
      failed = excluded.failed,
      result_count = excluded.result_count,
      runtime_id = CASE WHEN excluded.runtime_id = '' THEN scan_tasks.runtime_id ELSE excluded.runtime_id END,
      updated_at = excluded.updated_at
  `).run(
    r.taskId,
    (r.target !== undefined ? r.target : String(prev.target ?? '')),
    (r.portList !== undefined ? r.portList : String(prev.port_list ?? '')),
    r.status,
    (r.progress !== undefined ? r.progress : Number(prev.progress ?? 0)),
    pick(r.total, 'total'), pick(r.send, 'send'), pick(r.success, 'success'),
    pick(r.failed, 'failed'), pick(r.resultCount, 'result_count'),
    r.runtimeId ?? '', now, now,
  )
}

/** 月库缓存:YYYY-MM.sqlite */
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
    .map((f) => f.slice(0, -'.sqlite'.length))
    .filter(isMonth)
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

/** UPSERT 列规则(assets 月库):冲突更新列 = data_time/观测标/last_seen/
 *  raw_json/service_name/hostname/country(随新文档推进);不变列 = doc_id/ip/
 *  port/transport/first_seen(端点身份与首次观测定格);缓存命中跳过归档不推进 */
export function upsertAssets(_runsDb: Database, rows: AssetRow[]): number {
  if (rows.length === 0) return 0
  const now = new Date().toISOString()
  // 自防御:拒收非法 doc_id(空串/异形),避免多条共享主键互相覆盖;
  // 守卫在 toAssetRow 已做一道,这里挡绕过命令层直调的调用方
  const valid = rows.filter((a) => isDocId(a.doc_id as string))
  if (valid.length < rows.length) {
    process.stderr.write(`[archive] 拒收 ${rows.length - valid.length} 条非法 doc_id 文档\n`)
  }
  const byMonth = new Map<Month, AssetRow[]>()
  for (const a of valid) {
    // 数据时间可解析才算真实采集时间;空串/非法串一律回落观测时刻并打标
    // (data_time_is_observed=1),禁止非法串冒充引擎采集时间
    const hasDataTime = Number.isFinite(Date.parse(a.time))
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
        if (rowid !== undefined) ftsUpsert(db, rowid, a.doc_id, a.raw_json)
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
// FTS5 全文索引:独立 FTS 表(非 external content),按 assets.rowid 关联,
// upsertAssets 后同步回填,assets 删行经触发器联动删除
// ---------------------------------------------------------------------------

/** FTS 虚表建表 + 删行同步触发器 */
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

/** raw_json 提取 FTS 文本列;缺失容错为空串。
 *  截断:title 500 / body 8000 / server 200 / host 300 字符:
 *  检索词落在截断尾部会漏检(取舍:控库容;全文在 assets.raw_json 可 SQL 补查) */
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

/** 单行 FTS 写入(UPSERT 后调用;同 rowid 先删后插,幂等)。
 *  doc_id 用 assets 表已窄化值直传,不从 raw_json 重取(避免与主表不一致) */
function ftsUpsert(db: Database, rowid: number | bigint, docId: string, rawJson: string): void {
  const c = ftsColumns(rawJson)
  db.query('DELETE FROM assets_fts WHERE rowid = ?').run(rowid)
  db.query(
    'INSERT INTO assets_fts(rowid, doc_id, title, body, server, host) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(rowid, docId, c.title, c.body, c.server, c.host)
}

/** 存量库回填(建虚表时已入库的行);重跑幂等 */
export function backfillFts(month: Month): number {
  const db = getMonthDb(month)
  const rows = db.query(
    'SELECT a.rowid AS rid, a.doc_id AS did, a.raw_json FROM assets a LEFT JOIN assets_fts f ON f.rowid = a.rowid WHERE f.rowid IS NULL',
  ).all() as Array<{ rid: number; did: string; raw_json: string }>
  const tx = db.transaction((list: typeof rows) => {
    for (const r of list) ftsUpsert(db, r.rid, r.did, r.raw_json)
  })
  tx(rows)
  return rows.length
}

/** 跨月 FTS 检索:按月库升序逐库 MATCH,凑满 limit 即止(非 SQL UNION);
 *  返回行带月标与 snippet 高亮;空文本占位行(FTS 列全空)不返回 */
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
