import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const PACKAGE_ROOT = path.resolve(__dirname, '..')
export const SKILLS_ROOT = path.join(PACKAGE_ROOT, 'skills')
export const MANIFEST_PATH = path.join(SKILLS_ROOT, 'manifest.json')

function parseFrontmatter(content, sourceLabel = 'document') {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!match) {
    return { attributes: {}, body: content }
  }

  let parsed
  try {
    parsed = parseYaml(match[1])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid YAML frontmatter in ${sourceLabel}: ${message}`)
  }

  if (parsed == null) {
    return {
      attributes: {},
      body: content.slice(match[0].length),
    }
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Frontmatter in ${sourceLabel} must be a YAML object`)
  }

  return {
    attributes: parsed,
    body: content.slice(match[0].length),
  }
}

function parseReferencesLine(line) {
  const refs = []
  for (const match of line.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    refs.push(match[1])
  }

  if (refs.length > 0) {
    return refs
  }

  const plain = line.replace(/^References?:\s*/i, '').trim()
  if (!plain) return []

  for (const token of plain.split(',').map(item => item.trim())) {
    if (token.startsWith('http://') || token.startsWith('https://')) {
      refs.push(token)
    }
  }

  return refs
}

function inferSectionFromFilename(filename, sections) {
  const name = filename.replace(/\.md$/, '')
  const parts = name.split('-')

  for (let len = parts.length; len >= 1; len -= 1) {
    const prefix = parts.slice(0, len).join('-')
    const section = sections.find(item => item.prefix === prefix)
    if (section) {
      return section
    }
  }

  return null
}

function normalizeMultilineText(lines) {
  const text = lines.join('\n').trim()
  if (!text) return ''

  return text
    .split('\n\n')
    .map(block => block.trim())
    .filter(Boolean)
    .join('\n\n')
}

function toStringField(value) {
  return typeof value === 'string' ? value : ''
}

function toStringArrayField(value) {
  if (Array.isArray(value)) {
    return value
      .filter(item => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean)
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
  }

  return []
}

function parseRule(content, sourceLabel) {
  const { attributes, body } = parseFrontmatter(content, sourceLabel)
  const lines = body.replace(/\r\n/g, '\n').split('\n')

  let headingIndex = -1
  let headingTitle = ''
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line.startsWith('## ')) {
      headingIndex = index
      headingTitle = line.replace(/^##\s+/, '').trim()
      break
    }
  }

  let parsedImpact = ''
  let parsedImpactDescription = ''
  for (const line of lines) {
    const match = line.match(/\*\*Impact:\s*(\w+(?:-\w+)?)\s*(?:\(([^)]+)\))?/i)
    if (match) {
      parsedImpact = match[1].toUpperCase()
      parsedImpactDescription = match[2]?.trim() ?? ''
      break
    }
  }

  const labelPattern = /^\*\*([^:]+):\*\*$/
  const examples = []
  const explanationLines = []
  const references = []

  let index = headingIndex === -1 ? 0 : headingIndex + 1
  while (index < lines.length) {
    const rawLine = lines[index]
    const line = rawLine.trim()

    if (line.startsWith('Reference:') || line.startsWith('References:')) {
      references.push(...parseReferencesLine(line))
      index += 1
      continue
    }

    const labelMatch = line.match(labelPattern)
    if (labelMatch) {
      const rawLabel = labelMatch[1].trim()
      const descMatch = rawLabel.match(/^(.+?)\s*\((.+)\)$/)

      index += 1
      while (index < lines.length && lines[index].trim() === '') {
        index += 1
      }

      let language = 'tsx'
      const codeLines = []
      if (index < lines.length && lines[index].trim().startsWith('```')) {
        language = lines[index].trim().slice(3).trim() || 'tsx'
        index += 1
        while (index < lines.length && !lines[index].trim().startsWith('```')) {
          codeLines.push(lines[index])
          index += 1
        }
        if (index < lines.length && lines[index].trim().startsWith('```')) {
          index += 1
        }
      }

      const extraLines = []
      while (index < lines.length) {
        const lookahead = lines[index].trim()
        if (lookahead.startsWith('Reference:') || lookahead.startsWith('References:')) {
          break
        }
        if (labelPattern.test(lookahead)) {
          break
        }
        extraLines.push(lines[index])
        index += 1
      }

      examples.push({
        label: descMatch ? descMatch[1].trim() : rawLabel,
        description: descMatch ? descMatch[2].trim() : undefined,
        language,
        code: codeLines.join('\n').trimEnd(),
        additionalText: normalizeMultilineText(extraLines),
      })
      continue
    }

    if (line && headingIndex !== -1) {
      explanationLines.push(rawLine)
    }
    index += 1
  }

  const attributeReferences = toStringArrayField(attributes.references)

  return {
    title: toStringField(attributes.title) || headingTitle,
    impact: (toStringField(attributes.impact) || parsedImpact || 'MEDIUM').toUpperCase(),
    impactDescription: toStringField(attributes.impactDescription) || parsedImpactDescription,
    tags: toStringArrayField(attributes.tags),
    explanation: normalizeMultilineText(explanationLines),
    examples,
    references: attributeReferences.length > 0 ? attributeReferences : references,
  }
}

