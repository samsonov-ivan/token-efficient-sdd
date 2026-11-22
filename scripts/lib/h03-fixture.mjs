export const fixtureName = 'synthetic-git-log';
export const fixtureCommand = 'git log --oneline';
export const archivePath = /^Full output \(project root\): (\.frugal\/logs\/([a-f0-9]{64})\.log)$/m;
export const targetSubject = 'Public fixture example no. 12';
export const fixtureDates = {
  GIT_AUTHOR_DATE: '2026-11-21T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-11-21T00:00:00Z',
};

export async function createHistory(git) {
  await git('init', '-q', '--object-format=sha1');
  for (let i = 0; i < 24; i++) {
    await git(
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'user.name=Fixture',
      'commit',
      '--allow-empty',
      '-qm',
      `Public fixture example no. ${i}`,
    );
  }
}
