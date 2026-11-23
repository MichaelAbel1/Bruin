import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The existing JSON-lines host owns scheduling, leases and the agent runtime.
 * No network listener or renderer is needed; credentials come from its environment. */
export async function runService(timezone?: string): Promise<void> {
  if (timezone) new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../desktop-host.js', import.meta.url))],
    {
      env: { ...process.env, BRUIN_SERVICE: '1', ...(timezone ? { TZ: timezone } : {}) },
      stdio: ['pipe', 'inherit', 'inherit'],
    },
  );
  const stop = () => child.stdin.end();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code && !signal) reject(new Error(`本地服务退出 (${code})`));
        else resolve();
      });
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    child.stdin.end();
  }
}
