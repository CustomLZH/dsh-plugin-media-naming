/**
 * 离线重算：读扫描结果 JSON，用插件内置引擎生成计划与审核清单。
 *
 * 用途：宿主还没重载插件代码时，也可以用同一套规则算出结果（纯本地，不联网）。
 * 用法：node scripts/make-plan.mjs <扫描结果.json> <计划输出.json>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { plan } from '../lib/plan.js'
import { buildReview, renderReview } from '../lib/review.js'
import { loadRulePack } from '../lib/rules.js'

const [scanPath, outPath] = process.argv.slice(2)
if (!scanPath || !outPath) {
  console.error('用法：node scripts/make-plan.mjs <扫描结果.json> <计划输出.json> [--no-season-folder]')
  process.exit(1)
}
// --no-season-folder：不建 Season 子目录，文件直接放在作品目录下
const seasonFolder = !process.argv.includes('--no-season-folder')

// PowerShell 捕获子进程输出时可能带 BOM，这里统一剥掉再解析
const scan = JSON.parse(readFileSync(scanPath, 'utf8').replace(/^\uFEFF/, ''))
const data = scan.data ?? scan
const pack = loadRulePack()

const result = plan(data.files ?? [], { pack, existingByDir: data.existingByDir ?? {}, seasonFolder })
const payload = {
  planId: `plan-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`,
  generatedAt: new Date().toISOString(),
  scope: { pack: pack.id, target: '', rootPath: data.rootPath ?? '', source: 'scan' },
  summary: result.summary,
  items: result.items,
  directories: result.directories,
}

writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
const review = buildReview(payload)
const reviewPath = outPath.replace(/\.json$/, '.review.md')
writeFileSync(reviewPath, `${renderReview(review, 60)}\n`, 'utf8')

console.log(renderReview(review, 60))
console.log('')
console.log(`计划：${path.resolve(outPath)}`)
console.log(`清单：${path.resolve(reviewPath)}`)
