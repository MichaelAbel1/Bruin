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

  // 1. Destructive deletion of system/root/user directories
  if (
    /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+([~/]|\/root|\/etc|\/bin|\/sbin|\/usr|\/var|\/System|\/Library|\$HOME|\${HOME})(?=\s|$|[;&|])/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  if (/\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+(\/\*|\/\.\*|~\/\*|~\/\.\*)(?=\s|$|[;&|])/i.test(trimmed)) {
    return true;
  }

  // 2. Dangerous raw disk writes or formatting
  if (/\b(mkfs(\.[a-z0-9]+)?|fdisk|parted)\b/i.test(trimmed)) {
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
  if (/\b(curl|wget)\b[^|;&\n]+?\|\s*(sudo\s+)?(bash|sh|zsh)\b/i.test(trimmed)) {
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
