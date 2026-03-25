/**
 * Shared embedded mode detection for cmux integration.
 * Captured once at module load time since router redirects may strip query params.
 */

const searchParams = (() => {
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return new URLSearchParams();
  }
})();

export const EMBEDDED_MODE =
  searchParams.get("embedded") === "1" ||
  (typeof window !== "undefined" && window.location.hash.includes("embedded=1"));

/**
 * The project working directory passed by cmux so t3code can bind
 * the thread to the correct workspace project.
 */
export const EMBEDDED_PROJECT_CWD: string | null = (() => {
  if (!EMBEDDED_MODE) return null;
  const cwd = searchParams.get("projectCwd");
  return cwd && cwd.trim().length > 0 ? cwd.trim() : null;
})();

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        cmuxThreadSync?: {
          postMessage: (message: { threadId: string }) => void;
        };
      };
    };
  }
}

/** Notify the cmux host of the active thread ID via webkit bridge. */
export function postThreadIdToHost(threadId: string): void {
  try {
    window.webkit?.messageHandlers?.cmuxThreadSync?.postMessage({ threadId });
  } catch {
    // Ignore failures outside the embedded cmux environment.
  }
}
