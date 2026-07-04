import path from 'node:path'
import { mkdir, readdir } from 'node:fs/promises'

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

  async init() {
    await mkdir(this.memoryDir, { recursive: true })
    if (!(await Bun.file(this.indexPath).exists())) {
      await Bun.write(this.indexPath, '# Memory Index\n')
    }
  }

  async save(entry: Omit<MemoryEntry, 'filePath'>) {
    await this.init()
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

    await Bun.write(filePath, fileContent)
    await this.updateIndex(entry.name, filename, entry.description)
    return filename
  }

  async search(query: string): Promise<MemoryEntry[]> {
    const all = await this.list()
    const keywords = query.toLowerCase().split(/\s+/)
    return all.filter((entry) => {
      const text =
        `${entry.name} ${entry.description} ${entry.content}`.toLowerCase()
      return keywords.some((k) => text.includes(k))
    })
  }

  async list() {
    await this.init()
    const entries: MemoryEntry[] = []
    const files = (await readdir(this.memoryDir)).filter(
      (f) => f.endsWith('.md') && f !== INDEX_FILE,
    )

    for (const file of files) {
      const filePath = path.join(this.memoryDir, file)
      const raw = await Bun.file(filePath).text()
      const parsed = this.parseFrontmatter(raw)
      if (parsed) entries.push({ ...parsed, filePath })
    }

    return entries
  }

  async loadIndex() {
    await this.init()
    const raw = await Bun.file(this.indexPath).text()
    return raw.length > MAX_FILE_CHARS
      ? raw.slice(0, MAX_FILE_CHARS) + '\n...(已截断)'
      : raw
  }

  async loadFile(filename: string) {
    const filePath = path.join(this.memoryDir, filename)
    const file = Bun.file(filePath)
    if (!(await file.exists())) return null
    const raw = await file.text()
    return raw.length > MAX_FILE_CHARS
      ? raw.slice(0, MAX_FILE_CHARS) + '\n...(已截断)'
      : raw
  }

  async delete(filename: string) {
    const filePath = path.join(this.memoryDir, filename)
    const file = Bun.file(filePath)
    if (!(await file.exists())) return false
    await file.delete()

    const indexContent = await Bun.file(this.indexPath).text()
    const lines = indexContent
      .split('\n')
      .filter((l) => !l.includes(`(${filename})`))
    await Bun.write(this.indexPath, lines.join('\n'))
    return true
  }

  async buildPromptSection() {
    await this.init()
    const index = await this.loadIndex()
    const entries = await this.list()

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

  private async updateIndex(
    name: string,
    filename: string,
    description: string,
  ) {
    const indexContent = await Bun.file(this.indexPath).text()
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

    await Bun.write(this.indexPath, lines.join('\n'))
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
