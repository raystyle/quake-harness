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
    data: z.array(z.unknown()).nullish(),
    meta: z
      .object({
        pagination: z.object({ total: z.number().nullish() }).passthrough().nullish(),
        total: z.object({ value: z.number().nullish() }).passthrough().nullish(),
        pagination_id: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough()

/** 解析列表形响应:缺 data 容错为空数组,meta 形漂移容错为 null(不再 as 断言) */
export function parseListBody(body: unknown): ListBody {
  const parsed = ListEnvelope.safeParse(body)
  if (!parsed.success) {
    // 硬形漂移(非对象/结构崩坏):显式空结果,交给调用方空态处理
    return { items: [], total: null, paginationId: null }
  }
  const { data, meta } = parsed.data
  const total = meta?.pagination?.total ?? meta?.total?.value ?? null
  const paginationId = typeof meta?.pagination_id === 'string' ? meta.pagination_id : null
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
