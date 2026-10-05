/**
 * 文件名解析核心：把「脏」的影视文件名拆成 片名 / 年份 / 季 / 集 / 版本 / 分P。
 *
 * 纯函数、零依赖、零 IO。清洗标签全部来自传入的**规则包**（pack），
 * 因此换一套规则不需要改这里的一行代码。
 */
import * as R from './rules-data.js'

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 安全读取规则包里的标签表。 */
const tags = (pack, key) => (pack && pack.cleanup && Array.isArray(pack.cleanup[key]) ? pack.cleanup[key] : [])

/** 中文数字（一 ~ 九十九）转整数；失败返回 undefined。 */
export function cnNum(text) {
  if (/^\d+$/.test(text)) return Number(text)
  if (R.CN_DIGITS[text] !== undefined) return R.CN_DIGITS[text]
  if (text === '十') return 10
  if (text.startsWith('十')) return 10 + (R.CN_DIGITS[text[1]] ?? 0)
  if (text.endsWith('十')) return (R.CN_DIGITS[text[0]] ?? 0) * 10
  if (text.includes('十')) {
    const [tens, ones] = text.split('十')
    return (R.CN_DIGITS[tens] ?? 0) * 10 + (R.CN_DIGITS[ones] ?? 0)
  }
  return undefined
}

export function containsCjk(text) {
  return /[\u4e00-\u9fff]/.test(text)
}

/** 括号内容是否为噪音（发布组 / 技术 / 集数 / 字幕配音 / 站点）。 */
function bracketIsNoise(content, pack) {
  const c = content.trim()
  if (!c) return true
  // 纯数字括号可能含年份或集数，保留供后续解析
  if (/^\d{1,4}$/.test(c)) return false
  if (R.hasMatch(R.SITE_AD_RE, c) || R.hasMatch(R.SITE_URL_RE, c)) return true
  if (!containsCjk(c)) return true

  // 逐项剥离已知噪音，看是否还剩片名性质的中文
  let probe = c
  for (const tag of tags(pack, 'chinese')) probe = probe.split(tag).join(' ')
  for (const word of tags(pack, 'bracketNoise')) probe = probe.split(word).join(' ')
  probe = probe.replace(R.EPISODE_COUNT_RE, ' ')
  probe = probe.replace(/第\s*[一二三四五六七八九十\d]+\s*[部季集]/g, ' ')
  probe = probe.replace(/\d+\s*[部篇番季]/g, ' ')
  probe = probe.replace(/\d{1,4}\s*[-~—至]\s*\d{1,4}/g, ' ')
  probe = probe.replace(/[()（）]/g, ' ')
  probe = probe.replace(/[0-9A-Za-z.@_\-+/\\·×xX]+/g, ' ')
  return [...probe].filter((ch) => ch >= '\u4e00' && ch <= '\u9fff').length === 0
}

/** 移除噪音括号；含片名的括号剥壳保留正文，供后续继续清洗。 */
function cleanBrackets(text, pack) {
  return text.replace(R.BRACKET_CONTENT_RE, (match, square, corner) => {
    const content = square !== undefined ? square : corner
    if (/^\d{1,4}$/.test(content)) return match
    if (/^[Pp]\d{1,3}$/.test(content)) return match
    if (bracketIsNoise(content, pack)) return ' '
    return content
  })
}

/** 半角冒号转全角，其余 Windows 非法字符替换为 ' - '。 */
function stripIllegal(title) {
  let out = title.replace(/:/g, '：')
  for (const ch of R.ILLEGAL_CHARS) out = out.split(ch).join(' - ')
  return out
}

/**
 * 从清理后的残串还原标题。
 *
 * 关键区分「硬分隔符」与「空格」：
 * - 点 / 下划线 / 连字符 / 括号是**分隔符**，两侧片段直接拼接（`觉醒.年代` → `示例剧集`）；
 * - **空格是标题的一部分**，必须保留（`示例剧场版 副标题` 不能被压成
 *   `示例动漫剧场版剑道尘心`——这是真实网盘数据里踩到的坑）。
 */
