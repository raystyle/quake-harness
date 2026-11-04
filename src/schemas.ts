import { z } from 'incur'

/**
 * Quake 响应选择性 schema(F04/F03 落地):
 * 只校验消费字段、passthrough 保留原始对象(不全量严格校验大响应,
 * 避免成本与字段丢失)。网络路径与缓存回放共用同一组解析器,
 * 上游/缓存数据形漂移时在此集中报错,而非各命令静默产出默认值。
 */

// ---------------------------------------------------------------------------
// 信封(F03:code/message 类型安全)
// ---------------------------------------------------------------------------

/** 失败信封:code 非零(0 与 '0' 均为成功);message 未知类型,消费侧字符串化 */
const ErrEnvelope = z
  .object({
    code: z.union([z.string(), z.number()]),
    message: z.unknown(),
  })
  .passthrough()

/** 探测响应是否为 Quake 失败信封;是则返回归一化的 {code, message} */
export function detectQuakeError(body: unknown): { code: string | number; message: string } | null {
  if (typeof body !== 'object' || body === null) return null
  const parsed = ErrEnvelope.safeParse(body)
  if (!parsed.success) return null
  const { code, message } = parsed.data
  if (code === 0 || code === '0') return null
  return {
    code,
    message: typeof message === 'string' ? message : String(message ?? ''),
  }
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
