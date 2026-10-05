/**
 * apply_115.py 的离线测试：只跑 `--explain`（不联网、不写入），
 * 验证「计划 → 操作序列」的推导与安全闸门是否正确。
 *
 * 联网的真实执行无法在自动测试里覆盖，需要使用者本人用真实凭据 dry-run。
 *
 * 运行：node test/apply-explain-test.mjs
 *      （可用环境变量 MEDIA_NAMING_PYTHON 指定解释器，默认 `python`）
 * 退出码：全部通过为 0，否则为 1。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, '..')
const PYTHON = process.env.MEDIA_NAMING_PYTHON || 'python'
const SCRIPT = path.join(PLUGIN_DIR, 'python', 'apply_115.py')
const OUT_DIR = path.join(PLUGIN_DIR, 'out', 'apply-test')

const checks = []
const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail })

mkdirSync(OUT_DIR, { recursive: true })

/** 跑一次脚本，返回 { code, stdout }（非 0 退出码不抛异常）。 */
function run(args) {
  try {
    const stdout = execFileSync(PYTHON, ['-u', SCRIPT, ...args], { encoding: 'utf8', windowsHide: true })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.status ?? -1, stdout: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

const cleanPlan = {
  planId: 'plan-test-clean',
  scope: { target: '电影/示例电影 (2024)' },
  summary: { total: 2, changed: 2, skip: 0, conflict: 0, unknown: 0, outOfScope: 0 },
  items: [
    {
      status: 'CHANGED',
      currentPath: '影视资源/电影/示例电影 (2024)/示例电影.2024.2160p.mkv',
      proposedPath: '影视资源/电影/示例电影 (2024)/示例电影 (2024).mkv',
    },
    {
      status: 'CHANGED',
      currentPath: '影视资源/电视剧/示例剧集 (2021)/示例剧集.第05集.mp4',
      proposedPath: '影视资源/电视剧/示例剧集 (2021)/Season 01/示例剧集 S01E05.mp4',
    },
    {
      status: 'SKIP',
      currentPath: '影视资源/电影/示例动画 (2001)/示例动画 (2001).mkv',
      proposedPath: '影视资源/电影/示例动画 (2001)/示例动画 (2001).mkv',
    },
  ],
}

const blockedPlan = {
  planId: 'plan-test-blocked',
  scope: { target: '电影/示例影片 (2018)' },
  summary: { total: 2, changed: 1, skip: 0, conflict: 1, unknown: 0, outOfScope: 0 },
  items: [
    {
      status: 'CONFLICT',
      currentPath: '影视资源/电影/示例影片 (2018)/示例影片.2018.1080p.mkv',
      proposedPath: '影视资源/电影/示例影片 (2018)/示例影片 (2018).mkv',
    },
  ],
}

const cleanPath = path.join(OUT_DIR, 'plan-clean.json')
const blockedPath = path.join(OUT_DIR, 'plan-blocked.json')
writeFileSync(cleanPath, `${JSON.stringify(cleanPlan, null, 2)}\n`, 'utf8')
writeFileSync(blockedPath, `${JSON.stringify(blockedPlan, null, 2)}\n`, 'utf8')

// ── 1) 干净计划：应正确推导操作，且说明是离线模式 ──
const clean = run(['--plan', cleanPath, '--explain'])
check('干净计划退出码为 0', clean.code === 0, `code=${clean.code}`)
check('只统计 CHANGED（跳过 SKIP）', clean.stdout.includes('将执行的操作：2 条'), clean.stdout.slice(0, 200))
check('识别同目录改名', clean.stdout.includes('改名 -> 示例电影 (2024).mkv'))
check('识别需要新建目录', clean.stdout.includes('建目录 Season 01'))
check('识别移动 + 改名', /建目录 Season 01 \/ 移动 \/ 改名/.test(clean.stdout))
check('说明离线不写入', clean.stdout.includes('不联网、不写入任何内容'))

// ── 2) 有冲突的计划：必须拒绝执行 ──
const blocked = run(['--plan', blockedPath, '--explain'])
check('存在 conflict 时拒绝执行（退出码 2）', blocked.code === 2, `code=${blocked.code}`)
check('拒绝时给出明确原因', blocked.stdout.includes('拒绝执行'), blocked.stdout.slice(-200))

// ── 3) 缺 --cookies 时（非 explain 模式）必须拦住 ──
const noCookies = run(['--plan', cleanPath])
check('非 explain 模式缺凭据时拦住（退出码 1）', noCookies.code === 1, `code=${noCookies.code}`)
check('缺凭据提示可看 --explain', noCookies.stdout.includes('--explain'))

let failed = 0
for (const item of checks) {
  if (!item.ok) failed += 1
  console.log(`[${item.ok ? 'OK' : 'FAIL'}] ${item.name}${item.ok || !item.detail ? '' : ` -> ${item.detail.replace(/\n/g, ' ').slice(0, 200)}`}`)
}
console.log('='.repeat(60))
console.log(`checks=${checks.length} passed=${checks.length - failed} failed=${failed}`)
process.exit(failed === 0 ? 0 : 1)
