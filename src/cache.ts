import { createHash } from 'node:crypto'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import type { CacheKey, RawMethod, CacheableMethod, FieldsDataset } from './types'

/**
 * 平台标准目录解析(gh 模型:XDG + Win AppData;macOS data 走 Application Support,
 * cache 走 Caches,config 走 XDG 或 Application Support)。
 * QUAKEH_HOME 总开关:设置后 config/data/cache 全部落其下子目录(便携/CI)。
 * 旧 ~/.quake-h 自动迁移:首次发现旧目录且新数据目录为空时搬过去。
 */
function platformDir(kind: 'config' | 'data' | 'cache'): string {
  const home = process.env.QUAKEH_HOME
  if (home) return join(home, kind === 'config' ? 'config' : kind === 'data' ? 'data' : 'cache')

  const os = platform()
  if (os === 'win32') {
    // config: %APPDATA%;data/cache: %LOCALAPPDATA%
    const base = kind === 'config' ? process.env.APPDATA : process.env.LOCALAPPDATA
    if (base) return join(base, 'quake-h')
    return join(homedir(), '.quake-h') // 环境变量缺失的兜底
  }
  if (os === 'darwin') {
    // macOS 标准应用数据目录;XDG 变量优先(装了 xdg 路径约定的用户)
    const xdg = kind === 'config' ? process.env.XDG_CONFIG_HOME : kind === 'data' ? process.env.XDG_DATA_HOME : process.env.XDG_CACHE_HOME
    if (xdg) return join(xdg, 'quake-h')
    const as = join(homedir(), 'Library', 'Application Support', 'quake-h')
    return kind === 'cache' ? join(homedir(), 'Library', 'Caches', 'quake-h') : as
  }
  // Linux/其他:完整 XDG
  const xdg =
    kind === 'config' ? process.env.XDG_CONFIG_HOME
    : kind === 'data' ? process.env.XDG_DATA_HOME
    : process.env.XDG_CACHE_HOME
  const base = xdg || (kind === 'config' ? join(homedir(), '.config') : kind === 'data' ? join(homedir(), '.local', 'share') : join(homedir(), '.cache'))
  return join(base, 'quake-h')
}

/**
 * .env 回落候选目录(按序探测):
 * 1. 平台 config 目录(Windows %APPDATA%,macOS Application Support,Linux ~/.config)
 * 2. macOS 兼容 ~/.config(gh 风格旧位置)
 */
function envFallbackDirs(): string[] {
  const dirs = [quakeHConfig()]
  if (platform() === 'darwin') dirs.push(join(homedir(), '.config', 'quake-h'))
  return dirs
}

/** 旧版单点目录(~/.quake-h),迁移探测用 */
function legacyHome(): string {
  return join(homedir(), '.quake-h')
}

let migrated = false
/**
 * 旧目录一次性迁移:数据/缓存搬到新 data/cache。
 * 触发条件:未设 QUAKEH_HOME(便携/测试场景跳过)且旧目录存在,
 * 且新 data 目录尚无 archive.sqlite(以 runs 库主文件为准判空;
 * 月库已存在而 runs 库未建的情形不迁移,视为已初始化)。
 */
function migrateOnce(): void {
  if (migrated) return
  migrated = true
  if (process.env.QUAKEH_HOME) return
  try {
    const legacy = legacyHome()
    const dataDir = platformDir('data')
    const cacheDir = platformDir('cache')
    if (!existsSync(legacy) || legacy === dataDir || legacy === cacheDir) return
    if (existsSync(dataDir) && existsSync(join(dataDir, 'archive.sqlite'))) return // 新库已有数据,不动
    const { cpSync } = require('node:fs') as typeof import('node:fs')
    // 归档库与限流状态进 data;raw 缓存进 cache
    cpSync(join(legacy, 'archive.sqlite'), join(dataDir, 'archive.sqlite'), { recursive: true, force: false, errorOnExist: false })
    if (existsSync(join(legacy, 'ratelimit.json'))) {
      cpSync(join(legacy, 'ratelimit.json'), join(dataDir, 'ratelimit.json'), { force: false, errorOnExist: false })
    }
    if (existsSync(join(legacy, 'raw'))) {
      cpSync(join(legacy, 'raw'), join(cacheDir, 'raw'), { recursive: true, force: false, errorOnExist: false })
    }
    process.stderr.write(`[migrate] 旧目录 ${legacy} 内容已迁移到平台标准目录(原目录保留,确认无误后可手动删除)\n`)
  } catch {
    // 迁移失败不挡启动,继续用新目录
  }
}

