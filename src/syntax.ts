/**
 * Quake 检索语法字段注册表(来自官方第 2 章查询语句文档)。
 * 供 `quake-h syntax <keyword>` 离线检索;原文档全量存 docs/quake_query_syntax.md。
 */
export interface SyntaxEntry {
  field: string
  name: string
  scope: '主机' | '服务' | 'both' | 'http' | string
  example: string
}

export interface SyntaxSection {
  section: string
  entries: SyntaxEntry[]
}

export const SECTIONS: SyntaxSection[] = [
  {
    section: '基础',
    entries: [
      { field: 'ip', name: 'IP 地址及网段(单 IP/CIDR/IPv6)', scope: 'both', example: 'ip:"1.1.1.1/16"' },
      { field: 'is_ipv6', name: 'IPv6 资产(true/false)', scope: 'both', example: 'is_ipv6:"true"' },
      { field: 'is_latest', name: '最新资产(仅 true/false)', scope: '服务', example: 'is_latest:"true"' },
      { field: 'port', name: '开放端口(支持范围)', scope: 'both', example: 'port:[80 TO 1024]' },
      { field: 'ports', name: '同时开放过的多端口(逗号)', scope: '主机', example: 'ports:"80,8080,8000"' },
      { field: 'transport', name: '传输层协议(tcp/udp)', scope: 'both', example: 'transport:"udp"' },
    ],
  },
  {
    section: 'ASN',
    entries: [
      { field: 'asn', name: '自治域号码', scope: 'both', example: 'asn:"12345"' },
      { field: 'org', name: '自治域归属组织', scope: 'both', example: 'org:"No.31,Jin-rong Street"' },
    ],
  },
  {
    section: '主机名与系统',
    entries: [
      { field: 'hostname', name: '主机名(rDNS)', scope: '服务', example: 'hostname:"50-87-74-222.unifiedlayer.com"' },
      { field: 'domain', name: '网站域名(支持通配)', scope: '服务', example: 'domain:*.360.cn' },
      { field: 'os', name: '操作系统+版本', scope: '服务', example: 'os:"Windows"' },
    ],
  },
  {
    section: '服务',
    entries: [
      { field: 'service', name: '应用协议名称', scope: 'both', example: 'service:"http"' },
      { field: 'services', name: '同时支持的多个协议(逗号)', scope: '主机', example: 'services:"rtsp,https,telnet"' },
      { field: 'app', name: '指纹识别产品名', scope: 'both', example: 'app:"Apache"' },
      { field: 'app_version', name: '产品版本', scope: 'both', example: 'app_version:"1.2.1"' },
      { field: 'response', name: '端口原始响应(信息最丰富)', scope: '服务', example: 'response:"220 ProFTPD 1.3.5a Server"' },
      { field: 'cert', name: 'SSL/TLS 证书信息', scope: 'both', example: 'cert:"360.cn"' },
    ],
  },
  {
    section: '精细化应用识别',
    entries: [
      { field: 'catalog', name: '应用类别聚合', scope: '服务', example: 'catalog:"IoT物联网"' },
      { field: 'type', name: '应用类型', scope: '服务', example: 'type:"防火墙"' },
      { field: 'level', name: '应用层级(5 级)', scope: '服务', example: 'level:"硬件设备层"' },
      { field: 'vendor', name: '应用生产厂商', scope: '服务', example: 'vendor:"Sangfor深信服科技股份有限公司"' },
    ],
  },
  {
    section: 'IP 归属定位',
    entries: [
      { field: 'country', name: '国家英文/代码', scope: 'both', example: 'country:"CN"' },
      { field: 'country_cn', name: '国家中文', scope: 'both', example: 'country_cn:"中国"' },
      { field: 'province', name: '省份英文', scope: 'both', example: 'province:"Sichuan"' },
      { field: 'province_cn', name: '省份中文', scope: 'both', example: 'province_cn:"四川"' },
      { field: 'city', name: '城市英文', scope: 'both', example: 'city:"Chengdu"' },
      { field: 'city_cn', name: '城市中文', scope: 'both', example: 'city_cn:"成都"' },
      { field: 'district', name: '区县中文', scope: '服务', example: 'district:"朝阳区"' },
      { field: 'owner', name: 'IP 归属单位(不精确)', scope: 'both', example: 'owner:"清华大学"' },
      { field: 'isp', name: '运营商', scope: 'both', example: 'isp:"联通"' },
    ],
  },
  {
    section: '图像与场景',
    entries: [
      { field: 'img_tag', name: '图片标签', scope: '服务', example: 'img_tag:"webcam"' },
      { field: 'img_ocr', name: '图片 OCR', scope: '服务', example: 'img_ocr:"admin"' },
      { field: 'sys_tag', name: '资产场景标签', scope: '服务', example: 'sys_tag:"卫星互联网"' },
    ],
  },
  {
    section: 'http',
    entries: [
      { field: 'status_code', name: 'http 状态码', scope: 'http', example: 'status_code:200' },
      { field: 'http_path', name: '请求路径', scope: 'http', example: 'http_path:"/admin"' },
      { field: 'title', name: '网页标题', scope: 'http', example: 'title:"后台"' },
      { field: 'meta_keywords', name: '网页关键字', scope: 'http', example: 'meta_keywords:"网络安全"' },
      { field: 'server', name: 'Web 服务器名(Server 头)', scope: 'http', example: 'server:Nginx' },
      { field: 'service.http.server.keyword', name: 'Web 服务器名精确查找', scope: 'http', example: 'service.http.server.keyword:"Apache/2.4.29"' },
      { field: 'x_powered_by', name: '开发语言(X-Powered-By)', scope: 'http', example: 'x_powered_by:PHP' },
      { field: 'favicon', name: 'favicon md5', scope: 'http', example: 'favicon:"0488faca4c19046b94d07c3ee83cf9d6"' },
      { field: 'host', name: '请求 host 值', scope: 'http', example: 'host:"google.com"' },
      { field: 'html_hash', name: '网页 html md5', scope: 'http', example: 'html_hash:"69d7683445fed9e517e33750615f46c0"' },
      { field: 'headers', name: 'http headers 字符串', scope: 'http', example: 'headers:"ThinkPHP"' },
      { field: 'header_order_hash', name: '头部 key 序 md5', scope: 'http', example: 'header_order_hash:"42997ea42eb46037ecb1e514e8190b93"' },
      { field: 'body', name: '网页 body 内容', scope: 'http', example: 'body:"奇虎"' },
      { field: 'robots', name: 'robots.txt 内容', scope: 'http', example: 'robots:"Discuz"' },
      { field: 'robots_hash', name: 'robots.txt md5', scope: 'http', example: 'robots_hash:"e4c3bfe695710c5610cf51723b3bdae2"' },
      { field: 'sitemap', name: 'sitemap.xml 内容', scope: 'http', example: 'sitemap:"archive"' },
      { field: 'sitemap_hash', name: 'sitemap.xml md5', scope: 'http', example: 'sitemap_hash:10f3aa0c1bd43f07ef8ed178d8b97df1' },
      { field: 'cookie_simhash', name: 'cookie key simhash', scope: 'http', example: 'cookie_simhash:"16149686953955343636"' },
      { field: 'cookie_order_hash', name: 'cookie key 序 md5', scope: 'http', example: 'cookie_order_hash:"6ccfd3351761d2ac11b0963d916197e0"' },
      { field: 'dom_tree.simhash', name: 'DOM 树 simhash', scope: 'http', example: 'dom_simhash:"13136671156032164472"' },
      { field: 'dom_tree.key', name: 'DOM 元素集合', scope: 'http', example: 'dom_node:"html,head,body"' },
      { field: 'dom_tree.dom_hash', name: 'DOM 元素哈希', scope: 'http', example: 'dom_hash:"38d8daf979e511dfe3a421abe4f36561"' },
      { field: 'script_function', name: 'script 函数名', scope: 'http', example: 'script_function:"func1"' },
      { field: 'script_variable', name: 'script 变量名', scope: 'http', example: 'script_variable:"csrfToken"' },
      { field: 'css_class', name: 'css class 值', scope: 'http', example: 'css_class:"center"' },
      { field: 'css_id', name: 'css id 值', scope: 'http', example: 'css_id:"login"' },
      { field: 'url_load', name: 'HTTP 加载流(无静态资源)', scope: 'http', example: 'url_load:"/bim/"' },
      { field: 'icp', name: 'ICP 备案号', scope: 'http', example: 'icp:"京ICP备08010314号"' },
      { field: 'copyright', name: '版权许可', scope: 'http', example: 'copyright:"360-CERT"' },
      { field: 'mail', name: '邮箱地址', scope: 'http', example: 'mail:"@163.com"' },
      { field: 'page_type', name: '页面类型', scope: 'http', example: 'page_type:"登录页"' },
      { field: 'iframe_url', name: 'iframe 链接', scope: 'http', example: 'iframe_url:"https://open.work.weixin.qq.com/"' },
      { field: 'iframe_hash', name: 'iframe 内容 md5', scope: 'http', example: 'iframe_hash:"8c82d234e800eecbc2ff092905059cc3"' },
      { field: 'iframe_title', name: 'iframe 标题', scope: 'http', example: 'iframe_title:"企业微信登录"' },
      { field: 'iframe_keywords', name: 'iframe 关键字', scope: 'http', example: 'iframe_keywords:"电力能源"' },
      { field: 'domain_is_wildcard', name: '是否存在泛解析域名', scope: 'http', example: 'domain_is_wildcard:true' },
      { field: 'is_domain', name: '是否存在域名', scope: 'http', example: 'is_domain:true' },
      { field: 'icp_nature', name: '备案主体性质', scope: 'http', example: 'icp_nature:"企业"' },
      { field: 'icp_keywords', name: '备案关键词或域名', scope: 'http', example: 'icp_keywords:"奇虎"' },
      { field: '_exists_:service.http.icp', name: '字段存在性', scope: 'http', example: '_exists_:service.http.icp' },
    ],
  },
  {
    section: 'ftp',
    entries: [
      { field: 'service.ftp.is_anonymous', name: '是否可匿名登录', scope: '服务', example: 'service.ftp.is_anonymous:true' },
    ],
  },
  {
    section: 'rsync',
    entries: [
      { field: 'service.rsync.authentication', name: '是否开启权限验证', scope: '服务', example: 'service.rsync.authentication:false' },
    ],
  },
  {
    section: 'ssh',
    entries: [
      { field: 'service.ssh.server_keys.type', name: '加密类型', scope: '服务', example: 'service.ssh.server_keys.type:"ssh-rsa"' },
      { field: 'service.ssh.server_keys.fingerprint', name: 'host_key 指纹', scope: '服务', example: 'service.ssh.server_keys.fingerprint:"3c:14:84:40:..."' },
      { field: 'service.ssh.ciphers', name: '允许的加密算法', scope: '服务', example: 'service.ssh.ciphers:"aes128-ctr"' },
      { field: 'service.ssh.kex', name: '密钥交换算法', scope: '服务', example: 'service.ssh.kex:"ecdh-sha2-nistp256"' },
      { field: 'service.ssh.digests', name: '摘要算法', scope: '服务', example: 'service.ssh.digests:"hmac-sha2-256"' },
      { field: 'service.ssh.key_types', name: '公钥算法类型', scope: '服务', example: 'service.ssh.key_types:"ssh-rsa"' },
      { field: 'service.ssh.compression', name: '压缩算法', scope: '服务', example: 'service.ssh.compression:"zlib"' },
    ],
  },
  {
    section: 'upnp',
    entries: [
      { field: 'service.upnp.friendlyName', name: '友好设备名', scope: '服务', example: 'service.upnp.friendlyName:"RX SR-DBU"' },
      { field: 'service.upnp.manufacturer', name: '制造商', scope: '服务', example: 'service.upnp.manufacturer:"D-LINK"' },
      { field: 'service.upnp.modelName', name: '模块名称', scope: '服务', example: 'service.upnp.modelName:"WRC"' },
      { field: 'service.upnp.modelNumber', name: '模块型号', scope: '服务', example: 'service.upnp.modelNumber:"EV"' },
    ],
  },
  {
    section: 'snmp',
    entries: [
      { field: 'service.snmp.sysname', name: '系统名/主机名', scope: '服务', example: 'service.snmp.sysname:"CableHome"' },
      { field: 'service.snmp.sysdesc', name: '设备描述', scope: '服务', example: 'service.snmp.sysdesc:"TC7200"' },
      { field: 'service.snmp.syslocation', name: '设备位置', scope: '服务', example: 'service.snmp.syslocation:"HUMAX"' },
      { field: 'service.snmp.syscontact', name: '管理联系人', scope: '服务', example: 'service.snmp.syscontact:"SNMPv2"' },
      { field: 'service.snmp.sysobjectid', name: '设备标识 OID', scope: '服务', example: 'service.snmp.sysobjectid:"1.3.6.1.4.1.8072.3.2.10"' },
    ],
  },
  {
    section: 'docker',
    entries: [
      { field: 'service.docker.containers.Image', name: '镜像名', scope: '服务', example: 'service.docker.containers.Image:"ubuntu"' },
      { field: 'service.docker.containers.Command', name: '启动命令', scope: '服务', example: 'service.docker.containers.Command:"wget"' },
      { field: 'service.docker.version.Version', name: 'docker 版本', scope: '服务', example: 'service.docker.version.Version:"19.03.1"' },
      { field: 'service.docker.version.Arch', name: '服务器架构', scope: '服务', example: 'service.docker.version.Arch:"arm"' },
      { field: 'service.docker.version.KernelVersion', name: '内核版本', scope: '服务', example: 'service.docker.version.KernelVersion:"3.10.70"' },
    ],
  },
  {
    section: 'dns',
    entries: [
      { field: 'service.domain.id_server', name: 'dns 服务器标识', scope: '服务', example: 'service.domain.id_server:"pdns"' },
      { field: 'service.domain.version_bind', name: 'dns 版本信息', scope: '服务', example: 'service.domain.version_bind:"Freenom"' },
    ],
  },
  {
    section: 'elastic',
    entries: [
      { field: 'service.elastic.indices.health', name: '健康状态', scope: '服务', example: 'service.elastic.indices.health:"green"' },
      { field: 'service.elastic.indices.index', name: '索引名', scope: '服务', example: 'service.elastic.indices.index:"user"' },
      { field: 'service.elastic.indices.docs_count', name: '文档数量', scope: '服务', example: 'service.elastic.indices.docs_count:"993"' },
    ],
  },
  {
    section: 'mongodb',
    entries: [
      { field: 'service.mongodb.authentication', name: '是否开启授权', scope: '服务', example: 'service.mongodb.authentication:false' },
      { field: 'service.mongodb.buildInfo.version', name: 'mongo 版本', scope: '服务', example: 'service.mongodb.buildInfo.version:"4.0.6"' },
      { field: 'service.mongodb.listDatabases.databases.name', name: '数据库名', scope: '服务', example: 'service.mongodb.listDatabases.databases.name:"admin"' },
    ],
  },
  {
    section: 'ethernetip',
    entries: [
      { field: 'service.ethernetip.product_name', name: '产品名', scope: '服务', example: 'service.ethernetip.product_name:1763-L16BWA' },
      { field: 'service.ethernetip.device_ip', name: '设备 IP', scope: '服务', example: 'service.ethernetip.device_ip:"192.168.1.10"' },
      { field: 'service.ethernetip.vendor', name: '制造商', scope: '服务', example: 'service.ethernetip.vendor:"Rockwell Automation"' },
    ],
  },
  {
    section: 'modbus',
    entries: [
      { field: 'service.modbus.UnitId', name: '单元 id', scope: '服务', example: 'service.modbus.UnitId:1' },
      { field: 'service.modbus.DeviceIdentification', name: '设备信息', scope: '服务', example: 'service.modbus.DeviceIdentification:"Schneider Electric"' },
      { field: 'service.modbus.CpuModule', name: 'CPU 型号', scope: '服务', example: 'service.modbus.CpuModule:"BMX"' },
    ],
  },
  {
    section: 's7',
    entries: [
      { field: 'service.s7.Module', name: '模块', scope: '服务', example: 'service.s7.Module:"6ES7"' },
      { field: 'service.s7.Basic_Firmware', name: '固件信息', scope: '服务', example: 'service.s7.Basic_Firmware:"6ES7"' },
      { field: 'service.s7.Name_of_the_PLC', name: 'PLC 名称', scope: '服务', example: 'service.s7.Name_of_the_PLC:"E40"' },
    ],
  },
  {
    section: 'smb',
    entries: [
      { field: 'service.smb.ServerDefaultDialect', name: '默认 SMB 版本', scope: '服务', example: 'service.smb.ServerDefaultDialect:"SMB 3.0"' },
      { field: 'service.smb.ListDialects', name: '支持的 SMB 版本', scope: '服务', example: 'service.smb.ListDialects:"SMB 3.1.1"' },
      { field: 'service.smb.Authentication', name: '认证开启情况', scope: '服务', example: 'service.smb.Authentication:disabled' },
      { field: 'service.smb.ServerOS', name: '操作系统版本', scope: '服务', example: 'service.smb.ServerOS:"Windows 6.1"' },
      { field: 'service.smb.listShares.Name', name: 'Shares 信息', scope: '服务', example: 'service.smb.listShares.Name:"USERS"' },
    ],
  },
  {
    section: 'tls',
    entries: [
      { field: 'tls_SAN', name: '主体可选名称', scope: 'both', example: 'tls_SAN:"baidu.com"' },
      { field: 'tls_md5', name: '证书哈希 md5', scope: 'both', example: 'tls_md5:"539b071cf7d2f02b1c85cc09da1186e5"' },
      { field: 'tls_sha256', name: '证书哈希 sha256', scope: 'both', example: 'tls_sha256:"2ed189349f818f34..."' },
      { field: 'tls_SPKI', name: '公钥哈希 sha256', scope: 'both', example: 'tls_SPKI:"ff9e7ca5dd58e557..."' },
      { field: 'tls_SN', name: '证书序列号', scope: 'both', example: 'tls_SN:"3225221634349659..."' },
      { field: 'tls_issuer_CN', name: '签发者通用名', scope: 'both', example: 'tls_issuer_CN:"OV SSL"' },
      { field: 'tls_issuer_O', name: '签发者组织', scope: 'both', example: 'tls_issuer_O:"GlobalSign"' },
      { field: 'tls_subject_CN', name: '主体通用名', scope: 'both', example: 'tls_subject_CN:"baidu.com"' },
      { field: 'tls_subject_O', name: '主体组织', scope: 'both', example: 'tls_subject_O:"GlobalSign"' },
      { field: 'tls_server_version', name: '服务端协议版本', scope: 'both', example: 'tls_server_version:"TLSv1.2"' },
      { field: 'browser_trusted', name: '证书是否可信', scope: 'both', example: 'browser_trusted:true' },
    ],
  },
]

/** 逻辑运算与分词规则要点 */
export const OPERATORS = [
  'AND / OR / NOT 组合:port: 3389 AND country:"China" AND NOT province_cn:"广东"',
  '括号分组:port: 3389 AND (country:"China" OR country: "United States")',
  '端口范围:port:[80 TO 1024]、port:[* TO 80]、port:[80 TO *]',
  '中文与含空格串必须用英文双引号包裹(否则被分词):response:"奇虎科技"',
  '默认输入与端口响应(response)内容匹配',
]
