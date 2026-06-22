import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'

const SESSION_DIR = '.sessions'

export interface SessionEntry {
  type: 'message'
  timestamp: string
  message: ModelMessage
}

export class SessionStore {
  private dir = SESSION_DIR

  constructor(private sessionId = 'default') {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true })
    }
  }

  private get filePath() {
    return join(this.dir, `${this.sessionId}.jsonl`)
  }

  append(message: ModelMessage) {
    const entry: SessionEntry = {
      message,
      type: 'message',
      timestamp: new Date().toISOString(),
    }
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf8')
  }

  appendAll(messages: ModelMessage[]) {
    for (const msg of messages) {
      this.append(msg)
    }
  }

  load(): ModelMessage[] {
    if (!this.exists()) return []

    const content = readFileSync(this.filePath, 'utf8').trim()
    if (!content) return []

    const messages: ModelMessage[] = []

    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry: SessionEntry = JSON.parse(line)
        if (entry.type === 'message') {
          messages.push(entry.message)
        }
      } catch {}
    }

    return messages
  }

  exists() {
    return existsSync(this.filePath)
  }
}
