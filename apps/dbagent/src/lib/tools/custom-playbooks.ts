import {
  dbGetCustomPlaybookById,
  dbGetCustomPlaybookByName,
  dbGetCustomPlaybooks,
  dbListCustomPlaybookNames
} from '../db/custom-playbooks';
import { DBAccess } from '../db/db';
import { getPlaybook, listPlaybooks } from './playbooks';

export interface CustomPlaybook {
  name: string;
  description: string;
  content: string;
  id: string;
  projectId: string;
  isBuiltIn: boolean;
  createdBy: string;
}

// All-rows fetch (used by the UI table). Kept thin — the helpers below should
// always be preferred from server code paths that only need one row.
export async function getCustomPlaybooks(dbAccess: DBAccess, projectId: string): Promise<CustomPlaybook[]> {
  if (!projectId) throw new Error('[INVALID_INPUT] Project ID is required');
  return dbGetCustomPlaybooks(dbAccess, projectId);
}

export async function getCustomPlaybook(dbAccess: DBAccess, projectId: string, id: string): Promise<CustomPlaybook> {
  const row = await dbGetCustomPlaybookById(dbAccess, projectId, id);
  if (!row) throw new Error('Custom playbook not found');
  return row;
}

export async function getCustomPlaybookByName(
  dbAccess: DBAccess,
  projectId: string,
  name: string
): Promise<CustomPlaybook | null> {
  if (!projectId) throw new Error('Project ID is required');
  if (!name) throw new Error('Playbook Name is required');
  return dbGetCustomPlaybookByName(dbAccess, projectId, name);
}

export async function getListOfCustomPlaybooksNames(dbAccess: DBAccess, projectId: string): Promise<string[] | null> {
  const names = await dbListCustomPlaybookNames(dbAccess, projectId);
  return names.length === 0 ? null : names;
}

export async function getCustomPlaybookContent(
  dbAccess: DBAccess,
  projectId: string,
  name: string
): Promise<string | null> {
  const row = await dbGetCustomPlaybookByName(dbAccess, projectId, name);
  return row?.content ?? null;
}

// Returns content for either a custom playbook (DB) or a built-in playbook (code).
export async function getCustomPlaybookAndPlaybookTool(
  dbAccess: DBAccess,
  name: string,
  projectId: string
): Promise<string> {
  const customContent = await getCustomPlaybookContent(dbAccess, projectId, name);
  if (customContent !== null) return customContent;
  return getPlaybook(name);
}

// Returns name list of built-in + custom playbooks for the project.
export async function listCustomPlaybooksAndPlaybookTool(dbAccess: DBAccess, projectId: string): Promise<string[]> {
  const customNames = await dbListCustomPlaybookNames(dbAccess, projectId);
  return [...listPlaybooks(), ...customNames];
}
