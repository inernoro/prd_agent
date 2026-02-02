import { spawn } from 'child_process';
import { EventEmitter } from 'events';

/**
 * Execute a command and stream output
 */
export class CommandExecutor extends EventEmitter {
  constructor(job) {
    super();
    this.job = job;
    this.process = null;
    this.killed = false;
    this.startTime = null;
    this.logs = [];
  }

  /**
   * Execute the command
   * @returns {Promise<{ success: boolean, exitCode: number, duration: number, logs: Array }>}
   */
  async execute() {
    return new Promise((resolve) => {
      this.startTime = Date.now();

      const { command, args = [], env = {}, workDir, timeout } = this.job;

      // Merge environment
      const processEnv = {
        ...process.env,
        ...env,
        // Inject standard variables
        JOB_ID: this.job.jobId,
      };

      // Spawn process
      this.process = spawn(command, args, {
        cwd: workDir || process.cwd(),
        env: processEnv,
        shell: true,
      });

      // Handle stdout
      this.process.stdout.on('data', (data) => {
        const text = data.toString();
        const logEntry = {
          ts: new Date().toISOString(),
          stream: 'stdout',
          text,
        };
        this.logs.push(logEntry);
        this.emit('output', logEntry);
      });

      // Handle stderr
      this.process.stderr.on('data', (data) => {
        const text = data.toString();
        const logEntry = {
          ts: new Date().toISOString(),
          stream: 'stderr',
          text,
        };
        this.logs.push(logEntry);
        this.emit('output', logEntry);
      });

      // Handle error (spawn failed)
      this.process.on('error', (err) => {
        const duration = Date.now() - this.startTime;
        resolve({
          success: false,
          exitCode: -1,
          duration,
          logs: this.logs,
          error: err.message,
        });
      });

      // Handle close
      this.process.on('close', (code) => {
        const duration = Date.now() - this.startTime;
        resolve({
          success: code === 0,
          exitCode: code ?? -1,
          duration,
          logs: this.logs,
          killed: this.killed,
        });
      });

      // Timeout handling
      const timeoutMs = timeout || 300000;
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.kill('SIGTERM');
          this.killed = true;
          // Give process time to cleanup
          setTimeout(() => {
            if (this.process && !this.process.killed) {
              this.kill('SIGKILL');
            }
          }, 5000);
        }
      }, timeoutMs);
    });
  }

  /**
   * Kill the process
   * @param {string} signal - Signal to send
   */
  kill(signal = 'SIGTERM') {
    if (this.process && !this.process.killed) {
      this.killed = true;
      this.process.kill(signal);
    }
  }

  /**
   * Get execution duration so far
   * @returns {number} Duration in ms
   */
  getDuration() {
    if (!this.startTime) return 0;
    return Date.now() - this.startTime;
  }
}

/**
 * Execute a command (simple function interface)
 * @param {Object} job - Job definition
 * @param {Function} onOutput - Output callback
 * @returns {Promise<Object>} Execution result
 */
export async function executeCommand(job, onOutput) {
  const executor = new CommandExecutor(job);

  if (onOutput) {
    executor.on('output', onOutput);
  }

  return executor.execute();
}

export default CommandExecutor;
