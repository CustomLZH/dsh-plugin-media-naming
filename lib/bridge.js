/**
 * 插件内 Python 方法的调用桥接。
 *
 * 只有两件事需要外部 Python：**只读扫描**与**执行改名/移动**（以及扫码登录，由使用者自己跑）。
 * 解析与计划全部在内置 JS 引擎完成，因此不装 Python 也能用插件的命名能力。
 *
 * 优先使用 Host 的 `subprocess` 服务（受宿主策略管辖、可被观测），
 * 不可用或用法有差异时回退 `node:child_process`。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SCAN_SCRIPT = path.join(PLUGIN_DIR, 'python', 'scan_115.py')
const APPLY_SCRIPT = path.join(PLUGIN_DIR, 'python', 'apply_115.py')

const SCAN_TIMEOUT_MS = 240000
const APPLY_TIMEOUT_MS = 900000
const STDOUT_MAX_BYTES = 16 * 1024 * 1024
const STDERR_MAX_BYTES = 4 * 1024 * 1024

export class BridgeError extends Error {
  /** @param {string} code 稳定错误码，供工具层翻译成可读提示 */
  constructor(code, message) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

/** 超时与正常结束竞争，避免子进程悬挂时工具永不返回。 */
function withTimeout(work, onTimeout, timeoutMs, what) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout()
      reject(new BridgeError('TIMEOUT', `${what}超过 ${timeoutMs} ms 未返回，已终止子进程`))
    }, timeoutMs)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

async function viaService(service, { argv, cwd, timeoutMs, signal, what }) {
  const handle = service.spawn({
    argv,
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: STDOUT_MAX_BYTES },
      stderr: { maxBytes: STDERR_MAX_BYTES },
    },
    graceMs: 3000,
    signal,
  })
  const outcome = await withTimeout(handle.done, () => handle.terminate(), timeoutMs, what)
  return {
    stdout: handle.collected.stdout?.readFrom(0).text ?? '',
    stderr: handle.collected.stderr?.readFrom(0).text ?? '',
    exitCode: outcome.exitCode,
  }
}

function viaChildProcess({ argv, cwd, timeoutMs, signal, what }) {
  return new Promise((resolve, reject) => {
    const [command, ...args] = argv
    let child
    try {
      child = nodeSpawn(command, args, { cwd, windowsHide: true, signal, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(new BridgeError('SPAWN_FAILED', `无法启动 Python：${error.message}`))
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new BridgeError('TIMEOUT', `${what}超过 ${timeoutMs} ms 未返回，已终止子进程`))
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new BridgeError('SPAWN_FAILED', `无法启动 Python：${error.message}`))
    })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode })
    })
  })
}

/** 先试宿主 subprocess 服务，失败则回退 node 子进程（回退条件刻意放宽）。 */
async function attempt(ctx, call) {
  const service = typeof ctx?.get === 'function' ? ctx.get('subprocess') : undefined
  if (!service) return viaChildProcess(call)
  try {
    const result = await viaService(service, call)
    if ((result.stdout || '').trim()) return result
  } catch (error) {
    if (error instanceof BridgeError && error.code === 'TIMEOUT') throw error
  }
  return viaChildProcess(call)
}

/** 统一执行一个插件内脚本，并把 stdout 的 JSON 解回来。 */
async function runScript(ctx, config, { script, argv, timeoutMs, signal, what }) {
  const fullArgv = [config.pythonPath || 'python', '-u', script, ...argv]
  const result = await attempt(ctx, {
    argv: fullArgv,
    cwd: PLUGIN_DIR,
    timeoutMs,
    signal,
    what,
  })

  const stdout = (result.stdout || '').trim()
  if (!stdout) {
    const tail = (result.stderr || '').trim().slice(-800)
    throw new BridgeError(
      'EMPTY_OUTPUT',
      `${what}没有输出（exit=${result.exitCode}）。${tail ? `stderr：${tail}` : ''}`
      + ' 常见原因：pythonPath 指向的解释器不存在，或未安装所需依赖。',
    )
  }
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new BridgeError('BAD_JSON', `${what}输出不是合法 JSON：${error.message}`)
  }
  if (parsed.ok === false) {
    // 兼容两种失败结构：脚本层的 {reason, message} 与桥接层的 {error: {code, message}}。
    // 少了这层兼容，Python 抛出的真实原因（如 HTTP 405）会被吞成一句「扫描失败」。
    const failure = parsed.error ?? {}
    const code = parsed.reason || failure.code || 'SCRIPT_FAILED'
    const message = parsed.message || failure.message || `${what}失败`
    throw new BridgeError(code, message)
  }
  return parsed.data ?? parsed
}

/**
 * 只读扫描网盘目录。
 * @param {object} params cookiesPath / path / root / limit
 */
export function runScan(ctx, config, params, options = {}) {
  return runScript(ctx, config, {
    script: SCAN_SCRIPT,
    argv: [
      params.cookiesPath ?? '',
      params.path ?? '',
      params.root ?? '',
      String(params.limit ?? 500),
    ],
    timeoutMs: options.timeoutMs ?? SCAN_TIMEOUT_MS,
    signal: options.signal,
    what: '扫描',
  })
}

/**
 * 按计划执行改名 / 移动（写操作）。
 *
 * 调用方（工具层）必须已经完成「计划校验」与「用户确认」两道闸门；
 * 脚本自身也会再校验一次计划是否干净，作为第二道防线。
 * @param {object} params planPath / cookiesPath / apply / rollback / workDir
 */
export function runApply(ctx, config, params, options = {}) {
  const argv = ['--plan', params.planPath ?? '', '--cookies', params.cookiesPath ?? '', '--json']
  if (params.rollback) argv.push('--rollback')
  else if (params.apply) argv.push('--apply')
  if (params.workDir) argv.push('--work-dir', params.workDir)

  return runScript(ctx, config, {
    script: APPLY_SCRIPT,
    argv,
    timeoutMs: options.timeoutMs ?? APPLY_TIMEOUT_MS,
    signal: options.signal,
    what: params.rollback ? '回滚' : '执行',
  })
}
