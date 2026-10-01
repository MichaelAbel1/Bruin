/** A deliberately small set of fixed, read-only commands for unattended execution. */
export function isAutoSafeShell(command: string): boolean {
  return [
    'pwd',
    'git status',
    'git status --short',
    'git diff --stat',
    'git diff --name-only',
    'git branch --show-current',
  ].includes(command.trim());
}

/** Check for dangerous or malicious shell patterns (destructive deletion, fork bombs, disk wipe, etc.) */
export function isMaliciousShell(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  // 1. Destructive deletion of system/root/user directories (POSIX and Windows)
  const segments = trimmed.split(/[;&|\n]/);
  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;

    // Check for rm
    const rmIndex = tokens.findIndex((t) => t === 'rm' || /(?:\\|\/)rm(?:\.exe)?$/i.test(t));
    if (rmIndex !== -1) {
      const args = tokens.slice(rmIndex + 1);
      const isRecursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive');
      if (isRecursive) {
        const targetsRoot = args.some((a) =>
          /^([~/]|\/root|\/etc|\/bin|\/sbin|\/usr|\/var|\/System|\/Library|\$HOME|\${HOME}|\/\*|\/\.\*|~\/\*|~\/\.\*)$/i.test(
            a,
          ),
        );
        if (targetsRoot) return true;
      }
    }

    // Check for Windows rd, rmdir, del, erase
    const winIndex = tokens.findIndex(
      (t) =>
        /^(rd|rmdir|del|erase)$/i.test(t) || /(?:\\|\/)(rd|rmdir|del|erase)(?:\.exe)?$/i.test(t),
    );
    if (winIndex !== -1) {
      const args = tokens.slice(winIndex + 1);
      const isRecursive = args.some((a) => /^\/[sS]$/i.test(a));
      if (isRecursive) {
        const targetsRoot = args.some((a) =>
          /^([a-zA-Z]:\\?|%SystemDrive%|%USERPROFILE%|%WINDIR%|\\)$/i.test(a),
        );
        if (targetsRoot) return true;
      }
    }
  }

  // 2. Dangerous raw disk writes or formatting
  if (
    /\b(mkfs(\.[a-z0-9]+)?|fdisk|parted)\b/i.test(trimmed) ||
    /\bformat\s+[a-zA-Z]:/i.test(trimmed)
  ) {
    return true;
  }
  if (/\bdd\s+[^;&|]*\bof=\/dev\/(r?disk|sd|hd|nvme|mapper|zero|null)\b/i.test(trimmed)) {
    return true;
  }
  if (/>\s*\/dev\/(r?disk|sd|hd|nvme)\b/i.test(trimmed)) {
    return true;
  }

  // 3. Fork bombs
  if (/:\(\)\s*\{\s*:\|:&\s*\};:/i.test(trimmed)) {
    return true;
  }

  // 4. Remote script piped directly into shell execution
  if (
    /\b(curl|wget)\b[^|;&\n]+?\|\s*(sudo\s+)?(bash|sh|zsh|python|python3|perl|ruby|node|powershell|pwsh)\b/i.test(
      trimmed,
    ) ||
    /\b(iwr|Invoke-WebRequest|curl)\b[^|;&\n]+?\|\s*(iex|Invoke-Expression)\b/i.test(trimmed)
  ) {
    return true;
  }

  // 5. System shutdown / reboot / halt
  if (/\b(shutdown|reboot|poweroff|halt)\b/i.test(trimmed)) {
    return true;
  }
  if (/\binit\s+[06]\b/i.test(trimmed)) {
    return true;
  }

  // 6. Mass recursive permission stripping on root or home
  if (
    /\b(chmod|chown)\s+-[a-zA-Z]*R[a-zA-Z]*\s+[^;&|]+\s+([~/]|\$HOME|\${HOME})(?=\s|$|[;&|])/i.test(
      trimmed,
    )
  ) {
    return true;
  }

  return false;
}
