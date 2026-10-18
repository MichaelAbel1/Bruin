import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withFileLock } from '../config.js';

function registry(filename: string) {
  const parent = path.dirname(path.resolve(filename));
  const canonical = fs.existsSync(filename)
    ? fs.realpathSync(filename)
    : path.join(fs.existsSync(parent) ? fs.realpathSync(parent) : parent, path.basename(filename));
  const key = createHash('sha256').update(canonical).digest('hex');
  return path.join(os.tmpdir(), `bruin-access-${key}`);
}
function alive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0)
    throw new Error('数据库访问锁损坏，请检查后手动清理');
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
function clean(directory: string) {
  for (const name of fs.readdirSync(directory).filter((name) => name.endsWith('.json'))) {
    const file = path.join(directory, name);
    if (!fs.lstatSync(file).isFile()) throw new Error('数据库访问锁文件无效');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!alive(value.pid)) fs.unlinkSync(file);
  }
}
function claim(filename: string, maintenance: boolean): () => void {
  const directory = registry(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('数据库访问锁目录无效');
  if (process.getuid && stat.uid !== process.getuid())
    throw new Error('数据库访问锁不属于当前用户');
  const file = path.join(directory, `${maintenance ? 'maintenance' : randomUUID()}.json`);
  withFileLock(path.join(directory, 'gate.lock'), () => {
    clean(directory);
    const records = fs.readdirSync(directory).filter((name) => name.endsWith('.json'));
    if (records.includes('maintenance.json') || (maintenance && records.length))
      throw new Error('数据库正在使用或维护中，请先关闭桌面、CLI、ACP 和后台服务');
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  });
  let released = false;
  return () => {
    if (!released) {
      fs.unlinkSync(file);
      released = true;
    }
  };
}

export const registerDatabaseUse = (filename: string) => claim(filename, false);
export const acquireDatabaseMaintenance = (filename: string) => claim(filename, true);
