/**
 * dsh-cloudflare-codemode — Host half.
 *
 * Design
 * ------
 * This plugin never wraps Cloudflare API endpoints. All capability comes from
 * Cloudflare's official Code Mode MCP server (https://mcp.cloudflare.com/mcp),
 * which exposes `search` + `execute` over 2,500+ REST endpoints.
 *
 * The MCP protocol itself is owned by the shipped `@deepseek-ai/dsh-mcp-client`
 * row in `cordis.patch.yml`. That row points at THIS plugin's localhost proxy,
 * which does exactly one job: attach the current credential to every request.
 *
 *   mcp-client ──► http://127.0.0.1:<port>/mcp ──► https://mcp.cloudflare.com/mcp
 *                        (this plugin injects Authorization)
 *
 * Why a proxy instead of putting the token in the loader config:
 *  - the token must never be written to `cordis.patch.yml` (loader config is a
 *    plain file that gets shared in bug reports);
 *  - a proxy re-reads the credential per request, so saving a new token in the
 *    panel takes effect immediately, with no restart and no config rewrite;
 *  - OAuth access tokens can be refreshed inside the proxy, transparently to
 *    the MCP client.
 *
 * This file deliberately imports ONLY Node built-ins. A profile install does not
 * give a third-party plugin access to `@deepseek-ai/*`, so any runtime import of
 * one would fail to resolve (see dsh-github-connect's note on the same issue).
 *
 * @module dsh-cloudflare-codemode
 */

import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

// ── constants ───────────────────────────────────────────────────────────────

const PLUGIN = 'dsh-cloudflare-codemode'
const UPSTREAM = 'https://mcp.cloudflare.com/mcp'
const AUTHORIZE = 'https://mcp.cloudflare.com/authorize'
const TOKEN = 'https://mcp.cloudflare.com/token'
const REGISTER = 'https://mcp.cloudflare.com/register'
const RESOURCE_META = 'https://mcp.cloudflare.com/.well-known/oauth-protected-resource/mcp'
const PROTOCOL_VERSION = '2025-06-18'
const DEFAULT_PORT = 18923
const ROUTE_PREFIX = '/cloudflare-codemode'

/** Request headers forwarded upstream (everything else is dropped). */
const FORWARD_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
]

/** Response headers copied back to the MCP client. */
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'mcp-session-id',
  'cache-control',
]

const CONFIG_FILE = path.join(homedir(), '.dsh', `${PLUGIN}.json`)

// ── credentials ─────────────────────────────────────────────────────────────

/** Cached config + its mtime, so a panel save is picked up without a restart. */
let cached = null
let cachedStamp = -1

async function loadConfig(force = false) {
  try {
    const raw = await readFile(CONFIG_FILE, 'utf8')
    const stamp = raw.length
    if (!force && stamp === cachedStamp && cached !== null) return cached
    const parsed = JSON.parse(raw)
    cached = normalizeConfig(parsed)
    cachedStamp = stamp
    return cached
  } catch {
    cached = normalizeConfig({})
    cachedStamp = 0
    return cached
  }
}

function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    authMode: config.authMode === 'oauth' ? 'oauth' : 'token',
    accountId: typeof config.accountId === 'string' ? config.accountId : '',
    apiToken: typeof config.apiToken === 'string' ? config.apiToken : '',
    oauth: config.oauth !== null && typeof config.oauth === 'object' ? config.oauth : null,
    updatedAt: typeof config.updatedAt === 'string' ? config.updatedAt : '',
  }
}

async function saveConfig(config) {
  const next = { ...config, updatedAt: new Date().toISOString() }
  await mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  const temp = `${CONFIG_FILE}.tmp`
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, CONFIG_FILE)
  cached = normalizeConfig(next)
  cachedStamp = -1
  return cached
}

/**
 * Resolve the Bearer credential for the next upstream request, refreshing an
 * expired OAuth access token in place when possible.
 */
