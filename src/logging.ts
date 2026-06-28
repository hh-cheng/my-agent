import pc from 'picocolors'

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
