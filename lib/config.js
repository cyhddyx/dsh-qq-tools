// QQ 工具配置：路径、默认值、读写，以及群/私聊白名单。

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CFG_PATH = join(DSH_HOME, 'qq-tools-config.json')
const DIAG_PATH = join(DSH_HOME, 'qq-tools-diag.log')

const DEFAULT_GROUPS = []
const DEFAULT_CFG = {
  napCat: 'http://127.0.0.1:3000',
  accessToken: '',
  targetSession: '',
  groups: DEFAULT_GROUPS,
  historyCount: 30,
  maxHistoryCount: 50,
  pollMs: 5000,
  mentionEnabled: true,
  wsUrl: 'ws://127.0.0.1:3001',
  pokeEnabled: true,
  privateEnabled: true,
  privateUsers: [],
  observationMs: 60000,
  timeoutMs: 6000,
}

export function diag(msg) {
  try {
    appendFileSync(DIAG_PATH, new Date().toISOString() + '  ' + msg + '\n', 'utf8')
  } catch (error) {}
}

export function ensureCfg() {
  try {
    if (existsSync(CFG_PATH)) return
    mkdirSync(DSH_HOME, { recursive: true })
    writeFileSync(CFG_PATH, JSON.stringify(DEFAULT_CFG, null, 2), 'utf8')
    diag('已创建配置：' + CFG_PATH)
  } catch (error) {}
}

export function loadCfg() {
  try {
    const raw = JSON.parse(readFileSync(CFG_PATH, 'utf8'))
    const out = { ...DEFAULT_CFG, ...(raw && typeof raw === 'object' ? raw : {}) }
    out.groups = Array.isArray(out.groups) ? out.groups.map((x) => Number(x)).filter(Number.isFinite) : DEFAULT_GROUPS
    out.napCat = String(out.napCat || DEFAULT_CFG.napCat).replace(/\/+$/, '')
    out.historyCount = Math.max(1, Math.min(Number(out.historyCount) || 30, Number(out.maxHistoryCount) || 50))
    out.maxHistoryCount = Math.max(out.historyCount, Math.min(Number(out.maxHistoryCount) || 50, 100))
    out.pollMs = Math.max(2000, Math.min(Number(out.pollMs) || 5000, 60000))
    out.timeoutMs = Math.max(1000, Math.min(Number(out.timeoutMs) || 6000, 15000))
    out.mentionEnabled = out.mentionEnabled !== false
    out.wsUrl = String(out.wsUrl || DEFAULT_CFG.wsUrl)
    out.pokeEnabled = out.pokeEnabled !== false
    out.privateEnabled = out.privateEnabled !== false
    out.privateUsers = Array.isArray(out.privateUsers) ? out.privateUsers.map((x) => Number(x)).filter(Number.isFinite) : []
    out.observationMs = Math.max(30000, Math.min(Number(out.observationMs) || 60000, 600000))
    return out
  } catch (error) {
    return { ...DEFAULT_CFG }
  }
}

// UI 保存挂载会话时只覆盖传进来的字段，其余配置原样保留；先写临时文件再换名，
// 避免写一半留下坏 JSON 让后面所有工具都退回默认配置。
export function saveCfg(patch) {
  ensureCfg()
  let current = {}
  try {
    const raw = JSON.parse(readFileSync(CFG_PATH, 'utf8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) current = raw
  } catch (error) {}
  const next = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) }
  try {
    mkdirSync(DSH_HOME, { recursive: true })
    const tmp = CFG_PATH + '.tmp'
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, CFG_PATH)
  } catch (error) {
    diag('保存配置失败：' + String((error && error.message) || error))
    throw error
  }
  return next
}

export function allowedGroup(groupId, cfg) {
  if (!Array.isArray(cfg.groups) || cfg.groups.length === 0) return true
  return cfg.groups.includes(Number(groupId))
}

export function allowedPrivate(userId, cfg) {
  if (!Array.isArray(cfg.privateUsers) || cfg.privateUsers.length === 0) return true
  return cfg.privateUsers.includes(Number(userId))
}
