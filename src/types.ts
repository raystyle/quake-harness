/**
 * 品牌类型与领域类型集中地:跨边界流动的标识符在此品牌化,
 * 同形字符串(doc_id/task_id 同为 24 位 hex)交叉污染即刻编译失败。
 * 构造唯一入口 = 伴生守卫(守卫即校验);API 边界进来的裸 string
 * 经守卫窄化后进 Brand 域,域内传递全程受约束。
 */

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

/** 服务文档 id(Quake 文档身份):24 位 hex 或 host_port_transport 形。
 *  实测:同一 ip:port 不同 vhost 即不同 doc_id(81.70.185.165:8144 有 4 行),
 *  doc_id 是文档去重键,不是资产端点去重键;端点身份用 AssetKey */
export type DocId = Brand<string, 'DocId'>

/** 资产端点业务身份:互联网上的一个服务端点。
 *  统计资产数必须按 (ip,port,transport) 去重,按 doc_id 数会高估 */
export interface AssetKey {
  ip: string
  port: number | null
  transport: Transport
}

/** 主动扫描任务 id(24 位 hex),与 DocId 同形不同义,禁止互传 */
export type TaskId = Brand<string, 'TaskId'>

/** cacheKey() 产物(md5),cache 层与 query_runs 的键 */
export type CacheKey = Brand<string, 'CacheKey'>

/** 月库分桶键 'YYYY-MM',dataMonth() 产物 */
export type Month = Brand<string, 'Month'>

/** DocId 守卫:实测三种合法形态 —— 24 位 hex(search 响应)、ip_port_transport、
 *  host_port_transport(vhost 文档用域名作前缀,如 halifejewelry.com_443_tcp)。
 *  IP 形校验每段 <= 255;host 形走域名标签规则;端口 1-65535 */
export function isDocId(v: string): v is DocId {
  if (/^[0-9a-f]{24}$/.test(v)) return true
  const m = /^(.+)_(\d+)_(tcp|udp)$/.exec(v)
  if (!m) return false
  const port = Number(m[2])
  if (port < 1 || port > 65535) return false
  const host = m[1]!
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    // 纯数字四段按 IPv4 严校验:999.999.999.999 拒
    return host.split('.').every((o) => Number(o) <= 255)
  }
  // 非纯数字:按域名 host 形(含至少一个点,字母数字连字符)
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(host)
}

/** TaskId 守卫:24 位小写 hex(实测 fast_scan 任务 id 形) */
export function isTaskId(v: string): v is TaskId {
  return /^[0-9a-f]{24}$/.test(v)
}

/**
 * 域名(业务输入):标识一个DNS域。
 * 守卫校验纯域名形(RFC 1035 简化:字母数字连字符段 + 点分层级,总长 <= 253)。
 * 该守卫同时是 Quake 语法注入防线——domain 命令以 `domain:*.<输入>` 直拼查询,
 * 传入 `evil.cn OR service:telnet` 这类串会改变查询语义,必须在入口拦截。
 */
export type DomainName = Brand<string, 'DomainName'>

/** 域名守卫:纯域名形校验(同时防查询语法注入) */
export function isDomainName(v: string): v is DomainName {
  if (v.length > 253 || v.length === 0) return false
  const label = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/
  const parts = v.split('.')
  return parts.length >= 2 && parts.every((p) => label.test(p))
}

/** CVE 编号(业务输入):CVE-YYYY-NNNN 形 */
export type CveId = Brand<string, 'CveId'>

/** CVE 守卫:CVE-年份-序号(序号 4 位起,实测库内均为 4+ 位) */
export function isCveId(v: string): v is CveId {
  return /^CVE-\d{4}-\d{4,}$/.test(v)
}

/** favicon md5(业务输入):icon 命令的检索键 */
export type FaviconHash = Brand<string, 'FaviconHash'>

/** favicon md5 守卫:32 位 hex */
export function isFaviconHash(v: string): v is FaviconHash {
  return /^[0-9a-f]{32}$/.test(v)
}

/** IPv4 / CIDR(业务输入):host-honeypot 的 ip 参数 */
export type IpCidr = Brand<string, 'IpCidr'>

/** IPv4 / CIDR 守卫:单 IP 或 /0-/32 前缀 */
export function isIpCidr(v: string): v is IpCidr {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/.exec(v)
  if (!m) return false
  const octets = m[1]!.split('.').map(Number)
  if (!octets.every((o) => o <= 255)) return false
  return m[2] === undefined || Number(m[2]) <= 32
}

/** API size 上限(实测 search/scroll/host 族 API 上限 500;入口守卫防积分事故) */
export const API_SIZE_MAX = 500

/** size 数值域完整校验:正整数且 <= max(z.coerce.number 会放过 -1/0/1.5,单独 > max 检查不完整) */
export function validSize(size: number, max = API_SIZE_MAX): boolean {
  return Number.isInteger(size) && size >= 1 && size <= max
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

// ---------------------------------------------------------------------------
// 三时间语义:数据时间 vs 观测时间,品牌化禁止互串
// ----------------------------------------------------------------------------

/** 数据时间:Quake 引擎采集该资产的时刻(服务文档 time 字段),ISO 8601 */
export type DataTime = Brand<string, 'DataTime'>

/** 观测时间:本地首次/最近查询到该资产的时刻,ISO 8601 */
export type SeenTime = Brand<string, 'SeenTime'>

/**
 * 一条资产在归档库的完整时间轴(assets 表三时间列的类型化投影):
 * - data_time:Quake 采集时刻;is_observed 为 true 时表示文档无 time、
 *   已回落本地查询时刻兜底(数据可信度降一级,分析时须区分)
 * - first_seen / last_seen:本地观测窗(每次查询 UPSERT 推进 last_seen)
 */
export interface TimeAxis {
  data_time: DataTime
  data_time_is_observed: boolean
  first_seen: SeenTime
  last_seen: SeenTime
}

/** fields 命令的数据集闭集(四数据集) */
export type FieldsDataset = 'service' | 'host' | 'service-agg' | 'host-agg'

/** A 层缓存的 method 键(与命令名解耦:service-search 改名缓存不作废) */
export type RawMethod =
  | 'search' | 'scroll' | 'agg' | 'host_search' | 'host_scroll' | 'host_agg'
  | 'vuln_scroll' | 'cve' | 'icon'
  | `fields_${FieldsDataset}`

/** 有 TTL 配置的可缓存方法(TTL_HOURS 穷尽键集;vuln_scroll 不缓存故不在列) */
export type CacheableMethod = 'search' | 'scroll' | 'host_search' | 'host_scroll' | 'agg' | 'host_agg' | 'cve' | 'icon'

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
