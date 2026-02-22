import { AVAILABLE_DOCS_BLOCK } from '../prompts/available-docs.generated'

export function buildFictTaskPrompt(task: string): string {
  return `You can use the Fict MCP server. Produce correct, idiomatic Fict output.

Rules:
1) For Fict-related tasks, call list-sections first unless relevant section ids are already in context.
2) Call get-documentation for only the sections needed by this task.
3) Before returning any Fict code, call fict-autofixer with the full file map.
4) If fict-autofixer returns issues, fix the code and call fict-autofixer again until ok=true.
5) Ground framework-specific answers in fetched documentation instead of memory.
6) If the user asks for a runnable demo without writing files, call playground-link.

Available docs:
${AVAILABLE_DOCS_BLOCK}

User task:
${task}
`
}
