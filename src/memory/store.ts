import fs from 'node:fs'
import path from 'node:path'

export interface MemoryEntry {
  name: string
  content: string
  filePath: string
  description: string
  type: 'user' | 'feedback' | 'project' | 'reference'
}

const MEMORY_DIR = '.memory'
const INDEX_FILE = 'MEMORY.md'
const MAX_INDEX_LINES = 200
const MAX_FILE_CHARS = 4000

//* === 记忆文件样式 START ===
// ---
// name: 用户偏好 Typescript
// description: 用户偏好 TypeScript，不喜欢 Python
// type: user
// ---
// 用户明确表示偏好 TypeScript，在需要写示例代码时优先使用 TypeScript
//* === 记忆文件样式 END ===

export class MemoryStore {
  constructor(private readonly baseDir = '') {}

  private get memoryDir() {
    return path.join(this.baseDir, MEMORY_DIR)
  }

  private get indexPath() {
    return path.join(this.memoryDir, INDEX_FILE)
  }

  init() {
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true })
    }
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, '# Memory Index\n', 'utf8')
    }
  }

  save(entry: Omit<MemoryEntry, 'filePath'>) {
    this.init()
    const slug = entry.name
      .toLowerCase()
      .replace(/[^a-z0-9一-]+/g, '-')
      .replace(/^-|-$/g, '')
    const filename = `${entry.type}_${slug}.md`
    const filePath = path.join(this.memoryDir, filename)

    const fileContent = [
      '---',
      `name: ${entry.name}`,
      `description: ${entry.description}`,
      `type: ${entry.type}`,
      '---',
      '',
      entry.content,
    ].join('\n')

    fs.writeFileSync(filePath, fileContent, 'utf8')
    this.updateIndex(entry.name, filename, entry.description)
    return filename
  }

  search(query: string): MemoryEntry[] {
    const all = this.list()
    const keywords = query.toLowerCase().split(/\s+/)
    return all.filter((entry) => {
      const text =
        `${entry.name} ${entry.description} ${entry.content}`.toLowerCase()
      return keywords.some((k) => text.includes(k))
    })
  }

  list() {
    this.init()
    const entries: MemoryEntry[] = []
    const files = fs
      .readdirSync(this.memoryDir)
      .filter((f) => f.endsWith('.md') && f !== INDEX_FILE)

    for (const file of files) {
      const filePath = path.join(this.memoryDir, file)
      const raw = fs.readFileSync(filePath, 'utf8')
      const parsed = this.parseFrontmatter(raw)
      if (parsed) entries.push({ ...parsed, filePath })
    }

    return entries
  }

  loadIndex() {
    this.init()
    const raw = fs.readFileSync(this.indexPath, 'utf8')
    return raw.length > MAX_FILE_CHARS
      ? raw.slice(0, MAX_FILE_CHARS) + '\n...(已截断)'
      : raw
  }

  loadFile(filename: string) {
    const filePath = path.join(this.memoryDir, filename)
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, 'utf8')
    return raw.length > MAX_FILE_CHARS
      ? raw.slice(0, MAX_FILE_CHARS) + '\n...(已截断)'
      : raw
  }

  delete(filename: string) {
    const filePath = path.join(this.memoryDir, filename)
    if (!fs.existsSync(filePath)) return false
    fs.unlinkSync(filePath)

    const indexContent = fs.readFileSync(this.indexPath, 'utf8')
    const lines = indexContent
      .split('\n')
      .filter((l) => !l.includes(`(${filename})`))
    fs.writeFileSync(this.indexPath, lines.join('\n'), 'utf8')
    return true
  }

  buildPromptSection() {
    this.init()
    const index = this.loadIndex()
    const entries = this.list()

    if (entries.length === 0) {
      return '[记忆系统] 当前没有存储任何记忆。你可以使用 memory 工具来保存重要信息。'
    }

    const lines = [
      `[记忆系统] 共 ${entries.length} 条记忆`,
      '',
      '记忆索引: ',
      index,
      '',
      '使用 memory 工具的 read 操作来读取具体记忆内容。',
      '记忆是线索，不是事实 —— 使用前先验证其准确性。',
    ]

    return lines.join('\n')
  }

  private updateIndex(name: string, filename: string, description: string) {
    const indexContent = fs.readFileSync(this.indexPath, 'utf8')
    const lines = indexContent.split('\n')

    const existingIdx = lines.findIndex((l) => l.includes(`(${filename})`))
    const newLine = `- [${name}(${filename})] -- ${description}`

    if (existingIdx >= 0) {
      lines[existingIdx] = newLine
    } else {
      if (lines.length >= MAX_INDEX_LINES) {
        console.log(
          `[memory] 索引已达 ${MAX_INDEX_LINES} 行上限，移除最早的条目`,
        )
        const firstEntry = lines.findIndex((l) => l.startsWith('- '))
        if (firstEntry >= 0) lines.splice(firstEntry, 1)
      }
      lines.push(newLine)
    }

    fs.writeFileSync(this.indexPath, lines.join('\n'), 'utf8')
  }

  private parseFrontmatter(raw: string): Omit<MemoryEntry, 'filePath'> | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match) return null

    const meta: Record<string, string> = {}
    for (const line of match[1].split('\n')) {
      const idx = line.indexOf(':')
      if (idx > 0) {
        meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
      }
    }

    const validTypes = ['user', 'feedback', 'project', 'reference']
    if (!meta.name || !meta.type || !validTypes.includes(meta.type)) return null

    return {
      name: meta.name,
      description: meta.description || '',
      type: meta.type as MemoryEntry['type'],
      content: match[2].trim(),
    }
  }
}
