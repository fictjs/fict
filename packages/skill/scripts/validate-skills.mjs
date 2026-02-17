#!/usr/bin/env node

import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { PACKAGE_ROOT, loadManifest, loadSkillModel, renderAgentsMarkdown } from './skill-lib.mjs'

const args = process.argv.slice(2)
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
      console.error(`\n✗ ${skill.name}:`)
      for (const error of model.errors) {
        console.error(`  - ${error}`)
      }
      continue
    }

    const expected = renderAgentsMarkdown(skill, model.metadata, model.sections)
    const agentsPath = path.join(PACKAGE_ROOT, 'skills', skill.agents)

    let actual = ''
    try {
      actual = await readFile(agentsPath, 'utf8')
    } catch {
      hasErrors = true
      console.error(
        `\n✗ ${skill.name}: missing AGENTS.md (${path.relative(PACKAGE_ROOT, agentsPath)})`,
      )
      continue
    }

    if (actual !== expected) {
      hasErrors = true
      console.error(
        `\n✗ ${skill.name}: AGENTS.md is out of date (${path.relative(PACKAGE_ROOT, agentsPath)})`,
      )
      continue
    }

    console.log(`✓ ${skill.name}: valid`)
  }

  if (hasErrors) {
    process.exit(1)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
