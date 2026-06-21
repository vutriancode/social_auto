const API_PORT = "8099";

// Resolves the backend API origin without requiring per-server build config.
// Falls back to NEXT_PUBLIC_API_URL if explicitly set, otherwise derives the
// API origin from the browser's current host (same host, fixed API port).
export function getApiBase(): string {
  if (process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL;
  }
  if (typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:${API_PORT}`;
  }
  return `http://127.0.0.1:${API_PORT}`;
}
