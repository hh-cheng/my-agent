export type Role = 'owner' | 'collaborator' | 'guest'

export interface UserIdentity {
  id: string
  name: string
  role: Role
}

const TOOL_ACCESS: Record<Role, { allow: string[] | '*'; deny: string[] }> = {
  owner: {
    allow: '*',
    deny: [],
  },
  collaborator: {
    allow: '*',
    deny: ['bash'],
  },
  guest: {
    allow: [
      'glob',
      'grep',
      'read_file',
      'rag_search',
      'calculator',
      'list_directory',
    ],
    deny: [],
  },
}

export function canUseTool(role: Role, toolName: string) {
  const access = TOOL_ACCESS[role]
  if (access.deny.includes(toolName)) return false
  if (access.allow === '*') return true
  return access.allow.includes(toolName)
}

export function filterToolsForRole(toolNames: string[], role: Role) {
  return toolNames.filter((name) => canUseTool(role, name))
}
