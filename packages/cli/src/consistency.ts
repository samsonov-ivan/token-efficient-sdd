import { qualityCommand } from './quality/command.js';

export function consistency(argv: string[]) {
  return qualityCommand('consistency', argv);
}
