// The agent seam. forge v2.0 runs one agent, Claude Code; everything that knows
// how to start it lives here so another agent (Codex, a self-hosted model)
// can be added without touching attach, start or resume.
export type Agent = {
  // Value of HERDR_AGENT in the attach process: tells herdr which agent a pane runs.
  herdrLabel: string;
  // argv run inside the container, as the direct child of `incus exec`.
  command(container: string, task: string, resume: boolean): string[];
  // Text that appears in the agent's process command line. Used to tell
  // whether a task's agent is already running.
  marker(container: string, task: string): string;
};

export const AGENT: Agent = {
  herdrLabel: "claude",
  // `exec` inside `bash -lc` so claude replaces the shell (no extra process
  // between incus and the agent); -l restores DOCKER_HOST, exported from .bashrc.
  command: (container, task, resume) => [
    "bash", "-lc",
    `exec claude --permission-mode auto ${AGENT.marker(container, task)}${resume ? " --continue" : ""}`,
  ],
  marker: (container, task) => `--remote-control ${container}-${task}`,
};
