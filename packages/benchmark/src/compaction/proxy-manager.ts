import { spawn, exec, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { join, dirname } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';

export interface HeadroomProxy {
  process: ChildProcess;
  url: string;
  kill: () => void;
}

function checkPythonHasHeadroom(py: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = exec(`"${py}" -c "import headroom; print('ok')"`, { timeout: 5000 }, (err, stdout) => {
      resolve(!err && stdout.trim() === 'ok');
    });
    child.on('error', () => resolve(false));
  });
}

function findHeadroomCliNextTo(py: string): string | null {
  const scriptsDir = join(dirname(py), 'Scripts');
  const cli = join(scriptsDir, 'headroom.exe');
  if (existsSync(cli)) return cli;
  const unixCli = join(dirname(py), 'bin', 'headroom');
  if (existsSync(unixCli)) return unixCli;
  return null;
}

function scanForCondaEnvs(): Promise<string[]> {
  return new Promise((resolve) => {
    exec('conda env list --json', { timeout: 10000 }, (err, stdout) => {
      if (err || !stdout) {
        const candidates: string[] = [];
        const home = process.env.USERPROFILE || process.env.HOME || '';
        if (home) {
          const base = join(home, '.conda', 'envs');
          try {
            for (const dir of readdirSync(base)) {
              const py = join(base, dir, 'python.exe');
              if (existsSync(py)) candidates.push(py);
            }
          } catch { /* no conda dir */ }
        }
        resolve(candidates);
        return;
      }
      try {
        const data = stdout.replace(/^\uFEFF/, '');
        const parsed = JSON.parse(data);
        const envs: string[] = parsed.envs ?? [];
        resolve(envs.map((e: string) =>
          e.includes('\\') ? `${e}\\python.exe` : `${e}/bin/python3`,
        ));
      } catch {
        resolve([]);
      }
    });
  });
}

async function detectHeadroomPython(): Promise<{ command: string; args: string[] }> {
  const explicit = process.env.HEADROOM_PYTHON;
  if (explicit) {
    // If HEADROOM_PYTHON is a headroom CLI entry point, use it directly
    if (explicit.endsWith('headroom') || explicit.endsWith('headroom.exe')) {
      return { command: explicit, args: [] };
    }
    return { command: explicit, args: ['-m', 'headroom'] };
  }

  const condaPythons = await scanForCondaEnvs();
  for (const py of condaPythons) {
    if (await checkPythonHasHeadroom(py)) {
      // Prefer headroom CLI script next to Python (no __main__.py issue)
      const cli = findHeadroomCliNextTo(py);
      if (cli) return { command: cli, args: [] };
      return { command: py, args: ['-m', 'headroom'] };
    }
  }

  for (const name of ['python3', 'python']) {
    if (await checkPythonHasHeadroom(name)) {
      return { command: name, args: ['-m', 'headroom'] };
    }
  }

  return { command: 'headroom', args: [] };
}

export async function startHeadroomProxy(
  port: number = 8787,
  timeoutMs: number = 120000,
): Promise<HeadroomProxy> {
  const url = `http://localhost:${port}`;
  const proxyArgs = buildProxyArgs(port);
  const { command, args: commandPrefix } = await detectHeadroomPython();
  const spawnArgs = [...commandPrefix, ...proxyArgs];

  const proxyProcess = spawn(command, spawnArgs, {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: false,
  });

  proxyProcess.stderr?.on('data', (data: Buffer) => {
    const msg = `[headroom-proxy] ${data.toString()}`;
    process.stderr.write(msg);
  });

  proxyProcess.on('error', (err: Error) => {
    throw new Error(
      `Failed to start Headroom proxy.\n` +
      `  Install: pip install "headroom-ai[proxy]"\n` +
      `  Or: set HEADROOM_PYTHON to a Python interpreter with headroom installed\n` +
      `  Error: ${err.message}`,
    );
  });

  proxyProcess.on('exit', (code, signal) => {
    process.stderr.write(
      `[headroom-proxy] exited (code: ${code}, signal: ${signal})\n`,
    );
  });

  await waitForProxyHealth(url, timeoutMs);

  return {
    process: proxyProcess,
    url,
    kill: () => {
      proxyProcess.kill();
    },
  };
}

function buildProxyArgs(port: number): string[] {
  const args: string[] = ['proxy', '--port', String(port)];

  const extraArgs = process.env.HEADROOM_PROXY_ARGS;
  if (extraArgs) {
    for (const part of extraArgs.split(/\s+/)) {
      if (part) args.push(part);
    }
  }

  return args;
}

function waitForProxyHealth(url: string, timeoutMs: number): Promise<void> {
  const healthUrl = `${url}/health`;
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const poll = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(
          `Headroom proxy did not become healthy within ${timeoutMs}ms at ${healthUrl}`,
        ));
        return;
      }

      const req = request(healthUrl, { method: 'GET', timeout: 2000 }, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          setTimeout(poll, 500);
        }
      });

      req.on('error', () => {
        setTimeout(poll, 500);
      });

      req.end();
    };

    poll();
  });
}
