#!/usr/bin/env node
import { createProject, TEMPLATE_NAMES, type TemplateName } from './project.js';

const HELP = `Usage: create-rcx-app <directory> [--template <name>]

Templates: ${TEMPLATE_NAMES.join(', ')}`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }
  let directory = '';
  let template: TemplateName = 'hello';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--template') {
      const value = args[index + 1];
      if (!value) throw new Error('--template requires a value');
      template = value as TemplateName;
      index += 1;
    } else if (argument.startsWith('--template=')) {
      template = argument.slice('--template='.length) as TemplateName;
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (!directory) directory = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (!directory) throw new Error(`Missing target directory\n\n${HELP}`);
  const project = await createProject(directory, template);
  console.log(`Created ${project.manifest.name} in ${project.root}`);
  console.log(`Next: cd ${directory} && rcx-app validate && rcx-app dev`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
