/**
 * Webpack-build stub for src/ai/skillLoader.ts.
 *
 * The original file uses Vite's `import.meta.glob` to bundle the
 * AI-pipeline skill prompts at build time. webpack does not understand
 * `import.meta.glob`, so we swap this stub in for the JupyterLab
 * federated bundle via NormalModuleReplacementPlugin (see webpack.config.js).
 *
 * The skill prompts are what let the model fetch pipeline templates on
 * demand; without them the chat still works, it just answers without
 * template tools. The DocWidget *does* mount the chat box (PipelineEditor
 * renders PipelineChatBox unconditionally), so this stub must export the
 * complete surface of the real module — a missing export becomes an
 * `undefined is not a function` crash the moment a user sends a message.
 * `tests/ts/jupyterlab/skillLoaderStub.test.ts` guards that parity.
 */

export interface PipelineSkill {
  name: string;
  description: string;
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, never> };
}

/** OpenAI-compatible function tool definition shape (also used by PLaMo and OpenRouter). */
export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: { type: "object"; properties: Record<string, never> };
  };
}

export function parseFrontmatter(raw: string): {
  attrs: Record<string, string>;
  content: string;
} {
  return { attrs: {}, content: raw };
}

export function loadSkills(): PipelineSkill[] {
  return [];
}

export function buildToolDefinitions(_skills: PipelineSkill[]): ToolDefinition[] {
  return [];
}

export function buildOpenAITools(_skills: PipelineSkill[]): OpenAITool[] {
  return [];
}

export function executeSkill(_skills: PipelineSkill[], _toolName: string): string | null {
  return null;
}

export function getSkills(): PipelineSkill[] {
  return [];
}
