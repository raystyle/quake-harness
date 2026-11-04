import { z } from 'incur'

/**
 * Quake 响应选择性 schema:只校验消费字段、passthrough 保留原始对象。
 * 失败语义是「容错回落空态」不是报错:
 * - parseEnvelope:信封判别联合;非对象/缺 code 视为 ok 透传(compare 等端点依赖此行为)
 * - parseListBody:硬形漂移(data 非数组/非对象)返回空 items + null total,
 *   与「查询真无结果」同形(取舍:不静默崩溃;调用方如需区分,查 cache 的 raw_path)
 * - parseAggBody:data 缺失或非 facet map 返回空对象
 * meta 只约束存在性,total 三形(pagination.total 数值/total 裸数值/total.value)
 * 统一取值;meta 漂移不连坐 data。
 */

// ---------------------------------------------------------------------------
// 信封:判别联合(F03 类型安全 + 消费侧 switch 穷尽)
// ---------------------------------------------------------------------------

/** 失败信封:code 非零(0 与 '0' 均为成功);message 未知类型,消费侧字符串化 */
const ErrEnvelope = z
  .object({
    code: z.union([z.string(), z.number()]),
    message: z.unknown(),
  })
  .passthrough()

/** Quake 信封判别联合:成功返原 body(数据形各异不锁),失败返归一化错误 */
export type QuakeEnvelope =
  | { kind: 'ok'; body: Record<string, unknown> }
  | { kind: 'err'; code: string; message: string }

/** 解析信封为判别联合。fail-open 范围(明示):非对象(null/字符串/数组)或
 *  缺 code 键的对象,一律归一为 {kind:'ok'; body:{}}(非透传原文,是空对象),
 *  compare 等透传端点依赖此行为;有 code 且非 0/'0' 才判 err */
export function parseEnvelope(body: unknown): QuakeEnvelope {
  if (typeof body !== 'object' || body === null) return { kind: 'ok', body: {} }
  const parsed = ErrEnvelope.safeParse(body)
  if (!parsed.success) return { kind: 'ok', body: body as Record<string, unknown> }
  const { code, message } = parsed.data
  if (code === 0 || code === '0') return { kind: 'ok', body: body as Record<string, unknown> }
  return {
    kind: 'err',
    code: String(code),
    message: typeof message === 'string' ? message : String(message ?? ''),
  }
}

/** 探测响应是否为 Quake 失败信封;是则返回归一化的 {code, message}(parseEnvelope 的 err 判别便捷形) */
export function detectQuakeError(body: unknown): { code: string; message: string } | null {
  const env = parseEnvelope(body)
  return env.kind === 'err' ? { code: env.code, message: env.message } : null
}

// ---------------------------------------------------------------------------
// 列表形响应(search/scroll/host 族/vuln-scroll 共用)
// ---------------------------------------------------------------------------

export interface ListBody {
  items: unknown[]
  /** search 族:meta.pagination.total;scroll 族:meta.total.value */
  total: number | null
  /** scroll 族游标(meta.pagination_id);search 族为 null */
  paginationId: string | null
}

const ListEnvelope = z
  .object({
    // data 只约束数组性;meta 形宽容错(实测三形并存:
    // search 族 pagination.total / scroll 族 {value} 或裸数值 total,
    // 收敛到下面 extract 统一取值,meta 漂移不连坐 items)
    data: z.array(z.unknown()).nullish(),
    meta: z.unknown().nullish(),
  })
  .passthrough()

/** 解析列表形响应:缺 data 容错为空数组;meta 三形 total 统一取值 */
export function parseListBody(body: unknown): ListBody {
  const parsed = ListEnvelope.safeParse(body)
  if (!parsed.success) {
    // 硬形漂移(非对象/data 非数组):显式空结果,交给调用方空态处理
    return { items: [], total: null, paginationId: null }
  }
  const { data, meta } = parsed.data
  const m = (meta ?? {}) as Record<string, unknown>
  const pag = (m.pagination ?? {}) as Record<string, unknown>
  const t = m.total
  const total =
    typeof pag.total === 'number' ? pag.total
    : typeof t === 'number' ? t
    : t !== null && typeof t === 'object' && typeof (t as Record<string, unknown>).value === 'number'
      ? (t as Record<string, unknown>).value as number
      : null
  const paginationId = typeof m.pagination_id === 'string' ? m.pagination_id : null
  return { items: data ?? [], total, paginationId }
}

// ---------------------------------------------------------------------------
// 聚合形响应(agg/host-agg 共用)
// ---------------------------------------------------------------------------

const AggEnvelope = z
  .object({
    data: z.record(z.string(), z.array(z.object({ key: z.unknown(), doc_count: z.number() }))).nullish(),
  })
  .passthrough()

export type AggBuckets = Record<string, Array<{ key: string; doc_count: number }>>

/** 解析聚合形响应:facet -> buckets;缺 data 容错为空对象 */
export function parseAggBody(body: unknown): AggBuckets {
  const parsed = AggEnvelope.safeParse(body)
  if (!parsed.success) return {}
  return (parsed.data.data as AggBuckets) ?? {}
}
