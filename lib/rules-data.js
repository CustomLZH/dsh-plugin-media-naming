/**
 * 通用解析素材：正则与状态常量。
 *
 * 这里只保留**与具体媒体库无关**的东西。片名清洗标签、目标目录映射、
 * 排除目录、视频扩展名、路径模板全部属于**规则包**
 * （`rules/<pack>/rules.json`），可由使用者替换或扩展，代码不预设。
 */

/** Windows 非法字符（半角冒号单独处理，转全角以免破坏片名语义）。 */
export const ILLEGAL_CHARS = '<>"\\|?*'

/** 站点广告 / 网址 / 发布页。
 *
 * 这里只放**泛化的广告措辞**（"发布页"、"云盘下载" 之类），不含任何具体站点名——
 * 具体站点请在你自己的规则包里通过 `cleanup.siteAds` 追加，避免把第三方站名带进仓库。
 */
export const SITE_URL_RE = /www\.[\w.-]+|https?:\/\/[\w./-]+/gi
export const SITE_AD_RE = /地址发布页|发布页|收藏不迷路|欢迎收藏|云盘下载|百度云盘|百度网盘|网盘下载|更多剧集|更多电影/gi

/** 年份：排除后跟数字或 s 的情况（如英文片名里的 1970s）。 */
export const YEAR_RE = /(?<!\d)(?:19|20)\d{2}(?![\ds])/g

/** 季集与各类集数写法（跨语言通用：SxxExx / 第X集 / 第X话 / 纯数字）。 */
export const S_E_RE = /[Ss]\s*(\d{1,2})\s*[Ee]\s*(\d{1,3})/g
export const E_RE = /(?<![A-Za-z0-9])[Ee](\d{1,3})(?!\d)/g
export const EP_RE = /(?<![A-Za-z0-9])[Ee][Pp](\d{1,3})(?!\d)/g
export const CN_EP_RE = /第\s*(\d{1,3})\s*集/g
export const NUM_CN_EP_RE = /(?<![第全共\d])(\d{1,3})\s*集/g
export const CN_EP_HUA_RE = /第\s*(\d{1,3})\s*[话回]/g
export const PAREN_EP_RE = /[(（]\s*(\d{1,3})\s*[)）]/g
export const BRACKET_EP_RE = /[[【](\d{1,3})[\]】]/g
export const LEADING_NUM_EP_RE = /^\s*(\d{1,3})(?=[\s._-]|$)/
export const P_EP_RE = /\[[Pp]\s*(\d{1,3})\]/g
export const ANGLE_EP_RE = /《[^》]*》[^0-9]{0,40}?(\d{2,3})(?=\s+[\u4e00-\u9fa5])/g

/** 声道数（2.0 / 5.1 / 5.1.2）：技术规格，始终移除。 */
export const CHANNEL_RE = /(?<![A-Za-z0-9])\d\.\d(?:\.\d)?(?![A-Za-z0-9])/g

/** 集数描述：全X集 / 全集 / 共X集 / 第X-Y集 / X集 / 合集。 */
export const EPISODE_COUNT_RE = /(?:全\s*\d+\s*集|全集|共\s*\d+\s*集|更新至\s*\d+\s*集|第\s*\d+\s*[-~—至]\s*\d+\s*集|\d+\s*集|合集)/g

/** 方括号 / 全角方括号 / 书名号。 */
export const BRACKET_CONTENT_RE = /\[([^\]]*)\]|【([^】]*)】/g
export const BRACKET_RE = /\[[^\]]*\]|【[^】]*】/g

/** 发布组后缀：形如 `-GROUP` / `@GROUP`，紧跟在技术标签之后。 */
export const RELEASE_GROUP_RE = /[-_@][A-Za-z0-9\u4e00-\u9fa5]{1,20}$/

/** 季标识：Season 02 / S02 / 第二季。 */
export const SEASON_DIR_RE = /season\s*(\d{1,2})|(?<![A-Za-z0-9])s(\d{1,2})(?![A-Za-z0-9])|第\s*([一二三四五六七八九十\d]+)\s*季/i

/** 目录名里的「季 / 部 / 年番」说明（用于标记多季，腾清标题）。 */
export const SEASON_NOTE_PATTERNS = [
  /第\s*[一二三四五六七八九十\d]+\s*[-~—至]\s*[一二三四五六七八九十\d]+\s*季/g,
  /第\s*[一二三四五六七八九十\d]+\s*[部季]/g,
  /年番\s*[一二三四五六七八九十\d]*/g,
  /(?<![A-Za-z0-9])[Ss]\s*\d{1,2}(?![A-Za-z0-9])/g,
]

/** 「{集号}-{分P}」形态：捕获组 1=片名，2=集号，3=Part。 */
export const MULTIPART_TAIL_RE = /^(.+?)[\s._]{0,2}(\d{1,4})\s*[-_－]\s*([1-9])\s*$/
/** 已带标准集数信号时不按 Part 规则处理，避免误伤。 */
export const EPISODE_SIGNAL_RE = /[Ss]\s*\d{1,2}\s*[Ee]\s*\d{1,3}|第\s*\d{1,3}\s*[集话回]|\d{1,3}\s*集/

export const CN_DIGITS = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
}

/** 处理状态。 */
export const STATUS = {
  CHANGED: 'CHANGED',
  SKIP: 'SKIP',
  CONFLICT: 'CONFLICT',
  UNKNOWN: 'UNKNOWN',
  OUT_OF_SCOPE: 'OUT_OF_SCOPE',
}

/** 把带 g 的正则安全地用于「是否存在」判定（避免 lastIndex 状态污染）。 */
export function hasMatch(re, text) {
  return new RegExp(re.source, re.flags.replace('g', '')).test(text)
}
