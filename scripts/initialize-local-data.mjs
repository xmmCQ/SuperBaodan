import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const todoFile = process.env.SUPER_BAODAN_TODO_FILE || path.join(root, "data", "work-todo.md");

await mkdir(path.dirname(todoFile), { recursive: true });
try {
  await writeFile(todoFile, "# 工作待办\n\n", { encoding: "utf8", flag: "wx" });
  console.log("已创建空白工作待办。");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("工作待办已存在，保留原有内容。");
}
