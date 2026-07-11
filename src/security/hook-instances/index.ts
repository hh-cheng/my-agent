import { logger } from '@/logging'
import { HookResult } from '../hooks'

type PrePipeline = {
  name: string
  pipeline: (toolName: string, ipt: any) => HookResult | Promise<HookResult>
}

type PostPipeline = {
  name: string
  pipeline: (
    toolName: string,
    ipt: any,
    output: any,
  ) => HookResult | Promise<HookResult>
}

function pre_auditLog(toolName: string, ipt: any): HookResult {
  if (toolName === 'write_file' || toolName === 'edit_file') {
    const path = ipt?.path || 'unknown'
    logger.info(`[audit] 文件写入操作: ${toolName} → ${path}`)
  }
  return { action: 'allow' }
}

function post_bashTimestamp(
  toolName: string,
  _ipt: any,
  output: any,
): HookResult {
  if (toolName === 'bash') {
    const timestamp = new Date().toISOString()
    return {
      action: 'modify',
      modifiedOutput: `[${timestamp}]\n${output}`,
    }
  }
  return { action: 'allow' }
}

export const registeredPipelines: { pre: PrePipeline[]; post: PostPipeline[] } =
  {
    pre: [{ name: 'audit-log', pipeline: pre_auditLog }],
    post: [{ name: 'bash-timestamp', pipeline: post_bashTimestamp }],
  }