async function currentCredential() {
  const config = await loadConfig()
  if (config.authMode === 'oauth') {
    const oauth = config.oauth
    if (oauth === null || typeof oauth.accessToken !== 'string' || oauth.accessToken === '') {
      throw new CredentialError('OAuth 尚未授权：请在设置面板点“开始 OAuth 授权”。')
    }
    const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : 0
    if (expiresAt !== 0 && Date.now() > expiresAt - 60_000) {
      const refreshed = await refreshOAuth(config)
      if (refreshed !== null) return refreshed
      throw new CredentialError('OAuth 访问令牌已过期且刷新失败：请重新授权。')
    }
    return oauth.accessToken
  }
  if (config.apiToken === '') {
    throw new CredentialError('尚未填写 API Token：请在设置面板填入 Account ID 与 Token。')
  }
  return config.apiToken
}

class CredentialError extends Error {}

async function refreshOAuth(config) {
  const oauth = config.oauth
  if (oauth === null || typeof oauth.refreshToken !== 'string' || oauth.refreshToken === '') return null
  try {
    const res = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: String(oauth.clientId ?? ''),
      }).toString(),
    })
    if (!res.ok) return null
    const json = await res.json()
    if (typeof json.access_token !== 'string') return null
    await saveConfig({
      ...config,
      oauth: {
        ...oauth,
        accessToken: json.access_token,
        refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : oauth.refreshToken,
        expiresAt: typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : 0,
      },
    })
    return json.access_token
  } catch {
    return null
  }
}

// ── MCP handshake probe ─────────────────────────────────────────────────────

/** Parse a JSON or SSE MCP response body into the JSON-RPC payload. */
function parseRpcPayload(contentType, text) {
  if (contentType !== null && contentType.includes('text/event-stream')) {
    const frames = []
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('data:')) frames.push(line.slice(5).trim())
    }
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      if (frames[i] === '' || frames[i] === '[DONE]') continue
      try {
        const parsed = JSON.parse(frames[i])
        if (parsed !== null && typeof parsed === 'object') return parsed
      } catch {
        /* keep looking */
      }
    }
    return null
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Run one JSON-RPC round trip through the upstream endpoint with an explicit
 * credential — used by the panel's "保存并测试连接" button.
 */
