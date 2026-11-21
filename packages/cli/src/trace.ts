import { qualityCommand } from './quality/command.js';

export function trace(argv: string[]) {
  return qualityCommand('trace', argv);
}
