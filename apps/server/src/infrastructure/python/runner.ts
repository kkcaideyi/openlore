import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  PythonWorkerRequest,
  PythonWorkerResponse,
} from '@openlore/contracts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The worker gets only what Python and outbound proxies need, never control-plane secrets.
const INHERITED_ENV = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE',
  'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'TWS_PROXY',
]);

export function workerEnv(source: NodeJS.ProcessEnv, pythonPath: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source))
    if (value !== undefined && INHERITED_ENV.has(key.toUpperCase())) env[key] = value;
  return {
    ...env,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONPATH: pythonPath,
    TWS_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
  };
}

/** Diagnostics may contain upstream responses; keep a short tail and mask credential-looking values. */
export function redactDiagnostics(text: string): string {
  return text
    .slice(-500)
    .replace(/((?:auth_token|ct0|cookie|authorization|password|token)["']?\s*[:=]\s*["']?)[^\s"';,]+/gi, '$1***')
    .replace(/\b[a-f0-9]{40,}\b/gi, '***');
}

export function resolvePythonPath(projectDir: string, platform = process.platform): string {
  const venvPython = platform === 'win32'
    ? path.join(projectDir, '.venv', 'Scripts', 'python.exe')
    : path.join(projectDir, '.venv', 'bin', 'python');
  if (fs.existsSync(venvPython)) return venvPython;
  // On Windows `python3` is usually the Microsoft Store stub.
  return platform === 'win32' ? 'python' : 'python3';
}

export class PythonWorkerRunner {
  private pythonPath: string;
  private pythonProjectDir: string;

  constructor(customPythonPath?: string) {
    // Resolve project directory: repo_root/workers/python
    // from apps/server/src/infrastructure/python -> up 4 levels to root
    const repoRoot = path.resolve(__dirname, '../../../../../');
    this.pythonProjectDir = path.join(repoRoot, 'workers/python');
    this.pythonPath = customPythonPath && fs.existsSync(customPythonPath)
      ? customPythonPath
      : resolvePythonPath(this.pythonProjectDir);
  }

  getPythonPath(): string {
    return this.pythonPath;
  }

  async run(
    request: PythonWorkerRequest,
    timeoutMs: number = 30000,
  ): Promise<PythonWorkerResponse> {
    return new Promise((resolve, reject) => {
      const args = ['-m', 'openlore_collectors'];
      const child = spawn(this.pythonPath, args, {
        cwd: this.pythonProjectDir,
        shell: false,
        env: workerEnv(process.env, path.join(this.pythonProjectDir, 'src')),
      });

      let stdoutData = '';
      let stderrData = '';
      const maxStdoutBytes = 16 * 1024 * 1024; // 16 MiB limit

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(
          new Error(
            `Python worker timed out after ${timeoutMs}ms for job ${request.job_id}`,
          ),
        );
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdoutData += chunk.toString('utf-8');
        if (Buffer.byteLength(stdoutData) > maxStdoutBytes) {
          clearTimeout(timer);
          child.kill('SIGTERM');
          reject(
            new Error(
              `Python worker stdout exceeded ${maxStdoutBytes} bytes limit`,
            ),
          );
        }
      });

      child.stderr.on('data', (chunk) => {
        stderrData = (stderrData + chunk.toString('utf-8')).slice(-8192);
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          return reject(
            new Error(
              `Python worker exited with code ${code}. Stderr: ${redactDiagnostics(stderrData)}`,
            ),
          );
        }

        try {
          const parsed = JSON.parse(stdoutData.trim());
          if (parsed.protocol_version !== 1) {
            return reject(
              new Error(
                `Invalid protocol version in worker response: ${parsed.protocol_version}`,
              ),
            );
          }
          resolve(parsed as PythonWorkerResponse);
        } catch (e: any) {
          reject(
            new Error(
              `Failed to parse worker stdout as JSON: ${e.message}. Raw output: ${redactDiagnostics(stdoutData.slice(0, 500))}`,
            ),
          );
        }
      });

      child.stdin.write(JSON.stringify(request));
      child.stdin.end();
    });
  }
}

export const pythonWorkerRunner = new PythonWorkerRunner();
