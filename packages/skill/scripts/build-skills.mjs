#!/usr/bin/env node

import path from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  PACKAGE_ROOT,
  loadManifest,
  loadSkillModel,
  renderAgentsMarkdown,
  writeSkillAgents,
} from './skill-lib.mjs'

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const skillArg = args.find(arg => arg.startsWith('--skill='))
const selectedSkill = skillArg ? skillArg.split('=')[1] : null

async function main() {
  const manifest = await loadManifest()
  const skills = selectedSkill
    ? manifest.skills.filter(skill => skill.name === selectedSkill)
    : manifest.skills

  if (skills.length === 0) {
    throw new Error(selectedSkill ? `Unknown skill: ${selectedSkill}` : 'No skills configured')
  }

  let hasErrors = false

  for (const skill of skills) {
    const model = await loadSkillModel(skill)

    if (model.errors.length > 0) {
      hasErrors = true
      console.error(`\n✗ ${skill.name} validation failed:`)
      for (const error of model.errors) {
        console.error(`  - ${error}`)
      }
      continue
    }

    const markdown = renderAgentsMarkdown(skill, model.metadata, model.sections)

    const outputPath = path.join(PACKAGE_ROOT, 'skills', skill.agents)
    if (checkOnly) {
      const current = await readFile(outputPath, 'utf8')
      if (current !== markdown) {
        hasErrors = true
        console.error(
          `\n✗ ${skill.name} AGENTS.md is out of date: ${path.relative(PACKAGE_ROOT, outputPath)}`,
        )
      } else {
        console.log(`✓ ${skill.name} AGENTS.md is up to date`)
      }
      continue
    }

    const written = await writeSkillAgents(skill, markdown)
    console.log(`✓ Built ${skill.name}: ${path.relative(PACKAGE_ROOT, written)}`)
  }

  if (hasErrors) {
    process.exit(1)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
