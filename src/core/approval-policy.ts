import path from 'node:path';

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

/** Tokenize a single shell segment, merging adjacent quoted chunks (e.g. r'm' -> rm). */
function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (
        ch === '\\' &&
        i + 1 < segment.length &&
        (segment[i + 1] === '"' || segment[i + 1] === '\\')
      ) {
        current += segment[++i];
      } else if (ch === '"') {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (inToken) tokens.push(current);
  return tokens;
}

function stripLeadingDelimiters(token: string): string {
  return token.replace(/^(?:\$\(|\(|`|\{)+/, '').replace(/(?:\)|`|\})+$/, '');
}

function isProtectedPosixTarget(raw: string): boolean {
  const cleaned = stripLeadingDelimiters(raw.replace(/^["']|["']$/g, ''));
  if (!cleaned) return false;
  if (/^(?:~|\$HOME|\$\{HOME\})(?:\/(?:\.|\*|.*)?)?$/i.test(cleaned)) {
    const sub = cleaned.replace(/^(?:~|\$HOME|\$\{HOME\})/i, '');
    if (!sub || sub === '/') return true;
    const normSub = path.posix.normalize(sub);
    if (
      normSub === '/' ||
      normSub === '/.' ||
      normSub === '.' ||
      normSub === '/*' ||
      normSub === '/.*'
    )
      return true;
    return true;
  }
  if (!cleaned.startsWith('/')) return false;
  const normalized = path.posix.normalize(cleaned).replace(/\/+$/, '') || '/';
  return (
    normalized === '/' ||
    normalized === '/*' ||
    normalized === '/.*' ||
    /^\/(root|home|Users|etc|bin|sbin|usr|var|System|Library|Applications)(\/.*)?$/i.test(
      normalized,
    )
  );
}

const rawBlockDevice =
  '(?:r?disk[0-9]+(?:s[0-9]+)?|sd[a-z]+[0-9]*|hd[a-z]+[0-9]*|nvme[0-9]+n[0-9]+(?:p[0-9]+)?|vd[a-z]+[0-9]*|xvd[a-z]+[0-9]*|mmcblk[0-9]+(?:p[0-9]+)?|mapper\\/[^\\s;&|]+)';
const ddBlockRegex = new RegExp(`\\bdd\\s+[^;&|]*\\bof=\\/dev\\/${rawBlockDevice}\\b`, 'i');
const redirectBlockRegex = new RegExp(`>\\s*\\/dev\\/${rawBlockDevice}\\b`, 'i');

/** Check for dangerous or malicious shell patterns (destructive deletion, fork bombs, disk wipe, etc.) */
export function isMaliciousShell(command: string, depth = 0): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  // 1. Destructive deletion of system/root/user directories (POSIX and Windows)
  // Split on command separators, also stripping outer subshell/backtick wrappers.
  const segments = trimmed.split(/[;&|\n]/);
  for (const seg of segments) {
    const rawTokens = tokenizeSegment(seg.trim());
    if (!rawTokens.length) continue;
    const tokens = rawTokens.map(stripLeadingDelimiters).filter(Boolean);
    if (!tokens.length) continue;

    // Inspect nested shell wrappers (bash -c "...", sh -c '...', eval "...", cmd /c "...", powershell -c "...")
    if (depth < 4) {
      for (let i = 0; i < tokens.length; i++) {
        const cmdName = path.posix.basename(tokens[i].replace(/\\/g, '/')).toLowerCase();
        if (cmdName === 'eval' && i + 1 < tokens.length) {
          if (isMaliciousShell(rawTokens.slice(i + 1).join(' '), depth + 1)) return true;
        }
        if (
          ['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'sh.exe', 'bash.exe'].includes(cmdName) ||
          ['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(cmdName)
        ) {
          for (let j = i + 1; j < tokens.length - 1; j++) {
            if (/^(?:-[a-z]*c[a-z]*|\/c|-command)$/i.test(tokens[j])) {
              if (isMaliciousShell(rawTokens.slice(j + 1).join(' '), depth + 1)) return true;
            }
          }
        }
      }
    }

    // Check for rm
    const rmIndex = tokens.findIndex((t) => t === 'rm' || /(?:\\|\/)rm(?:\.exe)?$/i.test(t));
    if (rmIndex !== -1) {
      const args = tokens.slice(rmIndex + 1);
      const isRecursive = args.some(
        (a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive' || /^-recurse$/i.test(a),
      );
      if (isRecursive && args.some((raw) => isProtectedPosixTarget(raw))) {
        return true;
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
            /^(?:%HOMEDRIVE%%HOMEPATH%|%(?:APPDATA|LOCALAPPDATA)%)(\/.*)?$/i.test(normalized) ||
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
  if (ddBlockRegex.test(trimmed) || redirectBlockRegex.test(trimmed)) {
    return true;
  }

  // 3. Fork bombs
  if (/:\(\)\s*\{\s*:\|:&\s*\};:/i.test(trimmed)) {
    return true;
  }

  // 4. Remote script piped directly into shell execution
  if (
    /\b(curl|wget)\b[^|;&\n]+?\|\s*(?:sudo\s+|env\s+)?(?:\/[\w./-]*\/)?(bash|sh|zsh|python|python3|perl|ruby|node|powershell|pwsh)\b/i.test(
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
    /\b(chmod|chown)\s+(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)\s+[^;&|]+\s+([~/]|\/root|\/home|\/Users|\$HOME|\${HOME})(?:\/[^\s;&|]*)?(?=\s|$|[;&|])/i.test(
      trimmed,
    )
  ) {
    return true;
  }

  return false;
}