async function rpc(credential, sessionId, payload) {
  const headers = {
    authorization: `Bearer ${credential}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL_VERSION,
  }
  if (sessionId !== null) headers['mcp-session-id'] = sessionId
  const res = await fetch(UPSTREAM, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45_000),
  })
  const nextSession = res.headers.get('mcp-session-id')
  const text = await res.text()
  if (!res.ok) {
    return { ok: false, status: res.status, sessionId: nextSession, body: null, text }
  }
  return {
    ok: true,
    status: res.status,
    sessionId: nextSession === null ? sessionId : nextSession,
    body: parseRpcPayload(res.headers.get('content-type'), text),
    text,
  }
}

/**
 * Probe a credential end to end: initialize → notifications/initialized →
 * tools/list. Returns the discovered tool names, which for Cloudflare Code Mode
 * are exactly `search` and `execute`.
 */
async function probe(credential) {
  const init = await rpc(credential, null, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: PLUGIN, version: '1.0.0' },
    },
  })
  if (!init.ok) {
    return {
      ok: false,
      stage: 'initialize',
      status: init.status,
      error: describeUpstreamFailure(init.status, init.body, init.text),
    }
  }
  const sessionId = init.sessionId
  await rpc(credential, sessionId, { jsonrpc: '2.0', method: 'notifications/initialized' }).catch(
    () => undefined,
  )
  const list = await rpc(credential, sessionId, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  if (!list.ok) {
    return {
      ok: false,
      stage: 'tools/list',
      status: list.status,
      error: describeUpstreamFailure(list.status, list.body, list.text),
    }
  }
  const tools =
    list.body !== null && list.body.result !== undefined && Array.isArray(list.body.result.tools)
      ? list.body.result.tools
      : []
  const serverInfo =
    init.body !== null && init.body.result !== undefined && init.body.result.serverInfo !== undefined
      ? init.body.result.serverInfo
      : null
  return {
    ok: true,
    serverInfo,
    tools: tools.map((tool) => ({
      name: typeof tool?.name === 'string' ? tool.name : '',
      description: typeof tool?.description === 'string' ? tool.description.slice(0, 400) : '',
    })),
  }
}

function describeUpstreamFailure(status, body, text) {
  const rpcMessage =
    body !== null && typeof body === 'object' && body.error !== undefined && body.error !== null
      ? String(body.error.message ?? body.error)
      : ''
  if (status === 401) {
    return (
      'Cloudflare 拒绝了该凭据（HTTP 401）。' +
      (rpcMessage === '' ? '' : ` 上游说明：${rpcMessage}`) +
      ' 请检查 Token 是否有效、是否已过期或被撤销，或改用 OAuth 授权。'
    )
  }
  if (status === 403) {
    return `Cloudflare 拒绝访问（HTTP 403）：Token 有效但权限不足。${rpcMessage}`
  }
  const snippet = text.trim().slice(0, 400)
  return `上游返回 HTTP ${status}。${rpcMessage === '' ? snippet : rpcMessage}`
}

// ── local auth proxy ────────────────────────────────────────────────────────

let proxyPort = DEFAULT_PORT

/**
 * Copy only the headers the MCP transport needs.
 *
 * An incoming Node request carries a plain lowercase-keyed object, but `fetch`
 * returns a WHATWG `Headers` instance whose values are only reachable through
 * `get()`. Reading `headers['content-type']` on that object yields undefined,
 * which silently drops the content type — and the MCP SDK cannot then tell a
 * JSON body from an SSE stream, so it refuses the response and never
 * registers any tool.
 */
function pickHeaders(source, allowed) {
  const out = {}
  const read =
    typeof source?.get === 'function'
      ? (name) => {
          const value = source.get(name)
          return value === null ? undefined : value
        }
      : (name) => source?.[name]
  for (const name of allowed) {
    const value = read(name)
    if (value !== undefined) out[name] = value
  }
  return out
}

async function handleProxyRequest(req, res) {
  let credential
  try {
    credential = await currentCredential()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: `${PLUGIN}: ${message}` },
      }),
    )
    return
  }

  const headers = pickHeaders(req.headers, FORWARD_REQUEST_HEADERS)
  headers.authorization = `Bearer ${credential}`

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  let upstream
  try {
    upstream = await fetch(UPSTREAM, {
      method: req.method,
      headers,
      body: hasBody ? req : undefined,
      duplex: hasBody ? 'half' : undefined,
      redirect: 'manual',
    })
  } catch (error) {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32002,
          message: `${PLUGIN}: 无法连接 Cloudflare MCP（${error instanceof Error ? error.message : String(error)}）`,
        },
      }),
    )
    return
  }

  const outHeaders = pickHeaders(upstream.headers, FORWARD_RESPONSE_HEADERS)
  // A 401 here means the credential went stale mid-session; surface a readable
  // reason instead of an opaque protocol error.
  if (upstream.status === 401) {
    outHeaders['content-type'] = 'application/json; charset=utf-8'
    res.writeHead(401, outHeaders)
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32003,
          message: `${PLUGIN}: Cloudflare 拒绝了当前凭据（401）。请在设置 → Cloudflare 全功能管家 中重新授权。`,
        },
      }),
    )
    return
  }

  res.writeHead(upstream.status, outHeaders)
  if (upstream.body === null) {
    res.end()
    return
  }
  const stream = upstream.body
  const reader = stream.getReader()
  const abort = () => {
    reader.cancel().catch(() => undefined)
  }
  res.on('close', abort)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => res.once('drain', resolve))
      }
    }
  } catch {
    /* client or upstream ended the stream */
  } finally {
    res.end()
  }
}

function startProxy(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? '/'
      // The OAuth redirect target is this plugin's fixed port, because the DSH
      // Web GUI port changes between restarts and cannot be registered as a
      // stable redirect URI. Serve the settings routes here as well.
      if (url.startsWith(ROUTE_PREFIX)) {
        handleRoute(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500)
          res.end()
        })
        return
      }
      if (!url.startsWith('/mcp')) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      handleProxyRequest(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
    })
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

// ── settings HTTP routes ────────────────────────────────────────────────────

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

function sendHtml(response, status, html) {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(html)
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

function sameOrigin(request) {
  const origin = request.headers.origin
  if (origin === undefined || origin === 'null') return true
  const host = request.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Pending OAuth exchanges, keyed by `state`. */
const oauthPending = new Map()

function callbackUrl() {
  return `http://127.0.0.1:${proxyPort}${ROUTE_PREFIX}/oauth/callback`
}

async function oauthStart(scopes) {
  const config = await loadConfig()
  let clientId = config.oauth !== null && typeof config.oauth.clientId === 'string' ? config.oauth.clientId : ''

  if (clientId === '') {
    const registered = await fetch(REGISTER, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: PLUGIN,
        redirect_uris: [callbackUrl()],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!registered.ok) {
      throw new Error(`OAuth 动态客户端注册失败（HTTP ${registered.status}）`)
    }
    const issued = await registered.json()
    if (typeof issued.client_id !== 'string') throw new Error('OAuth 注册响应缺少 client_id')
    clientId = issued.client_id
    await saveConfig({ ...config, oauth: { ...(config.oauth ?? {}), clientId } })
  }

  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('base64url')

  oauthPending.set(state, { verifier, clientId, createdAt: Date.now() })
  for (const [key, value] of oauthPending) {
    if (Date.now() - value.createdAt > 10 * 60_000) oauthPending.delete(key)
  }

  const url = new URL(AUTHORIZE)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', callbackUrl())
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  if (scopes !== '') url.searchParams.set('scope', scopes)

  return { authorizeUrl: url.toString(), clientId, redirectUri: callbackUrl() }
}

async function oauthFinish(code, state) {
  const pending = oauthPending.get(state)
  if (pending === undefined) throw new Error('OAuth state 无效或已过期，请重新开始授权')
  oauthPending.delete(state)

  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl(),
      client_id: pending.clientId,
      code_verifier: pending.verifier,
    }).toString(),
    signal: AbortSignal.timeout(30_000),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok || json === null || typeof json.access_token !== 'string') {
    const reason =
      json !== null && json.error !== undefined
        ? `${String(json.error)}${json.error_description === undefined ? '' : `: ${String(json.error_description)}`}`
        : `HTTP ${res.status}`
    throw new Error(`OAuth 换取访问令牌失败（${reason}）`)
  }

  const config = await loadConfig()
  await saveConfig({
    ...config,
    authMode: 'oauth',
    oauth: {
      clientId: pending.clientId,
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : '',
      expiresAt: typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : 0,
      scope: typeof json.scope === 'string' ? json.scope : '',
    },
  })
  return { ok: true }
}

