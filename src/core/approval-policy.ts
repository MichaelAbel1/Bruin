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
    const tokens: string[] = [];
    const tokenRegex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
    let tokenMatch: RegExpExecArray | null;
    while ((tokenMatch = tokenRegex.exec(seg.trim())) !== null) {
      tokens.push(tokenMatch[1] ?? tokenMatch[2] ?? tokenMatch[3]);
    }
    if (!tokens.length) continue;

    // Check for rm
    const rmIndex = tokens.findIndex((t) => t === 'rm' || /(?:\\|\/)rm(?:\.exe)?$/i.test(t));
    if (rmIndex !== -1) {
      const args = tokens.slice(rmIndex + 1);
      const isRecursive = args.some(
        (a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive' || /^-recurse$/i.test(a),
      );
      if (isRecursive) {
        const targetsRoot = args.some((raw) => {
          const a = raw.replace(/^["']|["']$/g, '').replace(/\/+$/, '') || '/';
          return (
            /^([~/]|\/\*|\/\.\*|~\/\*|~\/\.\*|\$HOME(\/.*)?|\${HOME}(\/.*)?)$/i.test(a) ||
            /^\/(root|home|Users|etc|bin|sbin|usr|var|System|Library|Applications)(\/.*)?$/i.test(a)
          );
        });
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
      const isRecursive = args.some(
        (a) =>
          /^[/-][a-zA-Z]*s/i.test(a) ||
          /^-[a-zA-Z]*r/i.test(a) ||
          /^--(recursive|recurse)$/i.test(a) ||
          /^-recurse$/i.test(a),
      );
      if (isRecursive) {
        const targetsRoot = args.some((raw) => {
          const a = raw.replace(/^["']|["']$/g, '');
          const normalized = a.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
          return (
            /^[a-zA-Z]:$/i.test(normalized) ||
            /^\/+$/.test(normalized) ||
            /^%SystemDrive%$/i.test(normalized) ||
            /^([a-zA-Z]:)?\/Users(\/.*)?$/i.test(normalized) ||
            /^%USERPROFILE%(\/.*)?$/i.test(normalized) ||
            /^%(HOMEDRIVE%HOMEPATH|APPDATA|LOCALAPPDATA)%(\/.*)?$/i.test(normalized) ||
            /^([a-zA-Z]:)?\/Windows(\/.*)?$/i.test(normalized) ||
            /^%(WINDIR|SystemRoot)%(\/.*)?$/i.test(normalized) ||
            /^([a-zA-Z]:)?\/Program Files(\s*\(x86\))?(\/.*)?$/i.test(normalized) ||
            /^([a-zA-Z]:)?\/ProgramData(\/.*)?$/i.test(normalized) ||
            /^%(ProgramFiles|ProgramFiles\(x86\)|ProgramData)%(\/.*)?$/i.test(normalized) ||
            /^%SystemDrive%\/(Users|Windows|Program Files|ProgramData)(\/.*)?$/i.test(normalized)
          );
        });
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
    /\b(chmod|chown)\s+-[a-zA-Z]*R[a-zA-Z]*\s+[^;&|]+\s+([~/]|\/root|\/home|\/Users|\$HOME|\${HOME})(?=\s|$|[;&|])/i.test(
      trimmed,
    )
  ) {
    return true;
  }

  return false;
}
