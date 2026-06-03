// Shared shape — safe to import from both Client and Server components.
// Server-only logic (reading .md files from disk, registering content) lives in playbooks.ts.

export interface Playbook {
  name: string;
  description: string;
  content: string;
  isBuiltIn: boolean;
}
