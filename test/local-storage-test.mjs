/**
 * 本地后端端到端测试：在系统临时目录里造一个「脏」作品目录，
 * 走「扫描 → 计划 → dry-run → 执行 → 复验 → 占用保护」全流程。
 *
 * 全部发生在临时目录，不触碰任何真实媒体文件；结束时自动清理。
 * 运行：node test/local-storage-test.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, '..')
const SANDBOX_HOME = mkdtempSync(path.join(os.tmpdir(), 'media-naming-local-home-'))
process.env.DSH_HOME = SANDBOX_HOME

const load = (relative) => import(pathToFileURL(path.join(PLUGIN_DIR, relative)).href)
const { applyLocalPlan, isLocalPath, scanLocal, toPosix } = await load('lib/local-storage.js')
const { plan } = await load('lib/plan.js')
const { loadRulePack } = await load('lib/rules.js')

const checks = []
const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail })
const pack = loadRulePack()

// ---- 造一个「脏」作品目录：站点广告 + 技术标签，文件名是英文名
const mediaRoot = path.join(SANDBOX_HOME, '影视库')
const workName = '【发布页 www.example.com】示例剧名[全2集][国语配音].2026.2160p.WEB-DL.H265-Group'
const dirtyDir = path.join(mediaRoot, workName)
mkdirSync(dirtyDir, { recursive: true })
for (const name of [
  'Sample.Show.S01E01.2026.2160p.WEB-DL.H265-Group.mkv',
  'Sample.Show.S01E02.2026.2160p.WEB-DL.H265-Group.mkv',
  '更多剧集下载请访问官网.png',
]) {
  writeFileSync(path.join(dirtyDir, name), 'x')
}

// ---- 1) 路径类型判断：Windows 盘符 / UNC(NAS) / Linux / 115 相对路径
check('识别 Windows 盘符路径', isLocalPath('G:\\Media\\影视库') === true)
check('识别 UNC / NAS 路径', isLocalPath('\\\\NAS\\media\\影视库') === true)
check('识别 Linux / macOS 路径', isLocalPath('/mnt/media/影视库') === true)
check('115 相对路径不当作本地', isLocalPath('影视资源/电视剧/某剧 (2026)') === false)

// ---- 2) 只读扫描
const scanned = scanLocal(dirtyDir)
check('扫描到 2 个视频（png 不算）', scanned.files.length === 2,
  JSON.stringify(scanned.files.map((one) => path.basename(one))))
check('记录同目录已有文件名（供冲突检测）',
  (scanned.existingByDir[toPosix(dirtyDir)] ?? []).length === 3)
check('扫描不改动任何东西', readdirSync(dirtyDir).length === 3)

// ---- 3) 用插件引擎生成计划：目标路径应当**沿用源盘路径**
// seasonFolder:false —— 与「零移动」场景对应（建 Season 时确实需要移动，见用例 9）
const result = plan(scanned.files, { pack, existingByDir: scanned.existingByDir, seasonFolder: false })
check('计划识别出 1 个待改目录', result.directories.length === 1 && result.directories[0].status === 'CHANGED')
check('目录新名已规范化', result.directories[0].proposedName === '示例剧名 (2026)',
  result.directories[0].proposedName)
check('2 个文件都待改', result.summary.changed === 2, JSON.stringify(result.summary))
check('目标路径沿用本地源路径（含盘符）',
  result.items.every((one) => toPosix(one.proposedPath).startsWith(toPosix(mediaRoot))),
  result.items[0]?.proposedPath)
check('目标文件名已规范化',
  result.items.some((one) => one.proposedPath.endsWith('示例剧名 S01E01.mkv')),
  result.items.map((one) => path.posix.basename(one.proposedPath)).join(','))

const payload = {
  planId: 'local-test',
  scope: { target: toPosix(dirtyDir) },
  summary: result.summary,
  items: result.items,
  directories: result.directories,
}

// ---- 4) dry-run 不写入
const dry = applyLocalPlan(payload, { apply: false })
check('dry-run 不写入任何内容', dry.executed === 0 && dry.directoriesExecuted === 0)
check('dry-run 后目录名未变', readdirSync(mediaRoot).includes(workName))

// ---- 5) 真正执行
const applied = applyLocalPlan(payload, { apply: true })
check('执行了 2 个文件', applied.executed === 2, JSON.stringify(applied.failed))
check('执行了 1 个目录', applied.directoriesExecuted === 1, JSON.stringify(applied.failed))
check('零移动（作品目录改名时文件原地改名）', applied.moved === 0, `moved=${applied.moved}`)
check('执行无失败', applied.ok === true, JSON.stringify(applied.failed))

// ---- 6) 复验
const finalDir = path.join(mediaRoot, '示例剧名 (2026)')
check('目录名已规范化', existsSync(finalDir))
const finalNames = existsSync(finalDir) ? readdirSync(finalDir).sort() : []
check('文件名已规范化',
  finalNames.includes('示例剧名 S01E01.mkv') && finalNames.includes('示例剧名 S01E02.mkv'),
  finalNames.join(','))
check('非视频文件保持原名', finalNames.includes('更多剧集下载请访问官网.png'))
check('旧目录已不存在', !existsSync(dirtyDir))

// ---- 7) 回滚清单可逆
check('生成 3 条回滚记录', applied.rollback.length === 3, String(applied.rollback.length))

// ---- 8) 目标名被占用时拒绝（绝不覆盖）
const occupiedDir = path.join(mediaRoot, '被占用 (2026)')
mkdirSync(occupiedDir, { recursive: true })
const blocked = applyLocalPlan({
  items: [],
  directories: [{
    status: 'CHANGED',
    currentPath: toPosix(finalDir),
    proposedPath: toPosix(occupiedDir),
  }],
}, { apply: true })
check('目标目录名被占用时拒绝执行',
  blocked.directoriesExecuted === 0 && blocked.failed.some((one) => one.reason === 'target-occupied'),
  JSON.stringify(blocked.failed))

// ---- 9) 补 Season 子目录：确实会移动，且「先改目录名」的顺序修复必须让两者不冲突
const seasonRoot = path.join(SANDBOX_HOME, '影视库2')
const seasonWork = '【发布页 www.example.com】某剧[全1集].2026.2160p.WEB-DL-Group'
const seasonDir = path.join(seasonRoot, seasonWork)
mkdirSync(seasonDir, { recursive: true })
writeFileSync(path.join(seasonDir, 'Some.Show.S01E01.2026.2160p.WEB-DL-Group.mkv'), 'x')
const scanned2 = scanLocal(seasonDir)
const result2 = plan(scanned2.files, { pack, existingByDir: scanned2.existingByDir })  // 默认建 Season
const applied2 = applyLocalPlan({
  scope: {}, summary: result2.summary, items: result2.items, directories: result2.directories,
}, { apply: true })
check('补 Season：文件确实移动了', applied2.moved === 1, `moved=${applied2.moved}`)
check('补 Season：目录改名与新建 Season 不冲突', applied2.ok === true, JSON.stringify(applied2.failed))
const seasonFinal = path.join(seasonRoot, '某剧 (2026)', 'Season 01', '某剧 S01E01.mkv')
check('补 Season：最终路径正确',
  existsSync(seasonFinal),
  existsSync(path.join(seasonRoot, '某剧 (2026)')) ? readdirSync(path.join(seasonRoot, '某剧 (2026)')).join(',') : '目录不存在')

// ---- 10) 后端路由：按路径自动判断（显式配置优先）
const { resolveStorage } = await load('lib/storage.js')
check('盘符路径 → local', resolveStorage({}, 'G:\\Media\\剧集') === 'local')
check('UNC 路径 → local', resolveStorage({}, '\\\\NAS\\media\\剧集') === 'local')
check('Linux 路径 → local', resolveStorage({}, '/mnt/media/剧集') === 'local')
check('115 相对路径 → 115', resolveStorage({}, '影视资源/电视剧/某剧 (2026)') === '115')
check('显式配置优先（强制 local）', resolveStorage({ storage: 'local' }, '影视资源/电视剧/某剧') === 'local')
check('显式配置优先（强制 115）', resolveStorage({ storage: '115' }, 'G:\\Media\\剧集') === '115')

// ---- 汇总
const failed = checks.filter((one) => !one.ok)
for (const one of checks) {
  console.log(`[${one.ok ? 'OK' : 'FAIL'}] ${one.name}${one.ok ? '' : `（${one.detail}）`}`)
}
console.log('='.repeat(64))
console.log(`checks passed=${checks.length - failed.length} failed=${failed.length}`)
rmSync(SANDBOX_HOME, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
