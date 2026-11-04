import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

// A separate process and credential per owner exercises the real MCP transport.
const directory = path.resolve(process.argv[2])
const connection = JSON.parse(process.env.VELMREN_ACCEPTANCE_CONNECTION)
delete process.env.VELMREN_ACCEPTANCE_CONNECTION
const { createClient } = await import(pathToFileURL(path.join(directory, 'client.mjs')))
const { createMcpServer } = await import(pathToFileURL(path.join(directory, 'mcp.mjs')))
const server = createMcpServer(createClient(connection))
await server.connect(new StdioServerTransport())
