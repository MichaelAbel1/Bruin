export function workspaceMounts(
  workspace: string,
  options: { privateTmp: boolean; sharedScratch?: string },
): string[] {
  const workspaceBind = ['--bind', workspace, workspace];
  const otherMounts = [
    ...(options.sharedScratch ? ['--bind', options.sharedScratch, options.sharedScratch] : []),
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    ...(options.privateTmp ? ['--tmpfs', '/tmp'] : []),
  ];
  // Bind a workspace inside /tmp after its parent so the private mount doesn't hide it.
  const insidePrivateTmp =
    options.privateTmp && (workspace === '/tmp' || workspace.startsWith('/tmp/'));
  return [
    '--ro-bind',
    '/',
    '/',
    ...(insidePrivateTmp ? [...otherMounts, ...workspaceBind] : [...workspaceBind, ...otherMounts]),
  ];
}