/** quake-h 数据目录(runs.sqlite / YYYY-MM 月库 / ratelimit.json) */
export function quakeHHome(): string {
  migrateOnce()
  return platformDir('data')
}

/** quake-h 缓存目录(raw TTL 缓存) */
export function quakeHCache(): string {
  migrateOnce()
  return platformDir('cache')
}

/** quake-h 用户配置目录(.env 回落层 / 未来 config) */
export function quakeHConfig(): string {
  return platformDir('config')
}

/**
 * .env 加载链(业界 dotenv/direnv/gh 惯例):
 * 1. 进程环境变量(最高,bun 自动加载 cwd .env 已并入此层)
 * 2. cwd .env(bun 原生,含 .env.local)
 * 3. 用户配置目录 %APPDATA%/quake-h 或 XDG_CONFIG_HOME/quake-h 下的 .env(回落层)
 * 调用方在进程变量与 cwd 都取不到 Key 时再读本函数。
 */
export function readUserEnvFallback(name: string): string | undefined {
  for (const dir of envFallbackDirs()) {
    const p = join(dir, '.env')
    if (!existsSync(p)) continue
    try {
      const text = readFileSync(p, 'utf-8')
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
        if (m && m[1] === name) return (m[2] ?? '').replace(/^["']|["']$/g, '')
      }
    } catch {}
  }
  return undefined
}

/** 稳定序列化:键排序,保证同参数同 cache_key */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`
}

/** cache 键:sha256 截断 32 hex(碰撞域 128 位,实践安全);唯一构造入口,返回即 CacheKey */
export function cacheKey(method: string, query: string, params: unknown): CacheKey {
  return createHash('sha256').update(`${method}\n${query}\n${stableStringify(params)}`).digest('hex').slice(0, 32) as CacheKey
}

export interface CacheEntry {
  fetched_at: string
  /** 响应原文(Quake 信封 data+meta 之外的完整 body)。
   *  生产者预期形:对象含 code/message/data 三键;缓存层不校验(回放零成本),
   *  形漂移由消费侧 src/schemas.ts 解析器统一容错为空态 */
  body: unknown
}

function rawDir(method: string, date: string): string {
  return join(quakeHCache(), 'raw', method, date)
}

function cachePath(method: string, date: string, key: string): string {
  return join(rawDir(method, date), `${key}.json`)
}

/** 今日日期目录名(UTC) */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * 读缓存:命中且未过期返回原文,否则 null。
 * 只知道 key 不知道日期,扫 raw 下各日期目录找 key.json(目录少,可接受)。
 * ttlHours <= 0 视为永不读缓存(scroll 族游标翻页语义)。
 */
export function readCache(method: RawMethod, key: CacheKey, ttlHours: number): CacheEntry | null {
  if (ttlHours <= 0) return null
  const base = join(quakeHCache(), 'raw', method)
  if (!existsSync(base)) return null
  const { readdirSync } = require('node:fs') as typeof import('node:fs')
  for (const date of readdirSync(base, { withFileTypes: true })) {
    if (!date.isDirectory()) continue
    const p = join(base, date.name, `${key}.json`)
    if (!existsSync(p)) continue
    try {
      const entry = JSON.parse(readFileSync(p, 'utf-8')) as CacheEntry
      const ageH = (Date.now() - Date.parse(entry.fetched_at)) / 3_600_000
      return ageH <= ttlHours ? entry : null
    } catch {
      return null
    }
  }
  return null
}

/** 原样落盘:raw/{method}/{yyyy-mm-dd}/{cache_key}.json,返回落盘路径 */
export function writeRaw(method: string, key: string, body: unknown): string {
  const date = today()
  const entry: CacheEntry = { fetched_at: new Date().toISOString(), body }
  const dir = rawDir(method, date)
  mkdirSync(dir, { recursive: true })
  const p = cachePath(method, date, key)
  writeFileSync(p, JSON.stringify(entry, null, 1), 'utf-8')
  return p
}

/** TTL 默认值(小时):search 短保新鲜,agg/字段面中,cve 长(漏洞库变更慢);scroll 族游标翻页不缓存。
 *  satisfies Record<CacheableMethod, number>:新增可缓存方法漏配 TTL 即编译失败(穷尽性闭合) */
export const TTL_HOURS = {
  search: 24,
  scroll: 0,
  host_search: 24,
  host_scroll: 0,
  agg: 168,
  host_agg: 168,
  cve: 720,
  icon: 168,
} as const satisfies Record<CacheableMethod, number>
