import { defaultPlaygroundTemplates } from '../templates/defaults'

import type { PlaygroundTemplate } from './types'

const templateMap = new Map(defaultPlaygroundTemplates.map(template => [template.id, template]))

export function listPlaygroundTemplates(): PlaygroundTemplate[] {
  return defaultPlaygroundTemplates.map(cloneTemplate)
}

export function getPlaygroundTemplate(templateId: string): PlaygroundTemplate {
  const template = templateMap.get(templateId)
  if (!template) {
    throw new Error(`Unknown playground template: ${templateId}`)
  }
  return cloneTemplate(template)
}

export function createTemplateFiles(templateId: string): Record<string, string> {
  return getPlaygroundTemplate(templateId).files
}

function cloneTemplate(template: PlaygroundTemplate): PlaygroundTemplate {
  return {
    ...template,
    files: { ...template.files },
    ...(template.recommendedConfig ? { recommendedConfig: { ...template.recommendedConfig } } : {}),
  }
}
