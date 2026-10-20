/**
 * dsh-cloudflare-codemode — browser half.
 *
 * Registers the "Cloudflare 全功能管家" page under Settings. Plain
 * `__ModuleLoader__` module, no build step: React comes from the browser module
 * table that `inject` declares.
 *
 * The panel talks to this plugin's own Host routes:
 *   GET  /cloudflare-codemode/state
 *   POST /cloudflare-codemode/config
 *   POST /cloudflare-codemode/test
 *   POST /cloudflare-codemode/oauth/start
 *   POST /cloudflare-codemode/oauth/disconnect
 * The MCP connection itself is owned by the `@deepseek-ai/dsh-mcp-client` row
 * that points at this plugin's localhost proxy.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cloudflare-codemode',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const NS = 'dsh-cloudflare-codemode'

    const R = {
      state: '/cloudflare-codemode/state',
      config: '/cloudflare-codemode/config',
      test: '/cloudflare-codemode/test',
      oauthStart: '/cloudflare-codemode/oauth/start',
      oauthDisconnect: '/cloudflare-codemode/oauth/disconnect',
    }

    async function api(path, payload) {
      const init =
        payload === undefined
          ? { cache: 'no-store' }
          : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
      let res
      try {
        res = await fetch(path, init)
      } catch (error) {
        throw new Error('无法连接到 DSH 主机：' + (error && error.message ? error.message : String(error)))
      }
      let data = null
      try {
        data = await res.json()
      } catch {
        /* not json */
      }
      if (data === null) throw new Error('请求失败（HTTP ' + res.status + '）')
      if (data.error) throw new Error(data.error)
      return data
    }

    // ── shared bits ─────────────────────────────────────────────────────────

    const h = React.createElement

    function Row(props) {
      return h('div', { className: 'cfc-row' }, props.children)
    }

    function Field(props) {
      return h(
        'label',
        { className: 'cfc-field' },
        h('span', { className: 'cfc-label' }, props.label),
        props.children,
        props.hint ? h('span', { className: 'cfc-hint' }, props.hint) : null,
      )
    }

    function Dot(props) {
      const tone = props.tone === 'ok' ? 'ok' : props.tone === 'warn' ? 'warn' : props.tone === 'bad' ? 'bad' : 'idle'
      return h('span', { className: 'cfc-dot cfc-dot-' + tone, 'aria-hidden': 'true' })
    }

    const TABS = [
      { id: 'token', label: 'API Token' },
      { id: 'oauth', label: 'OAuth 授权' },
    ]

    // ── panel ───────────────────────────────────────────────────────────────

    function Panel() {
      const [state, setState] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [probe, setProbe] = React.useState(null)
      const [accountId, setAccountId] = React.useState('')
      const [token, setToken] = React.useState('')
      const [mode, setMode] = React.useState('token')

      const refresh = React.useCallback(async () => {
        try {
          const next = await api(R.state)
          setState(next)
          setMode(next.authMode)
          setAccountId((current) => (current === '' ? next.accountId || '' : current))
          setError('')
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        refresh()
        const timer = setInterval(refresh, 5000)
        return () => clearInterval(timer)
      }, [refresh])

      async function runTest() {
        setBusy('test')
        setError('')
        setNotice('')
        try {
          const result = await api(R.test, {})
          setProbe(result)
          if (result.ok) {
            setNotice('连接成功：Cloudflare Code Mode 已就绪。')
          } else {
            setError(result.error || '连接失败')
          }
          await refresh()
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy('')
        }
      }

      async function saveAndTest() {
        setBusy('save')
        setError('')
        setNotice('')
        try {
          await api(R.config, { authMode: 'token', accountId, apiToken: token })
          setToken('')
          await refresh()
          setBusy('')
          await runTest()
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
          setBusy('')
        }
      }

      async function startOAuth() {
        setBusy('oauth')
        setError('')
        setNotice('')
        try {
          const result = await api(R.oauthStart, { scopes: 'offline_access' })
          if (result.authorizeUrl) {
            window.open(result.authorizeUrl, '_blank', 'noopener,noreferrer')
            setNotice('已打开 Cloudflare 授权页。完成授权后本页会自动刷新状态。')
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy('')
        }
      }

      async function disconnect() {
        setBusy('disconnect')
        setError('')
        try {
          await api(R.oauthDisconnect, {})
          setProbe(null)
          await refresh()
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy('')
        }
      }

      const connected = state !== null && state.bridgeConnected === true
      const hasAny = state !== null && (state.hasApiToken || state.hasOAuth)
      const tone = connected ? 'ok' : hasAny ? 'warn' : 'idle'
      const statusText = connected
        ? '已连接'
        : hasAny
          ? '已配置凭据（等待 MCP 桥接）'
          : '未连接'

      const toolNames = state !== null && Array.isArray(state.registeredTools) ? state.registeredTools : []
      const probeTools = probe !== null && Array.isArray(probe.tools) ? probe.tools : null

      return h(
        'div',
        { className: 'cfc-root' },
        h(
          'header',
          { className: 'cfc-head' },
          h('h2', { className: 'cfc-title' }, 'Cloudflare 全功能管家'),
          h(
            'p',
            { className: 'cfc-sub' },
            '通过 Cloudflare 官方 Code Mode MCP（search + execute）覆盖 2,500+ API 端点。插件不自建 API 封装。',
          ),
        ),

        h(
          'section',
          { className: 'cfc-card' },
          h(
            'div',
            { className: 'cfc-status' },
            h(Dot, { tone }),
            h('strong', null, statusText),
            h('span', { className: 'cfc-sep' }, '·'),
            h('span', { className: 'cfc-muted' }, connected ? 'Code Mode 已就绪' : '工具尚未注册'),
            h('span', { className: 'cfc-sep' }, '·'),
            h('span', { className: 'cfc-muted' }, '已注册工具 ' + toolNames.length + ' 个'),
          ),
          toolNames.length > 0
            ? h('div', { className: 'cfc-chips' }, toolNames.map((name) => h('code', { key: name, className: 'cfc-chip' }, name)))
            : null,
          h(
            'div',
            { className: 'cfc-meta' },
            h('span', null, '代理端口 ' + (state ? state.proxyPort : '—')),
            h('span', { className: 'cfc-sep' }, '·'),
            h('span', null, '凭据文件 ~/.dsh/dsh-cloudflare-codemode.json'),
          ),
        ),

        h(
          'section',
          { className: 'cfc-card' },
          h('h3', { className: 'cfc-h3' }, '认证方式'),
          h(
            'div',
            { className: 'cfc-tabs', role: 'tablist' },
            TABS.map((tab) =>
              h(
                'button',
                {
                  key: tab.id,
                  type: 'button',
                  role: 'tab',
                  'aria-selected': mode === tab.id,
                  className: 'cfc-tab' + (mode === tab.id ? ' cfc-tab-active' : ''),
                  onClick: () => setMode(tab.id),
                },
                tab.label,
              ),
            ),
          ),

          mode === 'token'
            ? h(
                'div',
                { className: 'cfc-body' },
                h(
                  Field,
                  { label: 'Account ID', hint: 'Cloudflare 控制台概览页右侧「账户 ID」，32 位十六进制。' },
                  h('input', {
                    className: 'cfc-input',
                    type: 'text',
                    spellCheck: false,
                    autoComplete: 'off',
                    placeholder: '例如 0123456789abcdef0123456789abcdef',
                    value: accountId,
                    onChange: (event) => setAccountId(event.target.value),
                  }),
                ),
                h(
                  Field,
                  { label: 'API Token', hint: '保存后不会回显；留空表示保留已保存的 Token。' },
                  h('input', {
                    className: 'cfc-input',
                    type: 'password',
                    spellCheck: false,
                    autoComplete: 'off',
                    placeholder: state && state.hasApiToken ? '已保存（留空则不修改）' : '粘贴 Cloudflare API Token',
                    value: token,
                    onChange: (event) => setToken(event.target.value),
                  }),
                ),
                h(
                  'div',
                  { className: 'cfc-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'cfc-btn cfc-btn-primary',
                      disabled: busy !== '',
                      onClick: saveAndTest,
                    },
                    busy === 'save' ? '保存中…' : '保存并测试连接',
                  ),
                ),
              )
            : h(
                'div',
                { className: 'cfc-body' },
                h(
                  'p',
                  { className: 'cfc-p' },
                  '使用 OAuth 2.1 浏览器授权。插件会用 PKCE + 动态客户端注册连接 Cloudflare 授权服务器，令牌同样只存本机凭据文件。',
                ),
                h(
                  'div',
                  { className: 'cfc-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'cfc-btn cfc-btn-primary',
                      disabled: busy !== '',
                      onClick: startOAuth,
                    },
                    busy === 'oauth' ? '正在准备…' : '开始 OAuth 授权',
                  ),
                  state && state.hasOAuth
                    ? h(
                        'button',
                        { type: 'button', className: 'cfc-btn cfc-btn-danger', disabled: busy !== '', onClick: disconnect },
                        '断开 OAuth',
                      )
                    : null,
                ),
              ),

          h(
            'div',
            { className: 'cfc-actions cfc-actions-end' },
            h(
              'button',
              { type: 'button', className: 'cfc-btn', disabled: busy !== '', onClick: runTest },
              busy === 'test' ? '测试中…' : '测试连接',
            ),
          ),
        ),

        error !== '' ? h('div', { className: 'cfc-alert cfc-alert-bad' }, error) : null,
        notice !== '' ? h('div', { className: 'cfc-alert cfc-alert-ok' }, notice) : null,

        probeTools !== null
          ? h(
              'section',
              { className: 'cfc-card' },
              h('h3', { className: 'cfc-h3' }, '最近一次探测结果'),
              probe !== null && probe.ok
                ? h(
                    'div',
                    { className: 'cfc-body' },
                    h(
                      'p',
                      { className: 'cfc-p' },
                      '服务端：' +
                        (probe.serverInfo && probe.serverInfo.name ? probe.serverInfo.name + ' ' : '') +
                        (probe.serverInfo && probe.serverInfo.version ? probe.serverInfo.version : '') +
                        '　工具 ' +
                        probeTools.length +
                        ' 个',
                    ),
                    h(
                      'ul',
                      { className: 'cfc-list' },
                      probeTools.map((tool, index) =>
                        h(
                          'li',
                          { key: index },
                          h('code', { className: 'cfc-chip' }, tool.name || '(未命名)'),
                          tool.description ? h('span', { className: 'cfc-muted' }, ' — ' + tool.description) : null,
                        ),
                      ),
                    ),
                  )
                : h('p', { className: 'cfc-p cfc-bad' }, (probe && probe.error) || '探测失败'),
            )
          : null,

        h(
          'section',
          { className: 'cfc-card' },
          h('h3', { className: 'cfc-h3' }, 'Token 权限检查清单'),
          h(
            'p',
            { className: 'cfc-p' },
            'Cloudflare 没有「一键全权限」勾选。要覆盖部署 Workers、改 DNS、管理 R2 等写操作，请按下面逐项设置：',
          ),
          h(
            'ol',
            { className: 'cfc-ol' },
            h('li', null, 'Dash → My Profile → API Tokens → Create Custom Token'),
            h('li', null, 'Permissions 区：把 Account 与 Zone 两个作用域下的绝大多数权限组设为 Edit（不是 Read）'),
            h('li', null, 'Account Resources 设为 Include → All accounts'),
            h('li', null, 'Zone Resources 设为 Include → All zones'),
            h('li', null, '保存后立刻把 Token 粘贴到上面并点「保存并测试连接」'),
          ),
          h(
            'p',
            { className: 'cfc-p cfc-muted' },
            '提示：只读场景可以只给 Read；但只要出现会修改基础设施的操作，相应权限组必须是 Edit。',
          ),
        ),

        loading ? h('p', { className: 'cfc-p cfc-muted' }, '正在读取插件状态…') : null,
        error === '' && loading && state === null
          ? h('p', { className: 'cfc-p cfc-bad' }, '无法读取状态：请确认插件已安装并重启宿主。')
          : null,
      )
    }

    // ── styles ──────────────────────────────────────────────────────────────

    const STYLES = `
.cfc-root { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 24px; color: var(--dsw-alias-label-primary, #e8eaf0); }
.cfc-head { display: flex; flex-direction: column; gap: 6px; }
.cfc-title { margin: 0; font-size: 17px; font-weight: 650; }
.cfc-sub { margin: 0; font-size: 12.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #98a1b3); }
.cfc-card { border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); border-radius: 12px; padding: 14px 16px; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05)); display: flex; flex-direction: column; gap: 10px; }
.cfc-h3 { margin: 0; font-size: 13.5px; font-weight: 650; }
.cfc-status { display: flex; align-items: center; gap: 8px; font-size: 13.5px; flex-wrap: wrap; }
.cfc-sep { color: var(--dsw-alias-label-secondary, #98a1b3); }
.cfc-muted { color: var(--dsw-alias-label-secondary, #98a1b3); font-size: 12.5px; }
.cfc-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; flex: none; }
.cfc-dot-idle { background: #8b93a5; }
.cfc-dot-warn { background: #d8a02a; }
.cfc-dot-ok { background: #2fb872; box-shadow: 0 0 0 3px color-mix(in srgb, #2fb872 24%, transparent); }
.cfc-dot-bad { background: #e5534b; }
.cfc-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.cfc-chip { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; padding: 2px 8px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14)); border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); }
.cfc-meta { display: flex; gap: 6px; flex-wrap: wrap; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #98a1b3); }
.cfc-tabs { display: flex; gap: 6px; }
.cfc-tab { font-size: 12.5px; padding: 5px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); background: transparent; color: var(--dsw-alias-label-secondary, #98a1b3); cursor: pointer; }
.cfc-tab:hover { color: var(--dsw-alias-label-primary, #e8eaf0); }
.cfc-tab-active { background: var(--dsw-alias-label-primary, #e8eaf0); color: var(--dsw-alias-bg-base, #11141b); border-color: transparent; }
.cfc-body { display: flex; flex-direction: column; gap: 10px; }
.cfc-field { display: flex; flex-direction: column; gap: 5px; }
.cfc-label { font-size: 12.5px; font-weight: 600; }
.cfc-hint { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #98a1b3); }
.cfc-input { font-size: 13px; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35)); background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1)); color: inherit; font-family: inherit; }
.cfc-input:focus { outline: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 55%, transparent); outline-offset: 1px; }
.cfc-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.cfc-actions-end { justify-content: flex-end; }
.cfc-btn { font-size: 12.5px; padding: 6px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35)); background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1)); color: inherit; cursor: pointer; }
.cfc-btn:disabled { opacity: .55; cursor: default; }
.cfc-btn-primary { background: var(--dsw-alias-brand-primary, #4d6bfe); border-color: transparent; color: #fff; }
.cfc-btn-danger { border-color: color-mix(in srgb, #e5534b 45%, transparent); color: #e5534b; }
.cfc-alert { font-size: 12.5px; line-height: 1.6; padding: 9px 12px; border-radius: 9px; }
.cfc-alert-bad { background: color-mix(in srgb, #e5534b 12%, transparent); border: 1px solid color-mix(in srgb, #e5534b 38%, transparent); color: #f08a84; }
.cfc-alert-ok { background: color-mix(in srgb, #2fb872 12%, transparent); border: 1px solid color-mix(in srgb, #2fb872 38%, transparent); color: #63d29a; }
.cfc-p { margin: 0; font-size: 12.5px; line-height: 1.65; }
.cfc-ol { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; line-height: 1.55; }
.cfc-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; }
.cfc-bad { color: #f08a84; }
`

    // ── plugin entry ────────────────────────────────────────────────────────

    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.setAttribute('data-plugin', NS)
        tag.textContent = STYLES
        document.head.appendChild(tag)
        return () => {
          if (tag.parentNode !== null) tag.parentNode.removeChild(tag)
        }
      }, NS + ': styles')

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: NS,
            order: 40,
            label: () => 'Cloudflare 全功能管家',
          },
          () => React.createElement(Panel, null),
        ),
      )
    }

    module.exports = { name: NS, inject: ['slots'], apply }
    return module.exports
  },
})
