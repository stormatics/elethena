import { DataStreamWriter, Tool } from 'ai';
import { Pool } from 'pg';
import { getUserDBAccess } from '~/lib/db/db';
import { Connection, Project } from '~/lib/db/schema';
import { AuditOrigin } from '~/lib/targetdb/audit';
import { getArtifactTools } from './artifacts';
import { getDBClusterTools } from './cluster';
import { commonToolset } from './common';
import { getDBSQLTools } from './db';
import { getHealthCheckToolset } from './healthcheck';
import { getPlaybookToolset } from './playbook';
import { mergeToolsets } from './types';
import { mcpToolset } from './user-mcp';

export * from './cluster';
export * from './common';
export * from './db';
export * from './playbook';
export * from './types';

export async function getTools({
  project,
  connection,
  targetDb,
  userId,
  origin = 'chat',
  useArtifacts = false,
  dataStream
}: {
  project: Project;
  connection: Connection;
  targetDb: Pool;
  userId: string;
  origin?: AuditOrigin;
  useArtifacts?: boolean;
  dataStream?: DataStreamWriter;
}): Promise<Record<string, Tool>> {
  const dbAccess = await getUserDBAccess(userId);
  const audit = { userId, projectId: project.id, connectionId: connection.id, origin };

  const dbTools = getDBSQLTools(targetDb, audit);
  const clusterTools = getDBClusterTools(dbAccess, connection, project.cloudProvider);
  const playbookToolset = getPlaybookToolset(dbAccess, project.id);
  const healthCheckToolset = getHealthCheckToolset({ targetDb, audit });
  const mcpTools = await mcpToolset.listMCPTools(project.id, connection.connectionString);

  const artifactsToolset =
    useArtifacts && dataStream ? getArtifactTools({ dbAccess, userId, projectId: project.id, dataStream }) : {};

  return mergeToolsets(
    mcpTools,
    commonToolset,
    playbookToolset,
    dbTools,
    clusterTools,
    healthCheckToolset,
    artifactsToolset
  );
}
