// Shell quoting, in a module of its own so that what needs it (the command
// typed into a herdr pane, the herdr config's bindings) imports nothing else.

// A POSIX single-quoted word: the value as it is, a single quote closed,
// escaped and reopened.
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}
