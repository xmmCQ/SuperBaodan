import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function createTempProject(prefix = "super-baodan-test-", { baseDirectory = os.tmpdir() } = {}) {
  await mkdir(baseDirectory, { recursive: true });
  // Windows TEMP may use an 8.3 username; normalize the fixture root so path
  // safety tests do not mistake that alias for a directory symlink.
  const root = await realpath(await mkdtemp(path.join(baseDirectory, prefix)));
  let cleaned = false;

  const resolve = (...parts) => path.join(root, ...parts);
  const ensureDir = async (...parts) => {
    const directory = resolve(...parts);
    await mkdir(directory, { recursive: true });
    return directory;
  };
  const write = async (relative, content, encoding = "utf8") => {
    const file = resolve(relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, encoding);
    return file;
  };
  const writeJson = (relative, value) => write(relative, `${JSON.stringify(value, null, 2)}\n`);
  const readJson = async (relative) => JSON.parse(await readFile(resolve(relative), "utf8"));
  const cleanup = async () => {
    if (cleaned) return;
    let lastError;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true });
        cleaned = true;
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 60 * (attempt + 1)));
      }
    }
    throw lastError;
  };

  return { root, resolve, ensureDir, write, writeJson, readJson, cleanup };
}
