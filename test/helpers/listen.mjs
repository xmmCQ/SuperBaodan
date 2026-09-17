// Chromium/Fetch reject these ports even when Windows allocates them dynamically.
const BLOCKED = new Set([1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,5060,5061,6000,6566,6665,6666,6667,6668,6669,6697,10080]);
export async function listenOnSafePort(server) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve, reject) => {
      const error = value => reject(value);
      server.once('error', error);
      server.listen(0, '127.0.0.1', () => { server.off('error', error); resolve(); });
    });
    if (!BLOCKED.has(server.address().port)) return server.address().port;
    await new Promise(resolve => server.close(resolve));
  }
  throw new Error('无法分配可用于界面测试的端口');
}
