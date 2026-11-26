/**
 * Sets `process.env[name]` for a test and returns a function that restores the
 * previous state: the previous value, or no variable at all when it was unset
 * (assigning `undefined` would leave the string `"undefined"` behind).
 */
export function overrideEnv(name: string, value: string): () => void {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  };
}
