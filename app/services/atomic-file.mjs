import { randomUUID as defaultRandomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';

export async function writeJsonAtomic(filePath, value, { randomUUID = defaultRandomUUID } = {}) {
  const temp = `${filePath}.super-baodan-${process.pid}-${Date.now()}-${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, filePath);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}