export async function loadManifest() {
  const raw = await readFile(MANIFEST_PATH, 'utf8')
  const manifest = JSON.parse(raw)
  if (!Array.isArray(manifest.skills)) {
    throw new Error('Invalid manifest: "skills" must be an array')
  }
  return manifest
}

export async function parseSectionsFile(sectionsPath) {
  const content = await readFile(sectionsPath, 'utf8')
  const matches = [...content.matchAll(/^##\s+(\d+)\.\s+(.+?)\s+\(([^)]+)\)\s*$/gm)]

  const sections = []
  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i]
    const next = matches[i + 1]
    const number = Number(current[1])
    const title = current[2].trim()
    const prefix = current[3].trim()
    const blockStart = current.index + current[0].length
    const blockEnd = next ? next.index : content.length
    const block = content.slice(blockStart, blockEnd)

    const impactMatch = block.match(/\*\*Impact:\*\*\s+([A-Z-]+)/i)
    const descriptionMatch = block.match(/\*\*Description:\*\*\s+([\s\S]*)$/i)

    sections.push({
      number,
      title,
      prefix,
      impact: (impactMatch?.[1] || 'MEDIUM').toUpperCase(),
      description: descriptionMatch?.[1]?.trim().replace(/\n+/g, ' ') || '',
    })
  }

  sections.sort((a, b) => a.number - b.number)
  return sections
}

function anchorFromHeading(text) {
  return text
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
}

function formatExample(example) {
  const label = example.description
    ? `**${example.label}: ${example.description}**`
    : `**${example.label}:**`

  let out = `${label}\n\n`
  if (example.code) {
    out += `\`\`\`${example.language || 'tsx'}\n${example.code}\n\`\`\`\n\n`
  }
  if (example.additionalText) {
    out += `${example.additionalText}\n\n`
  }

  return out
}

export function renderAgentsMarkdown(skill, metadata, sections) {
  let md = `# ${skill.title}\n\n`
  md += `**Version ${metadata.version}**  \n`
  md += `${metadata.organization}  \n`
  md += `${metadata.date}\n\n`
  md += '> **Note:**  \n'
  md += '> This document is primarily written for coding agents maintaining Fict repositories.  \n'
  md +=
    '> It emphasizes deterministic workflows, fail-closed correctness, and repeatable release quality.\n\n'
  md += '---\n\n'
  md += '## Abstract\n\n'
  md += `${metadata.abstract}\n\n`
  md += '---\n\n'
  md += '## Table of Contents\n\n'

  for (const section of sections) {
    md += `${section.number}. [${section.title}](#${section.number}-${anchorFromHeading(section.title)}) — **${section.impact}**\n`
    for (const rule of section.rules) {
      md += `   - ${rule.id} [${rule.title}](#${anchorFromHeading(`${rule.id} ${rule.title}`)})\n`
    }
  }

  md += '\n---\n\n'

  for (const section of sections) {
    md += `## ${section.number}. ${section.title}\n\n`
    md += `**Impact: ${section.impact}**\n\n`
    if (section.description) {
      md += `${section.description}\n\n`
    }

    for (const rule of section.rules) {
      md += `### ${rule.id} ${rule.title}\n\n`
      if (rule.impactDescription) {
        md += `**Impact: ${rule.impact} (${rule.impactDescription})**\n\n`
      } else {
        md += `**Impact: ${rule.impact}**\n\n`
      }
      md += `${rule.explanation}\n\n`
      for (const example of rule.examples) {
        md += formatExample(example)
      }
      if (rule.references.length > 0) {
        const refs = rule.references.map(ref => `[${ref}](${ref})`).join(', ')
        md += `Reference: ${refs}\n\n`
      }
    }

    md += '---\n\n'
  }

  if (Array.isArray(metadata.references) && metadata.references.length > 0) {
    md += '## References\n\n'
    metadata.references.forEach((ref, index) => {
      md += `${index + 1}. [${ref}](${ref})\n`
    })
  }

  return md
}

