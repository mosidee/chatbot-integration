import { createHash } from 'node:crypto'
import { handleMcp, type McpCall } from './mcp-server'

/**
 * An MCP server behind its own OAuth authorization server, on one `Bun.serve`, for tests of
 * the sign-in (ADR 0011): protected-resource and authorization-server metadata, dynamic
 * client registration, an authorization endpoint that approves at once, PKCE-checked code
 * exchange, and refresh tokens that rotate and can be spent only once.
 */

export type RefreshMode = 'ok' | 'invalid_grant' | 'unavailable'

export type TestOAuthMcpServer = {
  url: string
  base: string
  calls: McpCall[]
  /** How many refresh grants were answered with new tokens. */
  refreshes: () => number
  /** How the next refresh grants are answered. */
  setRefreshMode: (mode: RefreshMode) => void
  /** Lifetime of access tokens issued from now on, in seconds. */
  setExpiresIn: (seconds: number) => void
  /** Stop accepting every access token issued so far, as a revocation would. */
  revokeAccessTokens: () => void
  stop: () => void
}

export function startOAuthMcpServer(): TestOAuthMcpServer {
  const calls: McpCall[] = []
  const codes = new Map<string, { challenge: string; redirectUri: string }>()
  const accessTokens = new Set<string>()
  const refreshTokens = new Set<string>()
  let issued = 0
  let refreshed = 0
  let mode: RefreshMode = 'ok'
  let expiresIn = 3600

  const issue = () => {
    issued += 1
    const access = `at-${issued}`
    const refresh = `rt-${issued}`
    accessTokens.add(access)
    refreshTokens.add(refresh)
    return Response.json({
      access_token: access,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refresh,
    })
  }

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      const base = url.origin

      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] })
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        })
      }
      if (url.pathname === '/register' && request.method === 'POST') {
        const body = (await request.json()) as Record<string, unknown>
        return Response.json({ ...body, client_id: 'test-client' }, { status: 201 })
      }
      if (url.pathname === '/authorize') {
        // The person approves at once; the redirect carries a code bound to their challenge.
        const code = `code-${codes.size + 1}`
        const redirectUri = url.searchParams.get('redirect_uri') ?? ''
        codes.set(code, {
          challenge: url.searchParams.get('code_challenge') ?? '',
          redirectUri,
        })
        const back = new URL(redirectUri)
        back.searchParams.set('code', code)
        back.searchParams.set('state', url.searchParams.get('state') ?? '')
        return new Response(null, { status: 302, headers: { location: back.toString() } })
      }
      if (url.pathname === '/token' && request.method === 'POST') {
        const form = new URLSearchParams(await request.text())
        if (form.get('grant_type') === 'authorization_code') {
          const pending = codes.get(form.get('code') ?? '')
          const verifier = form.get('code_verifier') ?? ''
          const challenge = createHash('sha256').update(verifier).digest('base64url')
          if (!pending || pending.challenge !== challenge) {
            return Response.json({ error: 'invalid_grant' }, { status: 400 })
          }
          codes.delete(form.get('code') ?? '')
          return issue()
        }
        if (form.get('grant_type') === 'refresh_token') {
          if (mode === 'unavailable') return new Response('down', { status: 503 })
          const token = form.get('refresh_token') ?? ''
          if (mode === 'invalid_grant' || !refreshTokens.delete(token)) {
            return Response.json({ error: 'invalid_grant' }, { status: 400 })
          }
          refreshed += 1
          return issue()
        }
        return Response.json({ error: 'unsupported_grant_type' }, { status: 400 })
      }
      if (url.pathname === '/mcp') {
        const token = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '')
        if (!accessTokens.has(token)) {
          return new Response('unauthorised', {
            status: 401,
            headers: {
              'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
            },
          })
        }
        return handleMcp(request, calls)
      }
      return new Response('not found', { status: 404 })
    },
  })

  const base = `http://127.0.0.1:${server.port}`
  return {
    url: `${base}/mcp`,
    base,
    calls,
    refreshes: () => refreshed,
    setRefreshMode: (next) => {
      mode = next
    },
    setExpiresIn: (seconds) => {
      expiresIn = seconds
    },
    revokeAccessTokens: () => accessTokens.clear(),
    stop: () => server.stop(true),
  }
}
