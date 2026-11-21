const commands = {
  capsule: 'Build task context from the specification and design.',
  consistency: 'Check consistency between change artifacts.',
  gates: 'Evaluate quality gates for a completed change.',
  init: 'Configure Frugal for the target repository.',
  map: 'Build a repository symbol map.',
  meter: 'Reconcile model usage and aggregate calls by stage.',
  report: 'Generate an offline report from recorded runs.',
  run: 'Run an isolated SDD pipeline.',
  trace: 'Trace requirements and scenarios to code and tests.',
} as const;

type Command = keyof typeof commands;

const qualityUsage =
  '<change> --expected FILE --out DIR [--repo DIR] [--infer] [--prepare | --assessment FILE] ' +
  '[--signature FILE --reviewer-key FILE] [--openspec BIN] [--capability ID]';

const moduleUsage: Partial<Record<Command, string>> = {
  consistency: `${qualityUsage} [--evidence FILE]`,
  gates: `${qualityUsage} --evidence FILE`,
  meter: '<run-dir> [--out <dir>]',
  report: '<runs-dir> [options]',
  run: '--mode <mode> --feature <id> --model <id> [--variant <name>] [--runs N] [--dry-run]',
  trace: `${qualityUsage} --evidence FILE`,
};

function isCommand(value: string): value is Command {
  return Object.hasOwn(commands, value);
}

export async function main(args: string[]): Promise<number> {
  const [name, ...options] = args;
  if (!name || name === '-h' || name === '--help') {
    console.log('Usage: frugal <command> [options]\n');
    for (const [command, description] of Object.entries(commands)) {
      console.log(`  ${command.padEnd(12)}${description}`);
    }
    console.log('\nRun frugal <command> --help for command usage.');
    return 0;
  }
  if (!isCommand(name)) {
    console.error(`Unknown command "${name}". Run frugal --help.`);
    return 2;
  }
  if (options.includes('-h') || options.includes('--help')) {
    console.log(`Usage: frugal ${name} ${moduleUsage[name] ?? '[options]'}\n\n${commands[name]}`);
    return 0;
  }
  if (Object.hasOwn(moduleUsage, name)) {
    const module = await import(new URL(`./${name}.js`, import.meta.url).href);
    return (await module[name](options)) ?? 0;
  }
  console.error(`frugal ${name} is not implemented in this build.`);
  return 2;
}
