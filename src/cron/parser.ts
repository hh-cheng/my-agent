import { Cron } from 'croner'

import type { ScheduleType } from './types'

export interface ParsedSchedule {
  type: ScheduleType
  intervalMs?: number
  cronInstance?: Cron
  onceAt?: Date
}

const INTERVAL_REG = /^every\s+(\d+)\s*(s|sec|m|min|h|hour)s?$/i

export function getNextCronTime(cron: Cron) {
  return cron.msToNext() ?? 60_000
}

export function parseSchedule(expr: string): ParsedSchedule {
  //* 固定间隔
  const intervalMatch = expr.match(INTERVAL_REG)
  if (intervalMatch) {
    const value = parseInt(intervalMatch[1])
    const unit = intervalMatch[2].toLowerCase()
    const multiplier = unit.startsWith('h')
      ? 3_600_000
      : unit.startsWith('m')
        ? 60_000
        : 1000
    return { type: 'interval', intervalMs: value * multiplier }
  }

  //* ISO 时间戳 (eg.2026-07-12T09:00:00Z)
  if (/^\d{4}-\d{2}-\d{2}/.test(expr)) {
    const date = new Date(expr)
    if (!isNaN(date.getTime())) {
      return { type: 'once', onceAt: date }
    }
  }

  //* Cron 表达式: 分 时 日 月 周
  const cronInstance = new Cron(expr)
  return { type: 'cron', cronInstance }
}
