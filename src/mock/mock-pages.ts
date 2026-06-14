export const MOCK_PAGES: Record<string, string> = {
  'https://esm.sh': `esm.sh - 一个免费的 ES module CDN...`,
  'https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling': `AI SDK Core - Tools and Tool Calling
工具是模型可以决定调用的函数。一个工具由三部分组成：
- description：告诉模型何时使用这个工具
- inputSchema：通过 Zod 或 JSON Schema 定义参数
- execute：实际在服务端运行的函数...`,
  // ... 更多预定义页面
}
