import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'

/**
 * 自适应限流状态机:跨进程持久化在 QUAKEH_HOME/ratelimit.json。
 *
 * AIMD(Additive Increase / Multiplicative Decrease)自适应:
 * - 状态文件记住当前节奏(每两次调用最小间隔 minIntervalMs)
 * - 连续成功:间隔线性收紧 200ms/次(加速),不低于下限 800ms
 * - q3005 限流:新间隔 = 当前间隔 * 2^n(n 为连续撞墙次数,指数退避)
 *   + 30s 静默期;上限 5 分钟
 * - 调用前若距上次不足当前间隔,自动 sleep 到点再发,调用方无感知
 * - 并发边界:状态写为原子替换(临时文件+rename,防读到半文件),
 *   但 read-modify-write 与 acquire 占位无跨进程互斥,并发进程可能
 * 丢更新或同时占位(实践可接受:后果只是节奏短暂不准,不致超发)
 *
 * 下限 800ms 由服务端实测推出:约 20 次/分钟以内未见 q3005
 * (对应最小间隔 3s = 60/20;收紧到 800ms 是试探后的激进下限)。
 */

const INIT_MS = 3_000
const MIN_MS = 800
const MAX_MS = 300_000
/** 每次成功,间隔减多少(线性加速步长) */
const STEP_DOWN_MS = 200
/** q3005 时,静默多久再允许下一次尝试 */
const COOLDOWN_MS = 30_000

export interface RateLimitState {
  /** 当前最小调用间隔(ms) */
  minIntervalMs: number
  /** 上次网络调用时刻(ms);0 = 从未 */
  lastCallAt: number
  /** 静默期截止时刻(ms);0 = 无 */
  cooldownUntil: number
  /** 连续 q3005 次数(指数退避系数) */
  consecutiveLimited: number
  /** 连续成功次数(观察用) */
  consecutiveOk: number
  /** 统计:累计调用与累计 q3005 */
  totalCalls: number
  totalLimited: number
  /** 节奏上次更新时刻 */
  updatedAt: string
}

function defaults(): RateLimitState {
  return {
    minIntervalMs: INIT_MS,
    lastCallAt: 0,
    cooldownUntil: 0,
    consecutiveLimited: 0,
    consecutiveOk: 0,
    totalCalls: 0,
    totalLimited: 0,
    updatedAt: new Date().toISOString(),
  }
}

function statePath(): string {
  // 数据目录与归档库同层(平台标准 data 目录;QUAKEH_HOME 总开关经 quakeHHome 生效)
  const { quakeHHome } = require('./cache') as typeof import('./cache')
  return join(quakeHHome(), 'ratelimit.json')
}

export function readState(): RateLimitState {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf-8')) as Partial<RateLimitState>
    const d = defaults()
    return {
      // 逐字段校验:数值域 finite/非负才收,损坏或手改文件逐项回落默认
      // (minIntervalMs 另受 clamp 域约束;lastCallAt/cooldownUntil 为 epoch ms 非负)
      minIntervalMs: clamp(numberOr(raw.minIntervalMs, d.minIntervalMs)),
      lastCallAt: nonNegIntOr(raw.lastCallAt, d.lastCallAt),
      cooldownUntil: nonNegIntOr(raw.cooldownUntil, d.cooldownUntil),
      consecutiveLimited: nonNegIntOr(raw.consecutiveLimited, d.consecutiveLimited),
      consecutiveOk: nonNegIntOr(raw.consecutiveOk, d.consecutiveOk),
      totalCalls: nonNegIntOr(raw.totalCalls, d.totalCalls),
      totalLimited: nonNegIntOr(raw.totalLimited, d.totalLimited),
      updatedAt: typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt))
        ? raw.updatedAt
        : d.updatedAt,
    }
  } catch {
    return defaults()
  }
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function nonNegIntOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : fallback
}

function clamp(v: number): number {
  return Math.min(MAX_MS, Math.max(MIN_MS, v))
}

/** 原子写:临时文件 + rename,并发进程不读半截 */
function writeState(s: RateLimitState): void {
  const p = statePath()
  mkdirSync(join(p, '..'), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(s, null, 1), 'utf-8')
  renameSync(tmp, p)
}

function touch(s: RateLimitState): RateLimitState {
  return { ...s, updatedAt: new Date().toISOString() }
}

/**
 * 自适应闸门:调用前问一次。
 * - 静默期内:返回需等待的毫秒数(调用方 sleep 后重问,或直接拒)
 * - 距上次调用不足当前间隔:同上(窗口等待)
 * - 到点:立即占位(记 lastCallAt 并持久化),返回 0
 * 返回 0 表示已获得发射权(已扣本次调用),>0 表示需等待的毫秒数。
 */
export function acquire(): { waitMs: number; reason: 'cooldown' | 'interval' | null } {
  const now = Date.now()
  const s = readState()

  if (s.cooldownUntil > now) {
    return { waitMs: s.cooldownUntil - now, reason: 'cooldown' }
  }

  const since = now - s.lastCallAt
  if (s.lastCallAt > 0 && since < s.minIntervalMs) {
    return { waitMs: s.minIntervalMs - since, reason: 'interval' }
  }

  writeState(touch({ ...s, lastCallAt: now, totalCalls: s.totalCalls + 1 }))
  return { waitMs: 0, reason: null }
}

/** 网络成功后上报:线性加速(间隔收紧) */
export function reportOk(): void {
  const s = readState()
  writeState(
    touch({
      ...s,
      minIntervalMs: clamp(s.minIntervalMs - STEP_DOWN_MS),
      consecutiveOk: s.consecutiveOk + 1,
      consecutiveLimited: 0,
    }),
  )
}

/** q3005 后上报:指数减速 + 静默期 */
export function reportLimited(): void {
  const s = readState()
  const n = s.consecutiveLimited + 1
  // 间隔翻倍(按连续撞墙次数指数),另加 30s 静默
  writeState(
    touch({
      ...s,
      minIntervalMs: clamp(s.minIntervalMs * 2 ** n),
      consecutiveLimited: n,
      consecutiveOk: 0,
      totalLimited: s.totalLimited + 1,
      cooldownUntil: Date.now() + COOLDOWN_MS,
    }),
  )
}

/** 节奏概览(不占额度) */
export function peek(): {
  minIntervalMs: number
  lastCallAt: number
  cooldownActive: boolean
  cooldownRemainMs: number
  consecutiveLimited: number
  consecutiveOk: number
  totalCalls: number
  totalLimited: number
} {
  const s = readState()
  const now = Date.now()
  return {
    minIntervalMs: s.minIntervalMs,
    lastCallAt: s.lastCallAt,
    cooldownActive: s.cooldownUntil > now,
    cooldownRemainMs: Math.max(0, s.cooldownUntil - now),
    consecutiveLimited: s.consecutiveLimited,
    consecutiveOk: s.consecutiveOk,
    totalCalls: s.totalCalls,
    totalLimited: s.totalLimited,
  }
}

/** 节奏复位(测试与 rate --reset) */
export function resetState(): void {
  writeState(defaults())
}

export const LIMITS = { INIT_MS, MIN_MS, MAX_MS, STEP_DOWN_MS, COOLDOWN_MS } as const