/** Count the MCP tools the bridge has actually registered right now. */
let toolsRef = null

function registeredCloudflareTools() {
  if (toolsRef === null) return []
  try {
    const schemas = toolsRef.schemas()
    return schemas
      .map((schema) => schema?.name)
      .filter((name) => typeof name === 'string' && name.startsWith('mcp__cloudflare__'))
  } catch {
    return []
  }
}

async function buildState() {
  const config = await loadConfig()
  const tools = registeredCloudflareTools()
  return {
    authMode: config.authMode,
    accountId: config.accountId,
    hasApiToken: config.apiToken !== '',
    hasOAuth: config.oauth !== null && typeof config.oauth.accessToken === 'string' && config.oauth.accessToken !== '',
    oauthExpiresAt: config.oauth !== null && typeof config.oauth.expiresAt === 'number' ? config.oauth.expiresAt : 0,
    updatedAt: config.updatedAt,
    proxyPort,
    upstream: UPSTREAM,
    registeredTools: tools,
    bridgeConnected: tools.length > 0,
    configPath: CONFIG_FILE,
  }
}

const ROUTES = [
  {
    method: 'GET',
    path: `${ROUTE_PREFIX}/state`,
    mutation: false,
    handle: async () => buildState(),
  },
  {
    method: 'POST',
    path: `${ROUTE_PREFIX}/config`,
    mutation: true,
    handle: async (input) => {
      const config = await loadConfig()
      const patch = {}
      if (input.authMode === 'oauth' || input.authMode === 'token') patch.authMode = input.authMode
      if (typeof input.accountId === 'string') {
        const accountId = input.accountId.trim()
        if (accountId !== '' && !/^[0-9a-fA-F]{32}$/.test(accountId)) {
          return { error: 'Account ID 必须是 32 位十六进制字符（Cloudflare 控制台右下角可复制）。' }
        }
        patch.accountId = accountId
      }
      if (typeof input.apiToken === 'string') {
        let token = input.apiToken.trim()
        if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
          token = token.slice(1, -1)
        }
        if (token !== '' && (token.length < 20 || token.length > 400)) {
          return { error: 'API Token 长度不合法，请确认复制完整（通常 40 个字符左右）。' }
        }
        patch.apiToken = token
      }
      await saveConfig({ ...config, ...patch })
      return buildState()
    },
  },
  {
    method: 'POST',
    path: `${ROUTE_PREFIX}/test`,
    mutation: true,
    handle: async () => {
      let credential
      try {
        credential = await currentCredential()
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      try {
        const result = await probe(credential)
        return result
      } catch (error) {
        return {
          ok: false,
          error: `连接 Cloudflare MCP 失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  },
  {
    method: 'POST',
    path: `${ROUTE_PREFIX}/oauth/start`,
    mutation: true,
    handle: async (input) => {
      const scopes = typeof input.scopes === 'string' ? input.scopes.trim() : ''
      return oauthStart(scopes)
    },
  },
  {
    method: 'POST',
    path: `${ROUTE_PREFIX}/oauth/disconnect`,
    mutation: true,
    handle: async () => {
      const config = await loadConfig()
      const clientId = config.oauth !== null ? config.oauth.clientId : undefined
      await saveConfig({ ...config, oauth: clientId === undefined ? null : { clientId } })
      return buildState()
    },
  },
]

async function handleRoute(request, response) {
  let url
  try {
    url = new URL(request.url ?? '/', 'http://127.0.0.1')
  } catch {
    sendJson(response, 400, { error: 'bad request' })
    return
  }

  // OAuth callback is a browser navigation, not a JSON API call.
  if (url.pathname === `${ROUTE_PREFIX}/oauth/callback`) {
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const failed = url.searchParams.get('error')
    if (failed !== null) {
      sendHtml(response, 400, oauthPage('授权未完成', `Cloudflare 返回：${escapeHtml(failed)}`))
      return
    }
    if (code === null || state === null) {
      sendHtml(response, 400, oauthPage('授权未完成', '缺少 code 或 state 参数。'))
      return
    }
    try {
      await oauthFinish(code, state)
      sendHtml(response, 200, oauthPage('授权成功', 'Cloudflare 全功能管家已连接，可以关闭本页返回 DSH。'))
    } catch (error) {
      sendHtml(response, 400, oauthPage('授权失败', escapeHtml(error instanceof Error ? error.message : String(error))))
    }
    return
  }

  const method = request.method ?? 'GET'
  const route = ROUTES.find((candidate) => candidate.method === method && candidate.path === url.pathname)
  if (route === undefined) {
    sendJson(response, 404, { error: 'not found' })
    return
  }
  if (route.mutation && !sameOrigin(request)) {
    sendJson(response, 403, { error: '跨域请求被拒绝' })
    return
  }
  try {
    const input = route.mutation ? await readJson(request) : {}
    sendJson(response, 200, await route.handle(input))
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (character) => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    return map[character] ?? character
  })
}

function oauthPage(title, message) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1219;color:#e8eaf0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{max-width:520px;padding:32px 36px;border:1px solid #2a3040;border-radius:14px;background:#151a24}
h1{margin:0 0 12px;font-size:19px}p{margin:0;color:#a8b0c0;line-height:1.6;font-size:14px}</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${message}</p></div></body></html>`
}

// ── plugin entry ────────────────────────────────────────────────────────────

export const inject = ['webServer']

export async function apply(ctx, config = {}) {
  proxyPort = typeof config?.port === 'number' && config.port > 0 ? config.port : DEFAULT_PORT

  // The MCP bridge reads the tool registry; keep an optional handle for status.
  ctx.inject(['tools'], (toolsCtx) => {
    toolsRef = toolsCtx.tools
    return () => {
      toolsRef = null
    }
  })

  const server = await startProxy(proxyPort)
  ctx.effect(
    () => () => {
      server.close()
    },
    `${PLUGIN}: proxy`,
  )

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: handleRoute,
    })
    return dispose
  }, `${PLUGIN}: http routes`)

  ctx.logger?.info?.(
    `${PLUGIN}: proxy listening on http://127.0.0.1:${proxyPort}/mcp -> ${UPSTREAM}; config ${CONFIG_FILE}`,
  )
}
