export function repairToolOutputEncoding(value) {
  return String(value || "").replace(/^(\d{4}-\d{2}-\d{2})[ \t]+�+[ \t\r]*$/gm, (line, dateText) => {
    const [year, month, day] = dateText.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (Number.isNaN(date.getTime())) return line;
    return `${dateText} 星期${["日", "一", "二", "三", "四", "五", "六"][date.getUTCDay()]}`;
  });
}
