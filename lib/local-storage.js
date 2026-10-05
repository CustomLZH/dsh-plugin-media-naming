/**
 * 本地文件系统后端：Windows 本机盘、UNC 网络路径（NAS 挂载）、Linux / macOS 路径。
 *
 * 设计要点：
 * - 产出结构与 115 后端**完全一致**（`{rootPath, files, existingByDir, scanned, truncated}`），
 *   因此命名引擎、计划格式、审核清单、安全闸门都无需改动；
 * - 只做**改名 / 建目录 / 移动**，从不删除——任何操作都能用回滚清单改回；
 * - 与 115 后端同样的安全口径：目标名已被占用时**拒绝**，绝不覆盖。
 *
 * 为什么 NAS 也走这里：已挂载的 NAS（UNC `\\\\NAS\\share` 或映射盘符 `Z:`）与 Linux 挂载点
 * （`/mnt/media`）在文件系统层面就是普通目录，Node 的 fs 直接可用，不需要额外协议库。
 */
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import path from 'node:path'

const VIDEO_EXTS = new Set([
  '.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv',
  '.ts', '.m2ts', '.m4v', '.rmvb', '.webm',
])
const MAX_DEPTH = 3
const DEFAULT_LIMIT = 500

/** 该路径是否属于本地文件系统：盘符 / UNC / 绝对路径。 */
export function isLocalPath(value) {
  const text = String(value ?? '').trim()
  if (!text) return false
  if (/^[a-zA-Z]:[\\/]/.test(text)) return true          // C:\... 或 C:/...
  if (/^\\\\[^\\/]/.test(text)) return true              // \\NAS\share\...
  if (/^\//.test(text)) return true                      // /mnt/... 或 /Volumes/...
  return false
}

/** 统一成 `/` 分隔（引擎内部与 115 后端都是这种写法）。 */
export function toPosix(value) {
  return String(value ?? '').replace(/\\/g, '/')
}

/**
 * `/` 形式 → 本机可用的原生路径。
 * UNC 必须保留开头的双反斜杠，否则会被当成普通相对路径。
 */
export function toNative(value) {
  const text = String(value ?? '')
  if (process.platform !== 'win32') return text
  if (text.startsWith('//')) return `\\\\${text.slice(2).replace(/\//g, '\\')}`
  return text.replace(/\//g, '\\')
}

const samePath = (left, right) => toPosix(path.resolve(left)) === toPosix(path.resolve(right))

/**
 * 只读扫描一个本地路径（含 UNC / 已挂载的 NAS），
 * 返回结构与 115 后端的 `scan_115.py` 一致，便于上层无差别使用。
 */
export function scanLocal(target, { limit = DEFAULT_LIMIT, maxDepth = MAX_DEPTH } = {}) {
  const requested = String(target ?? '').trim()
  if (!requested) throw new Error('缺少路径：请给出要处理的目录')

  const root = toPosix(requested).replace(/\/+$/, '') || '/'
  if (!existsSync(toNative(root))) throw new Error(`路径不存在或不可访问：${requested}`)

  const state = {
    limit: Math.max(1, Number(limit) || DEFAULT_LIMIT),
    scanned: 0,
    truncated: false,
    files: [],
    existingByDir: {},
    unreadable: [],
  }

  const walk = (dir, depth) => {
    if (depth < 0 || state.truncated) return
    let entries
    try {
      entries = readdirSync(toNative(dir), { withFileTypes: true })
    } catch (error) {
      // 单个子目录无权限时跳过，不影响其余部分（NAS 上很常见）
      state.unreadable.push(`${dir}（${error?.code ?? 'ERROR'}）`)
      return
    }
    for (const entry of entries) {
      if (state.truncated) return
      const child = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        walk(child, depth - 1)
        continue
      }
      if (!entry.isFile()) continue
      state.scanned += 1
      if (!state.existingByDir[dir]) state.existingByDir[dir] = []
      state.existingByDir[dir].push(entry.name)
      if (VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) state.files.push(child)
      if (state.scanned >= state.limit) {
        state.truncated = true
        return
      }
    }
  }
  walk(root, maxDepth)

  return {
    rootPath: root,
    files: state.files,
    existingByDir: state.existingByDir,
    scanned: state.scanned,
    truncated: state.truncated,
    unreadable: state.unreadable,
    writable: true,
    storage: 'local',
  }
}

/**
 * 作品目录改名判定：父路径一致、仅最后一段不同。
 * 这种情况文件应当**原地改名**，不需要移动（目录改名会带着它们一起走）。
 */
function isWorkdirRename(currentPath, proposedPath) {
  const current = toPosix(currentPath).split('/')
  const proposed = toPosix(proposedPath).split('/')
  if (current.length !== proposed.length || current.length < 2) return false
  return current.slice(0, -1).join('/') === proposed.slice(0, -1).join('/')
    && current[current.length - 1] !== proposed[proposed.length - 1]
}

/**
 * 执行本地计划：先改文件（原地，必要时移动），最后改目录名。
 * `apply=false` 时只演练，不写入任何内容。
 */
export function applyLocalPlan(plan, { apply = false, log = () => {} } = {}) {
  const items = (plan?.items ?? []).filter((one) => one.status === 'CHANGED')
  const directories = (plan?.directories ?? []).filter((one) => one.status === 'CHANGED')
  const result = {
    ok: true,
    storage: 'local',
    dryRun: !apply,
    executed: 0,
    directoriesExecuted: 0,
    skipped: 0,
    failed: [],
    rollback: [],
    moved: 0,
  }
  const fail = (key, reason) => result.failed.push({ key, reason })

  // ① **先改作品目录名**：之后文件的源路径按映射更新即可。
  //    反过来的顺序会死锁——补 Season 时先建了「目标作品目录」，再改原目录名就会撞名。
  const renamed = new Map()
  for (const entry of directories) {
    const from = toNative(entry.currentPath)
    const to = toNative(entry.proposedPath)
    if (!existsSync(from)) {
      fail(entry.currentPath, 'directory-not-found')
      continue
    }
    if (!apply) {
      log(`  · 目录 ${path.basename(from)} → ${path.basename(to)}`)
      continue
    }
    try {
      if (existsSync(to) && !samePath(from, to)) {
        fail(entry.currentPath, 'target-occupied')
        continue
      }
      renameSync(from, to)
      renamed.set(toPosix(entry.currentPath), toPosix(entry.proposedPath))
      result.directoriesExecuted += 1
      result.rollback.push({
        from: toPosix(entry.proposedPath),
        to: toPosix(entry.currentPath),
        at: new Date().toISOString(),
        kind: 'directory',
      })
    } catch (error) {
      fail(entry.currentPath, String(error?.message ?? error))
    }
  }

  /** 目录改名后，把文件的原路径换成新路径。 */
  const remap = (posixPath) => {
    for (const [before, after] of renamed) {
      if (posixPath === before) return after
      if (posixPath.startsWith(`${before}/`)) return after + posixPath.slice(before.length)
    }
    return posixPath
  }

  // ② 再处理文件：源路径按 ① 的映射更新，目标仍用计划里的 proposedPath。
  for (const item of items) {
    const sourcePath = remap(toPosix(item.currentPath))
    const from = toNative(sourcePath)
    const to = toNative(item.proposedPath)
    if (!existsSync(from)) {
      fail(item.currentPath, 'source-not-found')
      continue
    }
    if (sourcePath === toPosix(item.proposedPath)) {
      result.skipped += 1
      continue
    }
    const workdirRename = isWorkdirRename(sourcePath, item.proposedPath)
    if (!apply) {
      log(`  · ${path.basename(from)} → ${path.basename(to)}${workdirRename ? '（原地改名）' : '（移动）'}`)
      continue
    }
    try {
      const targetDir = path.dirname(to)
      if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true })
      if (existsSync(to) && !samePath(from, to)) {
        fail(item.currentPath, 'target-occupied')
        continue
      }
      renameSync(from, to)
      if (!workdirRename) result.moved += 1
      result.executed += 1
      result.rollback.push({
        from: toPosix(item.proposedPath),
        to: sourcePath,
        at: new Date().toISOString(),
      })
    } catch (error) {
      const code = error?.code === 'EXDEV'
        ? '跨盘移动：请手动搬运后重试'
        : String(error?.message ?? error)
      fail(item.currentPath, code)
    }
  }

  result.ok = result.failed.length === 0
  return result
}
