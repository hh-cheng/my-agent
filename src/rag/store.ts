import type { Chunk } from './chunker'

export interface StoredChunk extends Chunk {
  embedding: number[]
  addedAt: number
}

export class VectorStore {
  private chunks: StoredChunk[] = []

  add(chunk: Chunk, embedding: number[]) {
    const existing = this.chunks.findIndex((c) => c.id === chunk.id)
    const chunkItem = { ...chunk, embedding, addedAt: Date.now() }
    if (existing >= 0) {
      this.chunks[existing] = chunkItem
    } else {
      this.chunks.push(chunkItem)
    }
  }

  addBatch(items: { chunk: Chunk; embedding: number[] }[]) {
    for (const { chunk, embedding } of items) {
      this.add(chunk, embedding)
    }
  }

  getAll() {
    return this.chunks
  }

  size() {
    return this.chunks.length
  }

  clear() {
    this.chunks = []
  }

  sources() {
    return Array.from(new Set(this.chunks.map((c) => c.source)))
  }
}
