// Startup retries must release their own ports and worker before probing saved ports.
export async function closeFrontend(server) {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

export async function stopMusicServer(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

export function isMusicDocument(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'app:' && url.hostname === 'music' && !url.port && !url.username && !url.password && url.pathname === '/';
  } catch { return false; }
}

export function listenFrontend(server, port) {
  return new Promise((resolve, reject) => {
    const failed = error => { server.removeListener('listening', ready); reject(error); };
    const ready = () => { server.removeListener('error', failed); resolve(); };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen(port, '0.0.0.0')
  });
}
