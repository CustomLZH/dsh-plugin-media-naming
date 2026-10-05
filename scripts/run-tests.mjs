/**
 * 一键跑完全部测试：`npm test`（或 `node scripts/run-tests.mjs`）。
 *
 * - JS 测试用当前 node 跑；
 * - Python 测试用 `MEDIA_NAMING_PYTHON`，未设置时退回 `python` / `python3`；
 *   找不到 Python 时**跳过而不是失败**（只处理本机 / NAS 的用法本就不需要 Python）。
 * - 子进程直接继承 stdio，逐条输出，最后给汇总与退出码。
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PYTHON = process.env.MEDIA_NAMING_PYTHON
  || (process.platform === 'win32' ? 'python' : 'python3')

const SUITES = [
  { name: 'engine         命名引擎与规则样例', cmd: process.execPath, args: ['test/engine-test.mjs'] },
  { name: 'local-storage  本地 / NAS 后端', cmd: process.execPath, args: ['test/local-storage-test.mjs'] },
  { name: 'quick-flow     计划落盘与免路径调用', cmd: process.execPath, args: ['test/quick-flow-test.mjs'] },
  { name: 'plugin-smoke   12 个工具与安全闸门', cmd: process.execPath, args: ['test/plugin-smoke.mjs'] },
  { name: 'schema-check   工具 schema 校验', cmd: process.execPath, args: ['test/schema-check.mjs'] },
  { name: 'apply-explain  执行动作推导', cmd: process.execPath, args: ['test/apply-explain-test.mjs'] },
  { name: 'login-selfcheck 登录脚本自检（不联网）', cmd: process.execPath, args: ['test/login-selfcheck-test.mjs'] },
  { name: 'entry-id       115 字段判据（Python）', cmd: PYTHON, args: ['-u', 'test/entry-id-test.py'], needsPython: true },
  { name: 'operation-plan 动作判定（Python）', cmd: PYTHON, args: ['-u', 'test/operation-plan-test.py'], needsPython: true },
]

let passed = 0
let failed = 0
let skipped = 0

for (const suite of SUITES) {
  const started = Date.now()
  const run = spawnSync(suite.cmd, suite.args, { cwd: ROOT, stdio: 'inherit' })
  const missingRuntime = run.error?.code === 'ENOENT'
  const cost = Date.now() - started
  const label = suite.name.padEnd(46)

  if (run.status === 0) {
    passed += 1
    console.log(`✓ ${label} ${cost} ms`)
  } else if (missingRuntime && suite.needsPython) {
    skipped += 1
    console.log(`－ ${label} 跳过（未找到 Python：${suite.cmd}）`)
  } else {
    failed += 1
    console.log(`✗ ${label} ${cost} ms（exit=${run.status ?? 'null'}）`)
  }
}

console.log('='.repeat(72))
console.log(`测试套件：${SUITES.length} 通过 ${passed} 失败 ${failed}${skipped ? ` 跳过 ${skipped}` : ''}`)
if (skipped) {
  console.log('提示：设置环境变量 MEDIA_NAMING_PYTHON 指向你的 python.exe 即可跑全部用例。')
}
process.exit(failed === 0 ? 0 : 1)
