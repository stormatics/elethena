import { experimental_createMCPClient, type ToolSet } from 'ai';
import { Experimental_StdioMCPTransport } from 'ai/mcp-stdio';
import { promises as fs } from 'fs';
import path from 'path';
import { actionGetUserMcpServer, actionGetUserMcpServers } from '~/components/mcp/action';
import { MCPServerInsert } from '~/lib/db/schema';
import { env } from '~/lib/env/server';

export function getMCPServersDir() {
  const baseDir = env.MCP_SERVERS_DIR || 'mcp-source/dist';
  return path.join(process.cwd(), baseDir);
}

/**
 * Load tools from an MCP server using its stored command/args.
 * Supports both file-based Node.js servers and external servers (Python, etc.).
 * Auto-injects DATABASE_URL from the project connection if not already in envVars.
 */
async function loadToolsFromServer(server: MCPServerInsert, connectionString?: string): Promise<ToolSet> {
  try {
    const mcpServersDir = getMCPServersDir();

    // Determine command and args
    let command: string;
    let args: string[];

    if (server.args !== null && server.args !== undefined && server.args.length > 0) {
      // External server: use stored command + args directly
      command = server.command ?? 'node';
      args = server.args;
    } else if (server.filePath) {
      // File-based Node.js server
      command = 'node';
      args = [path.join(mcpServersDir, server.filePath)];
    } else {
      console.error(`MCP server "${server.name}" has no filePath or args — cannot start`);
      return {};
    }

    // Auto-inject DATABASE_URL and DATABASE_URI from project connection.
    // Some MCP servers (e.g. postgres-mcp) use DATABASE_URI; explicit envVars override either.
    const env: Record<string, string> = {
      ...(connectionString ? { DATABASE_URL: connectionString, DATABASE_URI: connectionString } : {}),
      ...(server.envVars ?? {})
    };

    const transport = new Experimental_StdioMCPTransport({ command, args, env });
    const client = await experimental_createMCPClient({ transport });
    return await client.tools();
  } catch (error) {
    console.error(`Error loading tools for MCP server "${server.name}":`, error);
    return {};
  }
}

/**
 * List all tools from enabled MCP servers for a specific project.
 */
async function listMCPTools(projectId: string, connectionString?: string): Promise<ToolSet> {
  try {
    const servers = await actionGetUserMcpServers(projectId);
    const enabledServers = servers.filter((s) => s.enabled);

    const toolsets = await Promise.all(enabledServers.map((server) => loadToolsFromServer(server, connectionString)));

    return toolsets.reduce((acc, tools) => ({ ...acc, ...tools }), {});
  } catch (error) {
    console.error('Error in listMCPTools:', error);
    return {};
  }
}

/**
 * Get tools for a single named MCP server (used in the MCP preview UI).
 * Looks up the server in DB; falls back to file-based discovery if not registered yet.
 */
async function getMCPToolForServer(serverName: string, projectId: string, connectionString?: string): Promise<ToolSet> {
  try {
    // Try DB first (covers both file-based and external servers)
    const serverFromDb = await actionGetUserMcpServer(serverName, projectId);
    if (serverFromDb) {
      return await loadToolsFromServer(serverFromDb, connectionString);
    }

    // Fall back: file-based server not yet registered in DB — load directly from disk
    const mcpServersDir = getMCPServersDir();
    const filePath = path.join(mcpServersDir, `${serverName}.js`);
    try {
      await fs.access(filePath);
    } catch {
      return {};
    }

    const transport = new Experimental_StdioMCPTransport({ command: 'node', args: [filePath] });
    const client = await experimental_createMCPClient({ transport });
    return await client.tools();
  } catch (error) {
    console.error(`Error loading tools for MCP server "${serverName}":`, error);
    return {};
  }
}

export const mcpToolset = {
  listMCPTools,
  getMCPToolForServer
};
