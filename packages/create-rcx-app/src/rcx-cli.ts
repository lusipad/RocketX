#!/usr/bin/env node
import { startDevServer } from './dev.js';
import { validateProject } from './project.js';

const HELP = `Usage:
  rcx-app validate [directory]
  rcx-app dev [directory] [--port <number>]`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }
  const command = args.shift();
  if (command === 'validate') {
    const directory = args[0] ?? '.';
    if (args.length > 1) throw new Error(`Unexpected argument: ${args[1]}`);
    const project = await validateProject(directory);
    console.log(`Valid RocketX app: ${project.manifest.id}@${project.manifest.version}`);
    console.log(`Entry: ${project.manifest.entry}`);
    return;
  }
  if (command === 'dev') {
    let directory = '.';
    let port = 4174;
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      if (argument === '--port') {
        const value = Number(args[index + 1]);
        if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error('--port must be 1-65535');
        port = value;
        index += 1;
      } else if (argument.startsWith('--port=')) {
        const value = Number(argument.slice('--port='.length));
        if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error('--port must be 1-65535');
        port = value;
      } else if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`);
      else if (directory === '.') directory = argument;
      else throw new Error(`Unexpected argument: ${argument}`);
    }
    const development = await startDevServer(directory, port);
    console.log(`RocketX app preview: ${development.url}`);
    console.log('Press Ctrl+C to stop. Install the directory in RocketX for real capability checks.');
    const stop = async () => {
      await development.close();
      process.exit(0);
    };
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
    return;
  }
  throw new Error(`Unknown command: ${command ?? ''}\n\n${HELP}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
