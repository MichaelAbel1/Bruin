import path from 'node:path';

function isAllowedScratchPath(candidate: string, privateTmp: boolean): boolean {
  if (candidate === '/tmp') return !privateTmp;
  return (
    candidate.startsWith('/tmp/') ||
    candidate.startsWith('/var/tmp/') ||
    candidate.startsWith('/private/tmp/') ||
    candidate.startsWith('/private/var/folders/')
  );
}

export function workspaceMounts(
  workspace: string,
  options: { privateTmp: boolean; sharedScratch?: string },
): string[] {
  const normalizedWorkspace = path.posix.resolve(workspace);
  const workspaceBind = ['--bind', normalizedWorkspace, normalizedWorkspace];
  const candidateScratch = options.sharedScratch
    ? path.posix.resolve(options.sharedScratch)
    : undefined;
  const scratch =
    candidateScratch &&
    candidateScratch !== normalizedWorkspace &&
    !normalizedWorkspace.startsWith(`${candidateScratch}/`) &&
    isAllowedScratchPath(candidateScratch, options.privateTmp)
      ? candidateScratch
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
    options.privateTmp &&
    (normalizedWorkspace === '/tmp' || normalizedWorkspace.startsWith('/tmp/'));
  return [
    '--ro-bind',
    '/',
    '/',
    ...(insidePrivateTmp ? [...otherMounts, ...workspaceBind] : [...workspaceBind, ...otherMounts]),
  ];
}
