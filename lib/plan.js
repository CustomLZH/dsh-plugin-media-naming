/**
 * dry-run 计划：状态判定、版本后缀决策与冲突检测。
 *
 * 纯函数、零 IO。目标目录结构与清洗规则都来自传入的**规则包**：
 * 代码不认识「电影/电视剧」这类具体目录名，只按规则包里的映射推断内容类型。
 */
import { buildTarget, containsCjk, detectMultipart, parseDirName, parsePath } from './parse.js'
import * as R from './rules-data.js'

const splitParts = (path) => String(path ?? '').split(/[\\/]+/).filter(Boolean)

/** 规范化目录写法：统一分隔符，不去掉尾段。 */
export const normalizeDir = (path) => splitParts(path).join('/')

/** 取所在目录。 */
export const dirOf = (path) => {
  const normalized = normalizeDir(path)
  const index = normalized.lastIndexOf('/')
  return index < 0 ? '' : normalized.slice(0, index)
}

/** 取文件名。 */
export const nameOf = (path) => {
  const parts = splitParts(path)
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

const extOf = (name) => {
  const dot = String(name).lastIndexOf('.')
  return dot > 0 ? String(name).slice(dot) : ''
}

const stemOf = (name) => {
  const dot = String(name).lastIndexOf('.')
  return dot > 0 ? String(name).slice(0, dot) : String(name)
}

/**
 * 拆出 根前缀 / 目标段（第一层目录）/ 其余目录链 / 文件名。
 * 不预设任何目录名：`影视资源/我的剧集/某剧 (2020)/a.mkv` 与
 * `动漫/示例动漫 (2018)/a.mp4` 走的是同一条路径。
 */
export function splitPath(path, pack) {
  let parts = splitParts(path)
  let prefix = ''
  const rootPrefix = pack?.rootPrefix ?? ''
  if (rootPrefix && parts[0] === rootPrefix) {
    prefix = parts[0]
    parts = parts.slice(1)
  }
  const top = parts.length > 0 ? parts[0] : ''
  const rest = parts.slice(1)
  return {
    prefix,
    top,
    rest,
    dirs: rest.slice(0, -1),
    filename: rest.length > 0 ? rest[rest.length - 1] : '',
  }
}

/** 内容类型：显式参数 > 规则包的目录映射 >（parse 层再按文件名兜底）。 */
function resolveMediaType(info, pack, hint) {
  if (hint === 'movie' || hint === 'tv') return hint
  const segments = [info.top, ...info.dirs]
  for (const entry of pack?.libraries ?? []) {
    if (!entry || !entry.match) continue
    if (segments.some((segment) => segment && segment.includes(entry.match))) {
      return entry.mediaType === 'auto' ? undefined : entry.mediaType
    }
  }
  return undefined
}

/** 是否属于规则包里声明的排除目录（可含多层，任一目录段命中即排除）。 */
function isExcluded(info, pack) {
  const names = pack?.excluded ?? []
  if (names.length === 0) return false
  const segments = [info.top, ...info.dirs]
  return names.some((name) => segments.some((segment) => segment && segment.includes(name)))
}

/** 构造规则引擎需要的路径（首段是目标段，其余是作品目录链）。 */
const enginePathOf = (info, filename) =>
  [info.top, ...info.dirs, filename].filter(Boolean).join('/')

/** 解析单条路径，返回中间结果（不含版本后缀决策）。 */
export function analyze(path, options = {}) {
  const pack = options.pack ?? {}
  const info = splitPath(path, pack)
  // 作品目录的父路径：由**源路径**推导，目标路径直接沿用它，
  // 因此本地盘 / NAS / 115 走同一套逻辑，不依赖「库名映射」。
  const workChain = [...info.dirs]
  while (workChain.length > 0 && /^Season \d+$/i.test(workChain[workChain.length - 1])) workChain.pop()
  const baseDir = [info.prefix, info.top, ...workChain.slice(0, -1)].filter(Boolean).join('/')

  const base = {
    currentPath: path,
    prefix: info.prefix,
    library: info.top,
    top: info.top,
    baseDir,
    filename: info.filename,
    mediaType: undefined,
    title: '',
    year: undefined,
    season: undefined,
    episode: undefined,
    version: '',
    part: undefined,
    confidence: 0,
    reasons: [],
    status: undefined,
    reason: '',
    needsReview: false,
  }
  if (!info.filename) return { ...base, status: R.STATUS.UNKNOWN, reason: '路径为空' }

  const exts = new Set((pack.videoExtensions ?? []).map((item) => String(item).toLowerCase()))
  const ext = extOf(info.filename)
  if (exts.size > 0 && !exts.has(ext.toLowerCase())) {
    return { ...base, status: R.STATUS.OUT_OF_SCOPE, reason: `非视频文件（${ext || '无扩展名'}）` }
  }
  if (isExcluded(info, pack)) {
    return { ...base, status: R.STATUS.OUT_OF_SCOPE, reason: `规则包排除的目录：${info.top}` }
  }

  const mediaType = resolveMediaType(info, pack, options.mediaType)
  const multipart = detectMultipart(stemOf(info.filename)) ?? undefined
  const parseFilename = multipart ? `${multipart.head}${ext}` : info.filename
  const parsed = parsePath(enginePathOf(info, parseFilename), { pack, mediaType })

  // 中文优先：文件名是外文、而作品目录名是中文时，以目录名为准。
  // 中文剧集常见「目录用中文名、文件用英文名」（如 示例剧名 / Sample.Show.S01E01...）。
  const workDirName = workDirNameOf(info)
  const dirParsed = workDirName ? parseDirName(workDirName, parsed.mediaType, pack) : undefined
  const useDirTitle = Boolean(dirParsed?.title) && !containsCjk(parsed.title) && containsCjk(dirParsed.title)

  const item = {
    ...base,
    mediaType: parsed.mediaType,
    title: useDirTitle ? dirParsed.title : parsed.title,
    year: parsed.year ?? dirParsed?.year,
    season: parsed.season ?? (parsed.mediaType === 'tv' ? 1 : undefined),
    episode: multipart?.episode ?? parsed.episode,
    version: parsed.version,
    part: multipart ? multipart.part : undefined,
    confidence: parsed.confidence,
    reasons: parsed.reasons,
    needsReview: parsed.needsManualReview,
  }
  const finished = applyStatusRules(item)
  // 单条解析也要给出提议路径；版本后缀留给计划阶段按「是否存在多版本」决定。
  finished.proposedPath = proposedPath(finished, resolveSeasonFolder(options))
  return finished
}

/** 解析结果不足即判 UNKNOWN，并给出可读原因。 */
function applyStatusRules(item) {
  if (!item.title) return { ...item, status: R.STATUS.UNKNOWN, reason: '无法解析片名（missing_title）' }
  if (item.year === undefined || item.year === null) {
    return { ...item, status: R.STATUS.UNKNOWN, reason: '无法解析年份（missing_year）' }
  }
  if (item.mediaType === 'tv' && !item.episode) {
    return { ...item, status: R.STATUS.UNKNOWN, reason: '无法解析集数（missing_episode）' }
  }
  return { ...item, status: R.STATUS.CHANGED, reason: '' }
}

const versionKey = (item) =>
  [item.library, item.mediaType, item.title, item.year, item.season, item.episode, item.part].join('\u0001')

/** 同片同集解析出多个不同版本时，才保留版本后缀。 */
function versionKeys(items) {
  const groups = new Map()
  for (const item of items) {
    if (item.status === R.STATUS.UNKNOWN || item.status === R.STATUS.OUT_OF_SCOPE) continue
    if (!item.version) continue
    const key = versionKey(item)
    if (!groups.has(key)) groups.set(key, new Set())
    groups.get(key).add(item.version)
  }
  const result = new Set()
  for (const [key, versions] of groups) if (versions.size > 1) result.add(key)
  return result
}

/** Season 子目录开关：调用参数 > 规则包 > 默认建（`seasonFolder: false` 就不建）。 */
const resolveSeasonFolder = (options = {}) => options.seasonFolder ?? options.pack?.seasonFolder ?? true

function proposedPath(item, seasonFolder = true) {
  if (item.status === R.STATUS.UNKNOWN || item.status === R.STATUS.OUT_OF_SCOPE) return ''
  return buildTarget({
    baseDir: item.baseDir,
    library: item.library,
    prefix: item.prefix,
    mediaType: item.mediaType,
    title: item.title,
    year: item.year,
    season: item.season,
    episode: item.episode,
    part: item.part,
    version: item.keepVersion ? item.version : '',
    ext: extOf(item.filename),
    seasonFolder,
  })
}

/** 取作品目录名（去掉尾部的 Season XX）。 */
function workDirNameOf(info) {
  const dirs = [...info.dirs]
  while (dirs.length > 0 && /^Season \d+$/i.test(dirs[dirs.length - 1])) dirs.pop()
  return dirs.length > 0 ? dirs[dirs.length - 1] : ''
}

/**
 * 作品**目录名**本身也要规范化：使用者要的是「这个节目的目录 + 目录下的视频」。
 *
 * 只处理作品目录（把 `Season XX` 归并回作品层），不碰 Season 子目录；
 * 标题清洗后为空的目录（如 `花絮`、`特典`）直接跳过，避免误改结构目录。
 */
function buildDirectoryPlan(paths, pack) {
  const dirCounts = new Map()
  for (const path of paths) {
    const dir = dirOf(path)
    if (!dir) continue
    const workDir = dir.replace(/\/Season \d+$/i, '')
    dirCounts.set(workDir, (dirCounts.get(workDir) ?? 0) + 1)
  }

  const directories = []
  for (const [workDir, fileCount] of dirCounts) {
    const info = splitPath(workDir, pack)
    const currentName = nameOf(workDir)
    if (!currentName) continue
    const mediaType = resolveMediaType(info, pack, undefined) ?? 'movie'
    const parsed = parseDirName(currentName, mediaType, pack)
    if (!parsed.newName) continue
    const proposedPath = [dirOf(workDir), parsed.newName].filter(Boolean).join('/')
    directories.push({
      currentPath: workDir,
      proposedPath,
      currentName,
      proposedName: parsed.newName,
      mediaType,
      title: parsed.title,
      year: parsed.year,
      fileCount,
      status: proposedPath === workDir ? R.STATUS.SKIP : R.STATUS.CHANGED,
      reason: proposedPath === workDir ? '已符合规范' : '目录名规范化',
      needsReview: parsed.needsManualReview,
      reasons: parsed.reasons,
    })
  }
  return directories
}

/**
 * 对一组路径生成 dry-run 计划。
 * @param {string[]} paths 待处理路径（应来自使用者指定**单个节目目录**的扫描结果）
 * @param {object} [options] pack 规则包；mediaType 强制类型；existingByDir 目标目录已存在文件名
 */
export function plan(paths, options = {}) {
  const items = paths.map((path) => analyze(path, options))

  const knownDirs = new Map()
  const remember = (dir, name) => {
    if (!name) return
    const key = normalizeDir(dir)
    if (!knownDirs.has(key)) knownDirs.set(key, new Set())
    knownDirs.get(key).add(name)
  }
  for (const path of paths) remember(dirOf(path), nameOf(path))
  for (const [dir, names] of Object.entries(options.existingByDir ?? {})) {
    for (const name of names ?? []) remember(dir, name)
  }

  const seasonFolder = resolveSeasonFolder(options)
  const keepKeys = versionKeys(items)
  for (const item of items) {
    item.keepVersion = keepKeys.has(versionKey(item))
    item.proposedPath = proposedPath(item, seasonFolder)
  }

  const owners = new Map()
  items.forEach((item, index) => {
    if (item.status === R.STATUS.UNKNOWN || item.status === R.STATUS.OUT_OF_SCOPE) return
    const target = item.proposedPath
    if (!target) {
      item.status = R.STATUS.UNKNOWN
      item.reason = '无法生成目标路径'
      return
    }
    if (dirOf(target) === dirOf(item.currentPath) && nameOf(target) === nameOf(item.currentPath)) {
      item.status = R.STATUS.SKIP
      item.reason = '已符合规范'
      return
    }
    if (owners.has(target)) {
      const first = items[owners.get(target)]
      const message = `同批多个文件映射到同一目标：${nameOf(target)}`
      first.status = R.STATUS.CONFLICT
      first.reason = message
      item.status = R.STATUS.CONFLICT
      item.reason = message
      return
    }
    const occupied = knownDirs.get(dirOf(target))
    if (occupied && occupied.has(nameOf(target))) {
      item.status = R.STATUS.CONFLICT
      item.reason = `目标名已被占用，不自动覆盖：${nameOf(target)}`
      return
    }
    owners.set(target, index)
    item.status = R.STATUS.CHANGED
  })

  const counts = {}
  for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1

  const directories = buildDirectoryPlan(paths, options.pack)
  const directoryCounts = {}
  for (const entry of directories) {
    directoryCounts[entry.status] = (directoryCounts[entry.status] ?? 0) + 1
  }

  return {
    items,
    directories,
    summary: {
      total: items.length,
      changed: counts[R.STATUS.CHANGED] ?? 0,
      skip: counts[R.STATUS.SKIP] ?? 0,
      conflict: counts[R.STATUS.CONFLICT] ?? 0,
      unknown: counts[R.STATUS.UNKNOWN] ?? 0,
      outOfScope: counts[R.STATUS.OUT_OF_SCOPE] ?? 0,
      directories: directories.length,
      directoriesChanged: directoryCounts[R.STATUS.CHANGED] ?? 0,
    },
  }
}
