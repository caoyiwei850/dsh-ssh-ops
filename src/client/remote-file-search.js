// Search directory names using SFTP listings without following symlinks.
export async function searchRemoteFiles(list, root, query, { signal, maxDirectories = 200, maxResults = 200, timeoutMs = 15000 } = {}) {
  const queue = [root];
  const results = [];
  const errors = [];
  const deadline = Date.now() + timeoutMs;
  let visited = 0;
  let reason = null;
  let queueLimited = false;
  const needle = query.toLocaleLowerCase();
  while (queue.length && visited < maxDirectories && results.length < maxResults) {
    if (signal?.aborted) { reason = 'cancelled'; break; }
    const remaining = deadline - Date.now();
    if (remaining <= 0) { reason = 'timeout'; break; }
    const dir = queue.shift();
    visited++;
    let timer;
    let abort;
    try {
      const listing = await Promise.race([
        list(dir),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), remaining);
          abort = () => reject(new Error('cancelled'));
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        })
      ]);
      for (const entry of listing?.entries ?? []) {
        if (!entry.name || entry.name === '.' || entry.name === '..' || entry.name.includes('/')) continue;
        const path = `${dir === '/' ? '' : dir.replace(/\/+$/, '')}/${entry.name}`;
        if (entry.name.toLocaleLowerCase().includes(needle)) results.push({ path, isDirectory: entry.isDirectory });
        if (results.length >= maxResults) break;
        if (entry.isDirectory && (entry.mode & 0o170000) !== 0o120000) {
          if (visited + queue.length < maxDirectories) queue.push(path);
          else queueLimited = true;
        }
      }
    } catch (error) {
      if (signal?.aborted || error.message === 'cancelled') { reason = 'cancelled'; break; }
      if (error.message === 'timeout') { reason = 'timeout'; break; }
      errors.push({ path: dir, message: error.message });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  if (!reason && (queueLimited || queue.length || results.length >= maxResults)) reason = 'limit';
  return { results, errors, visited, reason };
}
