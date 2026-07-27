import type { JsonTemplate } from './types.js';

export interface PlaybookTemplateContext {
  input: unknown;
  steps: Record<string, { input: unknown; output: unknown; evidence: unknown[]; status: string }>;
}

export function resolveTemplate(template: JsonTemplate, context: PlaybookTemplateContext): unknown {
  if (template === null || typeof template === 'boolean' || typeof template === 'number' || typeof template === 'string') {
    return template;
  }
  if (Array.isArray(template)) {
    return template.map((value) => resolveTemplate(value, context)).filter((value) => value !== undefined);
  }
  const object = template as Record<string, JsonTemplate>;
  if (Object.keys(object).length === 1 && typeof object.$ref === 'string') {
    return readPath(context, object.$ref);
  }
  return Object.fromEntries(
    Object.entries(object)
      .map(([key, value]) => [key, resolveTemplate(value, context)] as const)
      .filter(([, value]) => value !== undefined)
  );
}

function readPath(root: unknown, path: string): unknown {
  const clean = path.replace(/^\$\.?/, '');
  if (!clean) return root;
  let current: unknown = root;
  for (const segment of clean.split('.')) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
