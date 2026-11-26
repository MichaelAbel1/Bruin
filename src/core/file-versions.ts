import path from 'node:path';

type Event = { seq: number; type: string; payload: Record<string, unknown> };

/** Rebuild optimistic file-version tracking from durable session events for cross-process resume. */
export function reconstructFileVersions(
  events: readonly Event[],
  canonicalWorkspace: string,
): Map<string, string> {
  const versions = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'workspace_changed') {
      versions.clear();
      continue;
    }
    if (event.type !== 'tool_finished') continue;
    const name = String(event.payload.name ?? '');
    if (name === 'restore_snapshot' && !event.payload.isError) {
      versions.clear();
      continue;
    }
    if (name !== 'read_file' && name !== 'write_file' && name !== 'edit_file') continue;
    const rawPath = event.payload.filePath;
    if (typeof rawPath !== 'string' || !rawPath) continue;
    const resolved = path.resolve(canonicalWorkspace, rawPath);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (
      !event.payload.isError &&
      typeof event.payload.fileVersion === 'string' &&
      event.payload.fileVersion
    ) {
      versions.set(key, event.payload.fileVersion);
    } else if (event.payload.fileVersionCleared === true) {
      versions.delete(key);
    }
  }
  return versions;
}
