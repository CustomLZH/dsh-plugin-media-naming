/**
 * 存储后端统一入口：115 网盘 / 本地文件系统（含已挂载的 NAS、Linux 挂载点）。
 *
 * 两个后端产出**完全相同的结构**（`{rootPath, files, existingByDir, scanned, truncated}`），
 * 因此命名引擎、计划格式、审核清单、安全闸门都不需要知道数据到底在网盘还是本地盘上。
 *
 * 后端选择：显式配置（`storage: local|115`）优先，否则按路径自动判断——
 * 盘符 `G:\`、UNC `\\NAS\`、绝对路径 `/mnt/...` 走本地，其余走 115。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { runApply, runScan } from './bridge.js'
import { plansDir } from './config.js'
import { applyLocalPlan, isLocalPath, scanLocal } from './local-storage.js'

export const STORAGE_LOCAL = 'local'
export const STORAGE_115 = '115'
const SCAN_TIMEOUT_MS = 240000

/** 按配置与路径决定用哪个后端。 */
export function resolveStorage(settings = {}, target = '') {
  const configured = String(settings?.storage ?? '').trim().toLowerCase()
  if (configured === STORAGE_LOCAL || configured === STORAGE_115) return configured
  return isLocalPath(target) ? STORAGE_LOCAL : STORAGE_115
}

/** 只读扫描：本地走 Node，115 走脚本；两者返回同样形状。 */
export async function scanTarget(ctx, config, settings, { target, limit, signal } = {}) {
  const storage = resolveStorage(settings, target)
  if (storage === STORAGE_LOCAL) {
    return scanLocal(target, { limit })
  }
  if (!settings?.cookiesPath) {
    throw new Error('扫描 115 需要登录凭据：请先运行 python/login_115.py 扫码登录（之后所有会话共用）。')
  }
  return runScan(ctx, { ...config, pythonPath: settings.pythonPath }, {
    path: target,
    root: settings.root || '',
    limit,
    cookiesPath: settings.cookiesPath,
  }, { signal, timeoutMs: SCAN_TIMEOUT_MS })
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/** 本地执行结果的 state / 回滚清单落盘，格式与 115 后端保持一致。 */
function persistLocalRecords(result, workDir, apply) {
  const dir = workDir || plansDir()
  mkdirSync(dir, { recursive: true })
  const statePath = path.join(dir, 'apply-state.json')
  const rollbackPath = path.join(dir, 'rollback.json')
  if (!apply) return { statePath, rollbackPath }

  const previous = readJsonSafe(rollbackPath)
  const items = [...(previous.items ?? []), ...result.rollback]
  writeFileSync(rollbackPath, `${JSON.stringify({ createdAt: new Date().toISOString(), items }, null, 2)}\n`, 'utf8')
  writeFileSync(statePath, `${JSON.stringify({
    done: items.map((one) => `${one.from} -> ${one.to}`),
    failed: result.failed,
  }, null, 2)}\n`, 'utf8')
  return { statePath, rollbackPath }
}

/**
 * 执行计划：本地走纯 Node，115 走 Python 脚本。
 * 回滚同样支持（按 rollback.json 反向操作，只 rename、不删除）。
 */
export async function applyPlan(ctx, config, settings, {
  planPath, plan, apply = true, rollback = false, workDir, signal,
} = {}) {
  const storageHint = plan?.scope?.storage
  const storage = storageHint === STORAGE_LOCAL || storageHint === STORAGE_115
    ? storageHint
    : resolveStorage(settings, plan?.scope?.rootPath ?? '')

  if (storage === STORAGE_LOCAL) {
    if (rollback) return rollbackLocalPlan(workDir, { apply })
    const result = applyLocalPlan(plan ?? {}, { apply })
    const records = persistLocalRecords(result, workDir, apply)
    return {
      ok: result.ok,
      planId: plan?.planId,
      storage: STORAGE_LOCAL,
      dryRun: !apply,
      executed: result.executed,
      directoriesExecuted: result.directoriesExecuted,
      moved: result.moved,
      skipped: result.skipped,
      failed: result.failed,
      total: result.executed + result.directoriesExecuted,
      ...records,
    }
  }

  if (!settings?.cookiesPath) {
    throw new Error('执行 115 上的计划需要登录凭据：请先运行 python/login_115.py 扫码登录（之后所有会话共用）。')
  }

  return runApply(ctx, { ...config, pythonPath: settings?.pythonPath }, {
    planPath,
    cookiesPath: settings?.cookiesPath,
    apply,
    rollback,
    workDir,
  }, { signal })
}

/** 本地回滚：按 rollback.json 反向改名（只 rename，不删除任何东西）。 */
export function rollbackLocalPlan(workDir, { apply = true } = {}) {
  const dir = workDir || plansDir()
  const rollbackPath = path.join(dir, 'rollback.json')
  const record = readJsonSafe(rollbackPath)
  const items = [...(record.items ?? [])].reverse()
  if (items.length === 0) {
    return { ok: false, reason: 'no-rollback', message: `没有回滚记录：${rollbackPath}`, rollbackPath }
  }
  const result = applyLocalPlan({
    items: items.map((one) => ({ status: 'CHANGED', currentPath: one.from, proposedPath: one.to })),
    directories: [],
  }, { apply })
  return {
    ok: result.ok,
    storage: STORAGE_LOCAL,
    dryRun: !apply,
    restored: result.executed,
    failed: result.failed,
    rollbackPath,
  }
}