export async function loadSkillModel(skill) {
  const skillRoot = path.join(SKILLS_ROOT, skill.path)
  const skillPath = path.join(SKILLS_ROOT, skill.skill)
  const metadataPath = path.join(SKILLS_ROOT, skill.metadata)
  const rulesDir = path.join(SKILLS_ROOT, skill.rulesDir)
  const sectionsPath = path.join(rulesDir, '_sections.md')

  const errors = []
  const required = [skillPath, metadataPath, rulesDir, sectionsPath]
  for (const file of required) {
    if (!existsSync(file)) {
      errors.push(`Missing required file: ${path.relative(PACKAGE_ROOT, file)}`)
    }
  }

  let metadata = null
  let sections = []
  const rules = []

  if (existsSync(skillPath)) {
    const skillDoc = await readFile(skillPath, 'utf8')

    try {
      const { attributes } = parseFrontmatter(skillDoc, path.relative(PACKAGE_ROOT, skillPath))
      if (!toStringField(attributes.name)) {
        errors.push(
          `SKILL frontmatter is missing "name": ${path.relative(PACKAGE_ROOT, skillPath)}`,
        )
      }
      if (!toStringField(attributes.description)) {
        errors.push(
          `SKILL frontmatter is missing "description": ${path.relative(PACKAGE_ROOT, skillPath)}`,
        )
      }
      if (toStringField(attributes.name) && toStringField(attributes.name) !== skill.name) {
        errors.push(
          `SKILL frontmatter name (${attributes.name}) does not match manifest (${skill.name})`,
        )
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(message)
    }
  }

  if (existsSync(metadataPath)) {
    const rawMetadata = await readFile(metadataPath, 'utf8')
    metadata = JSON.parse(rawMetadata)
    for (const key of ['version', 'organization', 'date', 'abstract']) {
      if (!metadata[key]) {
        errors.push(`Metadata missing field "${key}": ${path.relative(PACKAGE_ROOT, metadataPath)}`)
      }
    }
  }

  if (existsSync(sectionsPath)) {
    sections = await parseSectionsFile(sectionsPath)
    if (sections.length === 0) {
      errors.push(`No sections parsed from: ${path.relative(PACKAGE_ROOT, sectionsPath)}`)
    }
  }

  if (existsSync(rulesDir)) {
    const files = (await readdir(rulesDir))
      .filter(file => file.endsWith('.md') && !file.startsWith('_'))
      .sort()

    if (files.length === 0) {
      errors.push(`No rule files found: ${path.relative(PACKAGE_ROOT, rulesDir)}`)
    }

    for (const file of files) {
      const filePath = path.join(rulesDir, file)
      let parsed

      try {
        parsed = parseRule(await readFile(filePath, 'utf8'), path.relative(PACKAGE_ROOT, filePath))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        errors.push(message)
        continue
      }

      const section = inferSectionFromFilename(file, sections)

      if (!section) {
        errors.push(
          `Unable to infer section from filename: ${path.relative(PACKAGE_ROOT, filePath)}`,
        )
        continue
      }

      if (!parsed.title) {
        errors.push(`Rule is missing title: ${path.relative(PACKAGE_ROOT, filePath)}`)
      }

      if (!parsed.explanation) {
        errors.push(`Rule is missing explanation: ${path.relative(PACKAGE_ROOT, filePath)}`)
      }

      if (parsed.examples.length === 0) {
        errors.push(`Rule has no examples: ${path.relative(PACKAGE_ROOT, filePath)}`)
      } else {
        const hasBad = parsed.examples.some(example => {
          const label = example.label.toLowerCase()
          return label.includes('incorrect') || label.includes('bad') || label.includes('wrong')
        })
        const hasGood = parsed.examples.some(example => {
          const label = example.label.toLowerCase()
          return label.includes('correct') || label.includes('good')
        })

        if (!hasBad || !hasGood) {
          errors.push(
            `Rule must include both incorrect and correct examples: ${path.relative(PACKAGE_ROOT, filePath)}`,
          )
        }
      }

      rules.push({
        ...parsed,
        file,
        section,
      })
    }
  }

  const sectionMap = new Map(sections.map(section => [section.number, { ...section, rules: [] }]))
  rules.sort((a, b) => a.title.localeCompare(b.title, 'en-US', { sensitivity: 'base' }))

  for (const rule of rules) {
    const target = sectionMap.get(rule.section.number)
    if (target) {
      target.rules.push(rule)
    }
  }

  const sectionList = [...sectionMap.values()].sort((a, b) => a.number - b.number)
  for (const section of sectionList) {
    section.rules.sort((a, b) => a.title.localeCompare(b.title, 'en-US', { sensitivity: 'base' }))
    section.rules.forEach((rule, index) => {
      rule.id = `${section.number}.${index + 1}`
    })
  }

  return {
    skillRoot,
    metadata,
    sections: sectionList,
    errors,
  }
}

export async function writeSkillAgents(skill, markdown) {
  const outputPath = path.join(SKILLS_ROOT, skill.agents)
  await writeFile(outputPath, markdown, 'utf8')
  return outputPath
}
