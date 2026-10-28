import { execFileSync } from 'child_process';

/** Build dist/ once before the suites that spawn the CLI run in parallel. */
export default function setup(): void {
  execFileSync('npm', ['run', 'build'], { stdio: 'ignore', timeout: 60000 });
}
