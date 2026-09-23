// Fetch both panes before committing. Older requests may finish, but never
// publish data, errors or an unlock into a newer date selection.
export function createDayLoader({ prepareTasks, prepareRecords, commitDate, setLoading, showNotice, retry, slowDelay = 300 }) {
  let sequence = 0, timer;
  return async function load(date) {
    const request = ++sequence;
    clearTimeout(timer);
    setLoading(true); showNotice('');
    timer = setTimeout(() => { if (request === sequence) showNotice('正在读取…'); }, slowDelay);
    try {
      const [tasks, records] = await Promise.all([prepareTasks(date), prepareRecords(date)]);
      if (request !== sequence || !tasks?.current() || !records?.current()) return;
      // Synchronous commits: the browser cannot paint a mixed-date frame.
      tasks.commit(); records.commit(); commitDate(date);
      showNotice('');
      return tasks.fresh;
    } catch (error) {
      if (request !== sequence) return;
      showNotice(`读取失败，已保留原内容：${error.message}`, () => retry(date));
      return false;
    } finally {
      if (request === sequence) { clearTimeout(timer); setLoading(false); }
    }
  };
}
