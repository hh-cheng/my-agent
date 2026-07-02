import pc from 'picocolors'

import { DEBUG } from '@/env'

export const logStyle = {
  banner: pc.bold,
  dim: pc.dim,
  error: pc.red,
  info: pc.cyan,
  muted: pc.gray,
  success: pc.green,
  tool: pc.magenta,
  warn: pc.yellow,
}

export function label(text: string, color: (value: string) => string) {
  return color(`[${text}]`)
}

export function debugLabel(text: string) {
  return label(text, logStyle.muted)
}

export function infoLabel(text: string) {
  return label(text, logStyle.info)
}

export function successLabel(text: string) {
  return label(text, logStyle.success)
}

export function toolLabel(text: string) {
  return label(text, logStyle.tool)
}

export function warnLabel(text: string) {
  return label(text, logStyle.warn)
}

export function errorLabel(text: string) {
  return label(text, logStyle.error)
}

export function debugLog(...args: Parameters<typeof console.log>) {
  if (DEBUG) console.log(...args)
}

export const logger = {
  raw(message = '') {
    console.log(message)
  },

  debug(message: string) {
    console.log(logStyle.muted(message))
  },

  info(message: string) {
    console.log(logStyle.info(message))
  },

  success(message: string) {
    console.log(logStyle.success(message))
  },

  warn(message: string) {
    console.log(logStyle.warn(message))
  },

  error(message: string) {
    console.error(logStyle.error(message))
  },
}
