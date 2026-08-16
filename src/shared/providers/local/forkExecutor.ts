import { fork } from 'child_process';
import path from 'path';
import fs from 'fs';
import { IJobExecutor } from '../types';
import { logger } from '../../logger';

const HANDLER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Resolves the path to the handler file.
 * Handles both compiled JS in dist/ and TS during dev.
 */
function resolveHandlerPath(fileName: string): string {
  // Try compiled JS in dist/handlers/
  const distPath = path.resolve(process.cwd(), 'dist/handlers', fileName);
  if (fs.existsSync(distPath)) {
    return distPath;
  }

  // Try relative from current dir
  const relativeDist = path.resolve(__dirname, '../../../handlers', fileName);
  if (fs.existsSync(relativeDist)) {
    return relativeDist;
  }

  // Try replacing .js with .ts in src/handlers/ (e.g. during ts-node)
  const tsFileName = fileName.replace(/\.js$/, '.ts');
  const srcPath = path.resolve(process.cwd(), 'src/handlers', tsFileName);
  if (fs.existsSync(srcPath)) {
    return srcPath;
  }

  return distPath;
}

/**
 * Local job executor that uses child_process.fork() for process isolation.
 * Wraps the existing fork logic from syncConsumer.
 */
export class ForkExecutor implements IJobExecutor {
  async execute(
    handlerName: string,
    env: Record<string, string>
  ): Promise<{ exitCode: number; error?: string }> {
    const handlerPath = resolveHandlerPath(handlerName);
    logger.info({ handlerName, handlerPath }, 'Forking child process for handler');

    return new Promise((resolve) => {
      let isFinished = false;

      // Check if we need ts-node register for .ts files (in dev)
      const execArgv = handlerPath.endsWith('.ts') ? ['-r', 'ts-node/register'] : [];

      const child = fork(handlerPath, [], {
        execArgv,
        env: {
          ...process.env,
          ...env,
        },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });

      let stderrOutput = '';
      child.stderr?.on('data', (data) => {
        stderrOutput += data.toString();
        logger.error({ handlerName, stderr: data.toString() }, 'Child process stderr');
      });

      child.stdout?.on('data', (data) => {
        logger.info({ handlerName, stdout: data.toString().trim() }, 'Child process stdout');
      });

      // Timeout guard
      const timer = setTimeout(() => {
        if (isFinished) return;
        isFinished = true;
        logger.error(
          { handlerName, timeoutMs: HANDLER_TIMEOUT_MS },
          'Handler execution timed out. Killing child process.'
        );

        try {
          child.kill('SIGKILL');
        } catch (killErr) {
          logger.error({ error: killErr }, 'Error killing child process');
        }

        resolve({
          exitCode: 1,
          error: `Handler execution timed out after ${HANDLER_TIMEOUT_MS / 1000}s`,
        });
      }, HANDLER_TIMEOUT_MS);

      child.on('exit', (code, signal) => {
        if (isFinished) return;
        isFinished = true;
        clearTimeout(timer);

        if (code === 0) {
          logger.info({ handlerName }, 'Handler completed successfully');
          resolve({ exitCode: 0 });
        } else {
          const errorMsg = `Child process exited with code ${code}, signal: ${signal}. ${stderrOutput}`.trim();
          logger.error({ handlerName, code, signal, errorMsg }, 'Handler failed');
          resolve({ exitCode: code ?? 1, error: errorMsg });
        }
      });

      child.on('error', (err) => {
        if (isFinished) return;
        isFinished = true;
        clearTimeout(timer);

        logger.error({ handlerName, error: err }, 'Child process spawn error');
        resolve({
          exitCode: 1,
          error: err.message || 'Child process spawn error',
        });
      });
    });
  }

  async close(): Promise<void> {
    // No persistent resources to clean up for fork executor
  }
}
