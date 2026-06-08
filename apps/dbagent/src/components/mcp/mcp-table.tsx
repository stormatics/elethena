'use client';

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Code,
  Input,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@xata.io/components';
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { MCPServer } from '~/lib/db/schema';
import {
  actionAddUserMcpServerToDB,
  actionCheckUserMcpServerExists,
  actionDeleteUserMcpServer,
  actionGetUserMcpServer,
  actionRegisterExternalMcpServer,
  actionUpdateUserMcpServer
} from './action';

const ITEMS_PER_PAGE = 10;

export function McpTable() {
  const router = useRouter();
  const [mcpServers, setMcpServers] = useState<MCPServer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [mcpServerInDb, setmcpServerInDb] = useState<Record<string, boolean>>({});
  const { project } = useParams<{ project: string }>();
  const [currentPage, setCurrentPage] = useState(1);

  // External server registration form
  const [showExternalForm, setShowExternalForm] = useState(false);
  const [extName, setExtName] = useState('');
  const [extCommand, setExtCommand] = useState('uvx');
  const [extArgs, setExtArgs] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);

  const loadMcpServers = async () => {
    try {
      const response = await fetch(`/api/mcp/servers?projectId=${project}`);

      if (!response.ok) {
        throw new Error('Failed to fetch MCP servers');
      }

      const servers = await response.json();
      const status: Record<string, boolean> = {};

      await Promise.all(
        servers.map(async (server: MCPServer) => {
          const [getServerFromDb, exists] = await Promise.all([
            actionGetUserMcpServer(server.name, project),
            actionCheckUserMcpServerExists(server.name, project)
          ]);
          server.enabled = getServerFromDb?.enabled || false;
          status[server.name] = exists;
        })
      );

      setMcpServers(servers);
      setmcpServerInDb(status);
    } catch (error) {
      console.error('Error loading MCP servers:', error);
      setMcpServers([]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleToggleEnabled = async (targetMcpServer: MCPServer) => {
    setMcpServers((prevServers) =>
      prevServers.map((server) =>
        server.name === targetMcpServer.name ? { ...server, enabled: !server.enabled } : server
      )
    );
    targetMcpServer.enabled = !targetMcpServer.enabled;

    const serverExists = await actionCheckUserMcpServerExists(targetMcpServer.name, project);
    if (!serverExists) {
      await actionAddUserMcpServerToDB({ ...targetMcpServer, projectId: project });
      setmcpServerInDb((prev) => ({ ...prev, [targetMcpServer.name]: true }));
    } else {
      await actionUpdateUserMcpServer({ ...targetMcpServer, projectId: project });
    }
  };

  const handleDelete = async (server: MCPServer) => {
    if (!confirm(`Delete "${server.name}"? This cannot be undone.`)) return;
    try {
      await actionDeleteUserMcpServer(server.name, project);
      toast.success(`Deleted "${server.name}".`);
      await loadMcpServers();
    } catch (error) {
      console.error('Error deleting MCP server:', error);
      toast.error('Failed to delete server.');
    }
  };

  const handleRegisterExternal = async () => {
    if (!extName.trim() || !extCommand.trim() || !extArgs.trim()) {
      toast.error('Name, command, and args are required.');
      return;
    }
    setIsRegistering(true);
    try {
      const args = extArgs.trim().split(/\s+/);
      await actionRegisterExternalMcpServer(project, { name: extName.trim(), command: extCommand.trim(), args });
      toast.success(`Registered "${extName}" successfully.`);
      setExtName('');
      setExtCommand('uvx');
      setExtArgs('');
      setShowExternalForm(false);
      await loadMcpServers();
    } catch (error) {
      console.error('Error registering external server:', error);
      toast.error('Failed to register server. Name may already exist for this project.');
    } finally {
      setIsRegistering(false);
    }
  };

  useEffect(() => {
    void loadMcpServers();
  }, [project]);

  const SkeletonRow = () => (
    <TableRow>
      <TableCell>
        <div className="bg-muted h-4 w-24 animate-pulse rounded" />
      </TableCell>
    </TableRow>
  );

  const getMcpServerUrl = (server: MCPServer) => {
    return `/projects/${project}/mcp/${encodeURIComponent(server.name)}`;
  };

  const totalPages = Math.ceil(mcpServers.length / ITEMS_PER_PAGE);
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = startIndex + ITEMS_PER_PAGE;
  const currentServers = mcpServers.slice(startIndex, endIndex);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold">MCP Servers</h1>
        <Button variant="outline" size="sm" onClick={() => setShowExternalForm((v) => !v)}>
          <PlusIcon className="mr-2 h-4 w-4" />
          Register External Server
        </Button>
      </div>

      {showExternalForm && (
        <div className="mb-6 space-y-3 rounded-lg border p-4">
          <h2 className="font-semibold">Register External MCP Server</h2>
          <p className="text-muted-foreground text-sm">
            For non-Node.js servers (e.g. Python). DATABASE_URL and DATABASE_URI are automatically injected from this
            project&apos;s connection.
          </p>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label htmlFor="mcp-ext-name" className="mb-1 block text-sm font-medium">
                Name
              </label>
              <Input
                id="mcp-ext-name"
                placeholder="postgres-mcp"
                value={extName}
                onChange={(e) => setExtName(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="mcp-ext-command" className="mb-1 block text-sm font-medium">
                Command
              </label>
              <Input
                id="mcp-ext-command"
                placeholder="uvx"
                value={extCommand}
                onChange={(e) => setExtCommand(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="mcp-ext-args" className="mb-1 block text-sm font-medium">
                Args (space-separated)
              </label>
              <Input
                id="mcp-ext-args"
                placeholder="postgres-mcp"
                value={extArgs}
                onChange={(e) => setExtArgs(e.target.value)}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowExternalForm(false)}>
              Cancel
            </Button>
            <Button onClick={handleRegisterExternal} disabled={isRegistering}>
              {isRegistering ? 'Registering...' : 'Register'}
            </Button>
          </div>
        </div>
      )}

      <div className="mb-6">
        <Alert>
          <AlertTitle>Add custom tools via a new MCP server</AlertTitle>
          <AlertDescription>
            To add custom tools, you can create a new MCP server, which the Agent will run locally. To create a new MCP
            server,{' '}
            <Link
              href="https://github.com/xataio/agent/wiki/Create-custom-tools-via-a-local-MCP-server"
              target="_blank"
              className="font-medium underline"
            >
              follow this guide
            </Link>
            .
          </AlertDescription>
        </Alert>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Server Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Enabled</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && (
            <>
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </>
          )}
          {currentServers.map((server) => (
            <TableRow key={server.name}>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Code variant="default">
                    <Link href={getMcpServerUrl(server)}>{server.name}</Link>
                  </Code>
                  {!mcpServerInDb[server.name] && (
                    <Tooltip>
                      <TooltipTrigger>
                        <Badge variant="secondary" className="text-xs">
                          New
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent>This MCP Server has not been enabled yet</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </TableCell>
              <TableCell>
                <span className="text-muted-foreground text-sm">
                  {server.filePath ? 'Node.js' : `External (${server.command})`}
                </span>
              </TableCell>
              <TableCell>
                <Switch checked={server.enabled} onCheckedChange={() => handleToggleEnabled(server)} />
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => router.push(getMcpServerUrl(server))}>
                    Edit
                  </Button>
                  {mcpServerInDb[server.name] && (
                    <Button variant="outline" size="sm" onClick={() => handleDelete(server)}>
                      <Trash2Icon className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {!isLoading && mcpServers.length > 0 && (
        <div className="mt-4 flex items-center justify-between">
          <div className="text-muted-foreground text-sm">
            Showing {startIndex + 1}-{Math.min(endIndex, mcpServers.length)} of {mcpServers.length} servers
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
              disabled={currentPage === 1}
            >
              <ChevronLeftIcon className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-1">
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
                <Button
                  key={page}
                  variant={currentPage === page ? 'default' : 'outline'}
                  size="icon"
                  onClick={() => setCurrentPage(page)}
                >
                  {page}
                </Button>
              ))}
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setCurrentPage((prev) => Math.min(prev + 1, totalPages))}
              disabled={currentPage === totalPages}
            >
              <ChevronRightIcon className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
