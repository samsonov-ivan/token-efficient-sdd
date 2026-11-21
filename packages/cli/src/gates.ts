import { qualityCommand } from './quality/command.js';

export function gates(argv: string[]) {
  return qualityCommand('gates', argv);
}
