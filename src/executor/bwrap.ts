export function workspaceMounts(
  workspace: string,
  options: { privateTmp: boolean; sharedScratch?: string },
): string[] {
  const workspaceBind = ['--bind', workspace, workspace];
  const scratch =
    options.sharedScratch && !(options.privateTmp && options.sharedScratch === '/tmp')
      ? options.sharedScratch
      : undefined;
  const scratchInsidePrivateTmp = Boolean(
    options.privateTmp && scratch && scratch.startsWith('/tmp/'),
  );
  const scratchBind = scratch ? ['--bind', scratch, scratch] : [];
  const otherMounts = [
    ...(!scratchInsidePrivateTmp ? scratchBind : []),
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    ...(options.privateTmp ? ['--tmpfs', '/tmp'] : []),
    ...(scratchInsidePrivateTmp ? scratchBind : []),
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
