/**
 * JS 规则引擎验收：直接读规则包的 `examples.json`（与 Agent 看到的样例同一份数据），
 * 并额外验证「换一套规则包就能换一套库结构」——这是插件通用性的核心。
 *
 * 运行：node test/engine-test.mjs [P1 E3 ...]
 * 退出码：全部通过为 0，否则为 1。
 */
import { parsePath } from '../lib/parse.js'
import { plan } from '../lib/plan.js'
import { loadExamples, loadRulePack } from '../lib/rules.js'

const pack = loadRulePack()
const { examples } = loadExamples(pack.id)

const wanted = new Set(process.argv.slice(2).map((arg) => arg.toUpperCase()))
let failed = 0
let total = 0

console.log('='.repeat(72))
for (const example of examples) {
  if (wanted.size > 0 && !wanted.has(example.id)) continue
  total += 1
  const result = plan(example.inputs, { pack, existingByDir: example.existingByDir })
  const mismatches = []
  example.expects.forEach((expect, index) => {
    const item = result.items[index]
    if (!item) {
      mismatches.push(`第 ${index + 1} 条缺失`)
      return
    }
    if (item.status !== expect.status) mismatches.push(`状态 ${item.status} ≠ ${expect.status}`)
    if ((item.proposedPath ?? '') !== (expect.path ?? '')) {
      mismatches.push(`目标 ${item.proposedPath} ≠ ${expect.path}`)
    }
  })
  const ok = mismatches.length === 0
  if (!ok) failed += 1

  console.log(`[${ok ? 'OK' : 'FAIL'}] ${example.id}（${example.kind}）${example.title}`)
  console.log(`    输入  : ${example.inputs[0]}${example.inputs.length > 1 ? ` （共 ${example.inputs.length} 条）` : ''}`)
  result.items.forEach((item, index) => {
    console.log(`    结果  : ${item.status}${item.proposedPath ? ` → ${item.proposedPath}` : ''}`)
    if (!ok) {
      console.log(`    期望  : ${example.expects[index]?.status} → ${example.expects[index]?.path || '（不处理）'}`)
      if (item.reason) console.log(`    原因  : ${item.reason}`)
    }
  })
  console.log()
}

console.log('='.repeat(72))
console.log(`规则包 ${pack.id} · examples=${total} passed=${total - failed} failed=${failed}`)
console.log('')

// ── 通用性验收：换一套规则包，目录结构与排除项随之改变，代码不用动 ──
const customPack = {
  ...pack,
  id: 'custom-demo',
  title: '自定义演示规则包',
  rootPrefix: '媒体库',
  libraries: [{ match: '我的剧集', mediaType: 'tv' }],
  excluded: ['待整理'],
  videoExtensions: ['.mkv', '.mp4'],
}

const genericChecks = [
  {
    name: '自定义根目录 + 自定义库名 + 自定义排除',
    inputs: [
      '媒体库/我的剧集/某剧 (2020)/某剧.第01集.mkv',
      '媒体库/待整理/随便一个.mkv',
    ],
    expects: [
      { status: 'CHANGED', path: '媒体库/我的剧集/某剧 (2020)/Season 01/某剧 S01E01.mkv' },
      { status: 'OUT_OF_SCOPE', path: '' },
    ],
  },
  {
    name: '自定义扩展名白名单（.iso 不在其中）',
    inputs: ['媒体库/我的剧集/某剧 (2020)/某剧.第01集.iso'],
    expects: [{ status: 'OUT_OF_SCOPE', path: '' }],
  },
]

for (const testCase of genericChecks) {
  total += 1
  const result = plan(testCase.inputs, { pack: customPack })
  const mismatches = []
  testCase.expects.forEach((expect, index) => {
    const item = result.items[index]
    if (!item || item.status !== expect.status) mismatches.push(`第${index + 1}条状态 ${item?.status} ≠ ${expect.status}`)
    else if ((item.proposedPath ?? '') !== expect.path) mismatches.push(`第${index + 1}条目标 ${item.proposedPath} ≠ ${expect.path}`)
  })
  const ok = mismatches.length === 0
  if (!ok) failed += 1
  console.log(`[${ok ? 'OK' : 'FAIL'}] 通用性：${testCase.name}`)
  result.items.forEach((item) => console.log(`    ${item.status} → ${item.proposedPath || item.reason}`))
  if (!ok) console.log(`    ${mismatches.join('; ')}`)
}

// ── 作品目录名也要规范化（使用者处理的是「这一个节目目录 + 目录下的视频」） ──
const directoryCases = [
  {
    name: '目录名里的技术标签被清理、年份补半角括号',
    paths: ['影视资源/电影/示例电影 2024 2160p/示例电影.2024.2160p.mkv'],
    expect: { status: 'CHANGED', name: '示例电影 (2024)' },
  },
  {
    name: '目录名全角括号归一化为半角',
    paths: ['影视资源/电影/示例动画（2001）/示例动画（2001）.mkv'],
    expect: { status: 'CHANGED', name: '示例动画 (2001)' },
  },
  {
    name: '站点广告与整串技术标签的目录名被清理',
    paths: [
      '影视资源/电视剧/【发布页 www.example.com】示例剧名[全26集][国语配音].Sample.Show.S01.2026.2160p.WEB-DL.H265-Group/Sample.Show.S01E01.2026.2160p.WEB-DL.H265-Group.mkv',
    ],
    expect: { status: 'CHANGED', name: '示例剧名 (2026)' },
  },
]

for (const testCase of directoryCases) {
  total += 1
  const result = plan(testCase.paths, { pack })
  const entry = result.directories?.[0]
  const ok = entry?.status === testCase.expect.status && entry?.proposedName === testCase.expect.name
  if (!ok) failed += 1
  console.log(`[${ok ? 'OK' : 'FAIL'}] 目录：${testCase.name}`)
  console.log(`    ${entry?.currentName}  →  ${entry?.proposedName}（${entry?.status}）`)
  if (!ok) console.log(`    期望：${testCase.expect.status} / ${testCase.expect.name}`)
}

// 纯解析接口冒烟：确认 parsePath 可被直接复用
const parsed = parsePath('影视资源/电视剧/示例剧集 (2021)/示例剧集 S01E05.mp4', { pack })
const parseOk = parsed.title === '示例剧集' && parsed.year === 2021 && parsed.season === 1 && parsed.episode === 5
console.log(`[${parseOk ? 'OK' : 'FAIL'}] parsePath 直接调用：${JSON.stringify({ title: parsed.title, year: parsed.year, season: parsed.season, episode: parsed.episode })}`)
if (!parseOk) failed += 1

console.log('='.repeat(72))
console.log(`checks passed=${total - failed} failed=${failed}`)
process.exit(failed === 0 ? 0 : 1)
