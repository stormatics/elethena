'use server';

import { getUserSessionDBAccess } from '~/lib/db/db';
import {
  addUserMcpServerToDB,
  deleteUserMcpServer,
  getUserMcpServer,
  getUserMcpServers,
  registerExternalMcpServer,
  updateUserMcpServer
} from '~/lib/db/mcp-servers';
import { MCPServer, MCPServerInsert } from '~/lib/db/schema';

export async function actionAddUserMcpServerToDB(input: MCPServer): Promise<MCPServer> {
  const dbAccess = await getUserSessionDBAccess();
  return await addUserMcpServerToDB(dbAccess, input);
}

export async function actionCheckUserMcpServerExists(serverName: string, projectId?: string): Promise<boolean> {
  const dbAccess = await getUserSessionDBAccess();
  const result = await getUserMcpServer(dbAccess, serverName, projectId);
  return !!result;
}

export async function actionUpdateUserMcpServer(input: MCPServerInsert) {
  if (!input.filePath && !input.args) {
    input.filePath = `${input.name}.js`;
  }
  const dbAccess = await getUserSessionDBAccess();
  return await updateUserMcpServer(dbAccess, input);
}

export async function actionGetUserMcpServer(serverName: string, projectId?: string) {
  const dbAccess = await getUserSessionDBAccess();
  return await getUserMcpServer(dbAccess, serverName, projectId);
}

export async function actionGetUserMcpServers(projectId: string) {
  const dbAccess = await getUserSessionDBAccess();
  return await getUserMcpServers(dbAccess, projectId);
}

export async function actionRegisterExternalMcpServer(
  projectId: string,
  input: { name: string; command: string; args: string[]; envVars?: Record<string, string> }
): Promise<MCPServer> {
  const dbAccess = await getUserSessionDBAccess();
  return await registerExternalMcpServer(dbAccess, projectId, input);
}

export async function actionDeleteUserMcpServer(serverName: string, projectId: string): Promise<void> {
  const dbAccess = await getUserSessionDBAccess();
  return await deleteUserMcpServer(dbAccess, serverName, projectId);
}
