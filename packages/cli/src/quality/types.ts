export type ResultStatus = 'passed' | 'failed' | 'skipped';
export type Format = 'junit' | 'jest' | 'go';
export interface Suite {
  kind: 'public' | 'hidden';
  format: Format;
  path: string;
  sha256: string;
  exit_code: number;
  expected_tests: string[];
}
export interface SourceRef {
  path: string;
  line: number;
  text: string;
}
export interface Link {
  scenario: string;
  task: string;
  test: string;
  code: SourceRef;
  assertion: SourceRef;
  inferred?: boolean;
  reason?: string;
}
export type ArtifactKind = 'requirement' | 'scenario' | 'task';
export interface MissingId {
  kind: ArtifactKind;
  path: string;
  text: string;
  parent?: string;
  token: string;
}
export interface Alias {
  kind: ArtifactKind;
  path: string;
  text: string;
  parent?: string;
  id: string;
  reason: string;
}
export interface ArtifactLink extends SourceRef {
  task?: string;
  refs: string[];
  reason: string;
}
export interface Evidence {
  aliases?: Alias[];
  artifact_links?: ArtifactLink[];
  exempt_tasks?: { task: string; reason: string }[];
  final_commit: string;
  suites: Suite[];
  links: Link[];
  semantic: { requirement: string; verdict: 'pass' | 'fail'; reason: string }[];
  review: {
    round: number;
    commit?: string;
    tree?: string;
    scope: string;
    verdict: 'pass' | 'fix';
    summary: string;
  }[];
}
export interface Expected {
  version: number;
  requirements: { id: string; name?: string; scenarios: { id: string; description: string }[] }[];
  tasks: { id: string; description: string; requirements: string[] }[];
  removed?: string[];
}
export interface SpecRequirement {
  removed?: boolean;
  id: string;
  path: string;
  scenarios: string[];
  statement?: string;
  scenario_text?: Record<string, string>;
}
export interface SpecTask {
  sourceLine?: number;
  id: string;
  text: string;
  refs: string[];
  done: boolean;
}
export interface Change {
  missingIds?: MissingId[];
  designRefs?: string[];
  baseRefs?: string[];
  requirements: SpecRequirement[];
  tasks: SpecTask[];
  design: string;
  designPath: string;
  errors: string[];
  warnings: string[];
}
export const sorted = (values: Iterable<string>) => Array.from(new Set(values)).sort();
export const ratio = (n: number, d: number) => (d ? n / d : 0);
export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
