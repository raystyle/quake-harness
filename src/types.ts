/**
 * 品牌类型与领域类型集中地:跨边界流动的标识符在此品牌化,
 * 同形字符串(doc_id/task_id 同为 24 位 hex)交叉污染即刻编译失败。
 * 构造唯一入口 = 伴生守卫(守卫即校验);API 边界进来的裸 string
 * 经守卫窄化后进 Brand 域,域内传递全程受约束。
 */

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

/** 服务文档 id(24 位 hex),QuakeServiceDoc.id / AssetRow.doc_id */
export type DocId = Brand<string, 'DocId'>

/** 主动扫描任务 id(24 位 hex),与 DocId 同形不同义,禁止互传 */
export type TaskId = Brand<string, 'TaskId'>

/** cacheKey() 产物(md5),cache 层与 query_runs 的键 */
export type CacheKey = Brand<string, 'CacheKey'>

/** 月库分桶键 'YYYY-MM',dataMonth() 产物 */
export type Month = Brand<string, 'Month'>

/** DocId 守卫:实测两种形态均为合法 doc id —— 24 位 hex(search 响应)与 ip_port_transport(compare 官方示例) */
export function isDocId(v: string): v is DocId {
  return /^[0-9a-f]{24}$/.test(v) || /^\d{1,3}(\.\d{1,3}){3}_\d+_(tcp|udp)$/.test(v)
}

/** TaskId 守卫:24 位小写 hex(实测 fast_scan 任务 id 形) */
export function isTaskId(v: string): v is TaskId {
  return /^[0-9a-f]{24}$/.test(v)
}

/** CacheKey 守卫:32 位小写 hex(md5) */
export function isCacheKey(v: string): v is CacheKey {
  return /^[0-9a-f]{32}$/.test(v)
}

/** Month 守卫:'YYYY-MM' */
export function isMonth(v: string): v is Month {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(v)
}

// ---------------------------------------------------------------------------
// 闭集:字面量联合
// ---------------------------------------------------------------------------

/** 传输层协议(Quake 文档 transport 字段闭集) */
export type Transport = 'tcp' | 'udp'

/** A 层缓存的 method 键(与命令名解耦:service-search 改名缓存不作废) */
export type RawMethod =
  | 'search' | 'scroll' | 'agg' | 'host_search' | 'host_scroll' | 'host_agg'
  | 'vuln_scroll' | 'cve' | 'icon'
  | `fields_${string}`

// ---------------------------------------------------------------------------
// Quake 原始文档形(L0 契约,来自实测样本;完整字段见 docs/data_contract_review.md)
// ---------------------------------------------------------------------------

/** location 三形文档(服务/主机/漏洞)共用,18 键 */
export interface QuakeLocation {
  country_cn: string
  country_en: string
  country_code: string
  province_cn: string
  province_en: string
  city_cn: string
  city_en: string
  district_cn: string
  district_en: string
  street_cn: string
  street_en: string
  gps: [number, number]
  radius: number
  isp: string
  owner: string
  scene_cn: string
  scene_en: string
}

/** 服务文档(search/scroll 的 data[] 元素) */
export interface QuakeServiceDoc {
  id: string
  ip: string
  port: number
  transport: string
  time: string
  asn?: number
  org?: string
  domain?: string
  /** 双态坑:服务文档 string,主机文档 string[] */
  hostname?: string | string[]
  is_ipv6?: boolean
  location?: QuakeLocation
  service?: {
    name?: string
    version?: string
    response?: string
    response_hash?: string
    dns?: { a?: string[]; support_ipv6?: boolean }
    http?: Record<string, unknown>
  }
  task?: { runtime_id?: string; task_id?: string }
}

/** 主机文档(host-search/host-scroll 的 data[] 元素) */
export interface QuakeHostDoc {
  id: string
  ip: string
  asn?: number
  org?: string
  /** 双态坑:主机文档 hostname 为数组 */
  hostname?: string | string[]
  os_name?: string
  os_version?: string | null
  is_ipv6?: boolean
  location?: QuakeLocation
  time?: string
  services?: Array<{
    port?: number
    name?: string
    transport?: string
    time?: string
  }>
}
