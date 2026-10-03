import { startMcpServer } from './mcp-server'

/**
 * The test MCP server as a process, for the browser tests: Playwright runs on Node and
 * cannot start `Bun.serve` itself. Prints its URL on the first line and runs until killed.
 */
const server = startMcpServer({
  requireHeader: { name: 'x-api-key', value: process.env.MCP_TEST_TOKEN ?? 'sesame' },
})
console.log(server.url)
