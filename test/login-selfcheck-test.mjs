/**
 * 扫码登录脚本的离线自检：跑 `login_115.py --self-check`。
 *
 * 自检不联网，只验证环境（依赖是否可导入、配置目录能否写入）；
 * 真正扫码需要使用者用手机操作，无法自动测试。
 *
 * 运行：node test/login-selfcheck-test.mjs
 *      （可用环境变量 MEDIA_NAMING_PYTHON 指定解释器，默认 `python`）
 * 退出码：全部通过为 0，否则为 1。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, '..')
const PYTHON = process.env.MEDIA_NAMING_PYTHON || 'python'
const SCRIPT = path.join(PLUGIN_DIR, 'python', 'login_115.py')

const checks = []
const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail })

// 用临时 DSH_HOME，避免污染真实配置目录
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'media-naming-login-'))
let output = ''
let code = 0
try {
  output = execFileSync(PYTHON, ['-u', SCRIPT, '--self-check'], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, DSH_HOME: sandbox },
  })
} catch (error) {
  code = error.status ?? -1
  output = `${error.stdout ?? ''}${error.stderr ?? ''}`
}

check('自检可运行（0=全部通过，1=有缺项，均属正常）', code === 0 || code === 1, `code=${code} ${output.slice(0, 200)}`)
check('检查了 p115client', output.includes('p115client'))
check('检查了 qrcode 库', output.includes('qrcode'))
check('检查了配置目录可写', output.includes('配置目录可写'))
check('在临时 DSH_HOME 下工作，不污染真实配置', output.includes(sandbox), output.slice(0, 200))
check('告知凭据与配置的写入位置', output.includes('凭据将写入') && output.includes('配置将更新'))

rmSync(sandbox, { recursive: true, force: true })

let failed = 0
for (const item of checks) {
  if (!item.ok) failed += 1
  console.log(`[${item.ok ? 'OK' : 'FAIL'}] ${item.name}${item.ok || !item.detail ? '' : ` -> ${item.detail.replace(/\n/g, ' ')}`}`)
}
console.log('='.repeat(60))
console.log(`checks=${checks.length} passed=${checks.length - failed} failed=${failed}`)
if (code === 1) console.log('（提示：退出码 1 表示环境有缺项，见上面的 ✗ 行；补齐后扫码即可用）')
process.exit(failed === 0 ? 0 : 1)
