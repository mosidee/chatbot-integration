import { startOAuthMcpServer } from './oauth-mcp-server'

/** The OAuth-protected test MCP server as a process, for the browser tests. Prints its URL. */
const server = startOAuthMcpServer()
console.log(server.url)
