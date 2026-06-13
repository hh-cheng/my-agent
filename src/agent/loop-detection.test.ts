import { beforeEach, describe, expect, test } from 'bun:test'

import {
  detect,
  recordCall,
  recordResult,
  resetHistory,
} from './loop-detection'

describe('loop detection', () => {
  beforeEach(() => {
    resetHistory()
  })

  test('detects repeated calls with the same tool and params as warning', () => {
    for (let i = 0; i < 5; i++) {
      recordCall('calculator', { expression: '1 + 1' })
    }

    const result = detect('calculator', { expression: '1 + 1' })

    expect(result.stuck).toBe(true)
    expect(result).toMatchObject({
      detector: 'generic_repeat',
      level: 'warning',
      count: 5,
    })
  })

  test('detects repeated calls with the same tool and params as critical', () => {
    for (let i = 0; i < 8; i++) {
      recordCall('calculator', { expression: '1 + 1' })
    }

    const result = detect('calculator', { expression: '1 + 1' })

    expect(result.stuck).toBe(true)
    expect(result).toMatchObject({
      detector: 'generic_repeat',
      level: 'critical',
      count: 8,
    })
  })

  test('uses stable param hashing regardless of object key order', () => {
    for (let i = 0; i < 5; i++) {
      recordCall('calculator', { left: 1, right: 2 })
    }

    const result = detect('calculator', { right: 2, left: 1 })

    expect(result.stuck).toBe(true)
    expect(result).toMatchObject({
      detector: 'generic_repeat',
      level: 'warning',
    })
  })

  test('detects ping-pong calls between two argument sets', () => {
    recordCall('calculator', { expression: '1 + 1' })
    recordCall('calculator', { expression: '2 + 2' })
    recordCall('calculator', { expression: '1 + 1' })
    recordCall('calculator', { expression: '2 + 2' })

    const result = detect('calculator', { expression: '1 + 1' })

    expect(result.stuck).toBe(true)
    expect(result).toMatchObject({
      detector: 'ping_pong',
      level: 'warning',
      count: 5,
    })
  })

  test('detects no progress when identical calls return the same result', () => {
    for (let i = 0; i < 10; i++) {
      recordCall('calculator', { expression: '1 + 1' })
      recordResult('calculator', { expression: '1 + 1' }, { value: 2 })
    }

    const result = detect('calculator', { expression: '1 + 1' })

    expect(result.stuck).toBe(true)
    expect(result).toMatchObject({
      detector: 'global_circuit_breaker',
      level: 'critical',
      count: 10,
    })
  })

  test('resetHistory clears prior loop state', () => {
    for (let i = 0; i < 5; i++) {
      recordCall('calculator', { expression: '1 + 1' })
    }

    resetHistory()

    expect(detect('calculator', { expression: '1 + 1' })).toEqual({
      stuck: false,
    })
  })
})