function titleFromResidue(residue) {
  const HARD_SEPARATOR = '\u0000'
  const marked = residue.replace(/[._\-+()（）[\]【】]+/g, HARD_SEPARATOR)
  const segments = marked
    .split(HARD_SEPARATOR)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  if (segments.length === 0) return ''
  const cjk = segments.filter(containsCjk)
  return (cjk.length > 0 ? cjk : segments).join('')
}

/** 取出第一个年份，并把该处替换为空格（只替换一次，避免误伤片名里的数字）。 */
function extractYear(text) {
  const re = new RegExp(R.YEAR_RE.source, 'g')
  const match = re.exec(text)
  if (!match) return { year: undefined, text }
  const cut = text.slice(0, match.index) + ' ' + text.slice(match.index + match[0].length)
  return { year: Number(match[0]), text: cut }
}

const replaceAll = (text, re) =>
  text.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), ' ')

/** 提取季集，返回 { season, episode, text, warnings }；按优先级依次兜底。 */
function extractEpisodes(text, seasonHint) {
  let season = seasonHint
  let episode
  const warnings = []

  const seMatch = new RegExp(R.S_E_RE.source, 'g').exec(text)
  if (seMatch) {
    season = Number(seMatch[1])
    episode = Number(seMatch[2])
    text = replaceAll(text, R.S_E_RE)
  }

  const epValues = episode !== undefined ? [episode] : []
  for (const re of [R.E_RE, R.EP_RE, R.CN_EP_RE, R.CN_EP_HUA_RE, R.NUM_CN_EP_RE]) {
    for (const match of text.matchAll(new RegExp(re.source, 'g'))) epValues.push(Number(match[1]))
    text = replaceAll(text, re)
  }

  // 兜底链：仅在没有任何集数信号时才启用，避免抢占更高优先级的写法
  if (epValues.length === 0) {
    for (const re of [R.BRACKET_EP_RE, R.P_EP_RE, R.LEADING_NUM_EP_RE, R.ANGLE_EP_RE, R.PAREN_EP_RE]) {
      const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`
      const match = new RegExp(re.source, flags).exec(text)
      if (!match) continue
      epValues.push(Number(match[1]))
      text = replaceAll(text, re)
      break
    }
  }

  if (epValues.length > 0) {
    const distinct = [...new Set(epValues)].sort((a, b) => a - b)
    if (episode === undefined) episode = distinct[0]
    if (distinct.length > 1) warnings.push('检测到多个集数，可能为多集合并档')
  }
  return { season, episode, text, warnings }
}

/** 分离技术标签：编码来源类删除，版本类单独收集后也删除。 */
function filterTechTags(text, pack) {
  for (const tag of tags(pack, 'sourceCodec')) {
    text = text.replace(new RegExp(`(?<![a-z0-9])${escapeRe(tag)}(?![a-z0-9])`, 'gi'), ' ')
  }
  text = text.replace(R.CHANNEL_RE, ' ')
  const hits = []
  for (const tag of tags(pack, 'version')) {
    const re = new RegExp(`(?<![a-z0-9])${escapeRe(tag)}(?![a-z0-9])`, 'gi')
    for (const match of text.matchAll(re)) hits.push({ index: match.index, text: match[0] })
    text = text.replace(re, ' ')
  }
  hits.sort((a, b) => a.index - b.index)
  return { versionHits: hits.map((hit) => hit.text), text }
}

const collectVersion = (text, pack) => filterTechTags(text, pack).versionHits

/**
 * 推断内容类型：显式提示优先，其次文件名里的集数信号。
 * 目录名 → 内容类型的映射属于规则包，由上层（plan.js）先算好再传进来。
 */
export function detectMediaType(filename, hint) {
  if (hint === 'movie' || hint === 'tv') return hint
  if (R.hasMatch(R.S_E_RE, filename) || R.hasMatch(R.E_RE, filename) || R.hasMatch(R.EP_RE, filename)
    || R.hasMatch(R.CN_EP_RE, filename) || R.hasMatch(R.EPISODE_COUNT_RE, filename)) return 'tv'
  return 'movie'
}

function seasonFromText(text) {
  const match = R.SEASON_DIR_RE.exec(text)
  if (!match) return undefined
  if (match[1]) return Number(match[1])
  if (match[2]) return Number(match[2])
  if (match[3]) return cnNum(match[3])
  return undefined
}

/** 解析单个文件名（目录链提供的信息作为兜底）。 */
export function parseName(filename, options = {}) {
  const { pack, keepVersion = false, mediaType, year, season, version = [] } = options
  const reasons = []

  let stem = filename
  let ext = ''
  const dot = filename.lastIndexOf('.')
  if (dot > 0) {
    const maybeExt = filename.slice(dot)
    if (maybeExt.length <= 6 && /^\.[A-Za-z0-9]+$/.test(maybeExt)) {
      stem = filename.slice(0, dot)
      ext = maybeExt
    }
  }

  let text = cleanBrackets(stem, pack)
  text = text.replace(R.SITE_URL_RE, ' ')
  text = text.replace(R.SITE_AD_RE, ' ')
  text = text.replace(R.RELEASE_GROUP_RE, ' ')

  const yearResult = extractYear(text)
  let resolvedYear = yearResult.year
  text = yearResult.text

  const episodeResult = extractEpisodes(text, season)
  let resolvedSeason = episodeResult.season
  const episode = episodeResult.episode
  text = episodeResult.text
  reasons.push(...episodeResult.warnings)

  for (const tag of tags(pack, 'chinese')) text = text.split(tag).join(' ')
  text = replaceAll(text, R.EPISODE_COUNT_RE)

  const tech = filterTechTags(text, pack)
  text = tech.text

  if (resolvedYear === undefined) resolvedYear = year
  const resolvedVersion = tech.versionHits.length > 0 ? tech.versionHits : version
  const title = stripIllegal(titleFromResidue(text))

  let confidence = 1
  if (title === '') { confidence = 0; reasons.push('标题清洗后为空') }
  if (resolvedYear === undefined) { confidence -= 0.2; reasons.push('缺少年份') }
  if (mediaType === 'tv' && episode === undefined) { confidence -= 0.3; reasons.push('电视剧缺少集数') }
  if (mediaType === 'tv' && resolvedSeason === undefined) resolvedSeason = 1
  if (episode !== undefined && episode <= 0) { confidence -= 0.3; reasons.push('集数无效') }

  return {
    originalPath: filename,
    mediaType,
    title,
    year: resolvedYear,
    season: resolvedSeason,
    episode,
    version: resolvedVersion.join(' '),
    versionTags: resolvedVersion,
    ext,
    confidence: Math.round(confidence * 100) / 100,
    needsManualReview: confidence < 0.8 || reasons.length > 0,
    reasons,
  }
}

/** 解析完整路径（/ 或 \ 分隔）。 */
export function parsePath(path, options = {}) {
  const parts = String(path).split(/[\\/]+/).filter(Boolean)
  const filename = parts.length > 0 ? parts[parts.length - 1] : ''
  const dirnames = parts.slice(1, -1)

  let yearHint
  let seasonHint
  const versionHint = []
  for (const dir of [...dirnames].reverse()) {
    if (yearHint === undefined) yearHint = extractYear(dir).year
    if (seasonHint === undefined) seasonHint = seasonFromText(dir)
    if (options.keepVersion && versionHint.length === 0) versionHint.push(...collectVersion(dir, options.pack))
  }

  const mediaType = detectMediaType(filename, options.mediaType)
  return parseName(filename, {
    pack: options.pack,
    keepVersion: options.keepVersion,
    mediaType,
    year: yearHint,
    season: seasonHint,
    version: versionHint,
  })
}

/** 解析目录名，生成规范目录名（只留片名 + 年份；季/部说明只做标记）。 */
export function parseDirName(name, mediaType, pack) {
  const reasons = []
  let text = cleanBrackets(name, pack)
  text = text.replace(R.SITE_URL_RE, ' ')
  text = text.replace(R.SITE_AD_RE, ' ')
  text = text.replace(R.RELEASE_GROUP_RE, ' ')
  const yearResult = extractYear(text)
  const year = yearResult.year
  text = yearResult.text
  for (const tag of tags(pack, 'chinese')) text = text.split(tag).join(' ')
  text = replaceAll(text, R.EPISODE_COUNT_RE)

  const seasonNotes = []
  for (const pattern of R.SEASON_NOTE_PATTERNS) {
    const re = new RegExp(pattern.source, 'g')
    for (const match of text.matchAll(re)) seasonNotes.push(match[0].trim())
    text = text.replace(re, ' ')
  }
  text = filterTechTags(text, pack).text
  const title = stripIllegal(titleFromResidue(text))

  if (!title) reasons.push('标题清洗后为空')
  if (year === undefined) reasons.push('缺少年份')
  const multi = seasonNotes.filter(isMultiSeasonNote)
  if (multi.length > 0) reasons.push(`含季/部说明：${multi.join('、')}`)

  return {
    mediaType,
    title,
    year,
    seasonNotes,
    newName: title && year ? `${title} (${year})` : title,
    needsManualReview: reasons.length > 0,
    reasons,
  }
}

/** 单季的 S01 / 第一季 属默认季；从第二季起才算续集，需要人工决策。 */
function isMultiSeasonNote(note) {
  const n = (note || '').trim()
  if (!n) return false
  if (n.includes('合集') || n.includes('-') || n.includes('至') || n.includes('—') || n.includes('~')) return true
  if (n.startsWith('年番')) {
    const tail = n.slice(2).trim()
    return Boolean(tail) && tail !== '1' && tail !== '一'
  }
  const seasonMatch = /^第\s*([一二三四五六七八九十\d]+)\s*[季部]/.exec(n)
  if (seasonMatch) {
    const num = cnNum(seasonMatch[1])
    return num !== undefined && num >= 2
  }
  const sMatch = /^[Ss](?:eason)?\s*(\d{1,2})/i.exec(n)
  if (sMatch) return Number(sMatch[1]) >= 2
  return false
}

/** 识别分 Part 命名：支持 `{片名} - Part1`（已带标记）与 `{集号}-{分P}`（示例动漫 240-1）。 */
export function detectMultipart(stem) {
  // 1) 已带 Part 标记：`{片名} - Part1` / `{片名} Part 2`
  const tagged = /^(.+?)[\s._\-]*[Pp][Aa][Rr][Tt]\s*([1-9])\s*$/.exec(stem)
  if (tagged) {
    const head = tagged[1].replace(/[\s._\-]+$/, '').trim()
    const part = Number(tagged[2])
    if (head && part <= 4) return { head, episode: undefined, part }
  }

  // 2) `{集号}-{分P}`：示例动漫 240-1
  if (R.EPISODE_SIGNAL_RE.test(stem)) return undefined
  const match = R.MULTIPART_TAIL_RE.exec(stem)
  if (!match) return undefined
  const head = match[1].replace(/^[\s._-]+|[\s._-]+$/g, '')
  const episode = Number(match[2])
  const part = Number(match[3])
  if (!head || episode < 1 || part > 4) return undefined
  return { head, episode, part }
}

const pad2 = (value) => String(value).padStart(2, '0')

/** 按规范拼装目标路径；库根沿用来源库，不擅自跨库移动。 */
export function buildTarget({
  baseDir = '', library, prefix = '', mediaType, title, year, season, episode, part, version, ext,
  seasonFolder = true,
}) {
  if (!title) return ''
  const yearPart = year ? ` (${year})` : ''
  const versionPart = version ? ` - ${version}` : ''
  const partPart = part ? ` - Part ${part}` : ''
  // baseDir 是「作品目录的父路径」，由**源路径**推导：这样本地盘 / NAS / 115 走同一套逻辑，
  // 不必依赖「库名映射」；没给 baseDir 时才回退到 prefix + library 的老写法。
  const head = baseDir || [prefix, library].filter(Boolean).join('/')
  if (mediaType === 'movie') {
    return `${head}/${title}${yearPart}/${title}${yearPart}${partPart}${versionPart}${ext}`
  }
  // seasonFolder=false 时不建 Season 子目录，文件直接放在作品目录下
  const folder = seasonFolder ? `Season ${pad2(season || 1)}/` : ''
  return `${head}/${title}${yearPart}/${folder}`
    + `${title} S${pad2(season || 1)}E${pad2(episode)}${partPart}${versionPart}${ext}`
}
