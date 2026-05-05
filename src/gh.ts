export interface GhResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export const runGh = async (
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {}
): Promise<GhResult> => {
  const proc = Bun.spawn(["gh", ...args], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeoutMs = opts.timeoutMs ?? 5000;
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
  }, timeoutMs);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode };
};
