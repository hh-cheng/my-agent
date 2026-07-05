export interface Chunk {
  id: string
  text: string
  source: string // 来源文件
  index: number // 在文档中的位置
  estimatedTokens: number
}

const TARGET_TOKENS = 256
const CHARS_PER_TOKEN = 4
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN

function makeChunk(source: string, text: string, index: number): Chunk {
  return {
    text,
    index,
    source,
    id: `${source}#${index}`,
    estimatedTokens: Math.ceil(text.length / CHARS_PER_TOKEN),
  }
}

export function chunkDocument(source: string, text: string): Chunk[] {
  const paragraphs = text.split(/\n{2,}/)
  const chunks: Chunk[] = []

  let idx = 0
  let buffer = ''

  for (const p of paragraphs) {
    const trimmed = p.trim()
    if (!trimmed) continue

    // 当前缓冲区 + 新段落超过目标大小的话就先把缓冲区存下来
    if (
      buffer.length + trimmed.length + 2 > TARGET_CHARS &&
      buffer.length > 0
    ) {
      chunks.push(makeChunk(source, buffer.trim(), idx++))
      buffer = ''
    }

    // 单个段落就超过目标大小的话就按句子切分
    if (trimmed.length > TARGET_CHARS) {
      if (buffer.length > 0) {
        chunks.push(makeChunk(source, buffer.trim(), idx++))
        buffer = ''
      }

      const sentences = trimmed.split(/(?<=[。！？.!?])\s*/)
      // sentBuf 用来处理“单个段落过长，但可以按句子重新组块”的情况：
      // 它把多个句子累积到接近 TARGET_CHARS，超过目标大小前落盘成 chunk。
      // 注意：如果某一句话本身已经超过 TARGET_CHARS，这里不会继续细切。
      // 需要支持超长单句时，应再加一层按字符/词/窗口切分的兜底逻辑。
      let sentBuf = ''
      for (const sent of sentences) {
        if (
          sentBuf.length + sent.length + 1 > TARGET_CHARS &&
          sentBuf.length > 0
        ) {
          chunks.push(makeChunk(source, sentBuf.trim(), idx++))
          sentBuf = ''
        }
        sentBuf += (sentBuf ? ' ' : '') + sent
      }

      if (sentBuf.trim()) {
        buffer = sentBuf.trim()
      }
    } else {
      buffer += (buffer ? '\n\n' : '') + trimmed
    }
  }

  if (buffer.trim()) {
    chunks.push(makeChunk(source, buffer.trim(), idx++))
  }

  return chunks
}
