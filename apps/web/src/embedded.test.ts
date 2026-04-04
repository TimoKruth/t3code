/**
 * Safety-net tests for the embedded cmux integration module.
 * These tests guard the current behavior before any extraction/refactoring.
 *
 * Tests cover:
 * - EMBEDDED_MODE detection from query params and hash
 * - EMBEDDED_PROJECT_CWD extraction
 * - postThreadIdToHost webkit bridge call
 * - Graceful degradation when window/webkit is missing
 *
 * Since the module captures URL params at load time, we use vi.resetModules()
 * and dynamic import() to get fresh copies with different window states.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Helper: set up a minimal window global for the embedded module
function setupWindow(search: string = "", hash: string = "") {
  const loc = {
    search,
    hash,
    href: `http://localhost${search}${hash}`,
  };
  vi.stubGlobal("window", {
    location: loc,
    webkit: undefined,
  });
}

function cleanupWindow() {
  vi.unstubAllGlobals();
}

describe("embedded module", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    cleanupWindow();
  });

  describe("EMBEDDED_MODE detection", () => {
    it("should be false when no embedded param is present", async () => {
      setupWindow("", "");
      const mod = await import("./embedded");
      expect(mod.EMBEDDED_MODE).toBe(false);
    });

    it("should be true when embedded=1 is in query params", async () => {
      setupWindow("?embedded=1", "");
      const mod = await import("./embedded");
      expect(mod.EMBEDDED_MODE).toBe(true);
    });

    it("should be true when embedded=1 is in hash", async () => {
      setupWindow("", "#embedded=1");
      const mod = await import("./embedded");
      expect(mod.EMBEDDED_MODE).toBe(true);
    });

    it("should be false when embedded=0 is in query params", async () => {
      setupWindow("?embedded=0", "");
      const mod = await import("./embedded");
      expect(mod.EMBEDDED_MODE).toBe(false);
    });

    it("should be false when embedded param has other value", async () => {
      setupWindow("?embedded=true", "");
      const mod = await import("./embedded");
      expect(mod.EMBEDDED_MODE).toBe(false);
    });
  });

  describe("EMBEDDED_PROJECT_CWD extraction", () => {
    it("should be null when not in embedded mode", async () => {
      setupWindow("?projectCwd=/some/path", "");
      const mod = await import("./embedded");
      // Not embedded, so projectCwd should be null even if present
      expect(mod.EMBEDDED_PROJECT_CWD).toBeNull();
    });

    it("should capture projectCwd when in embedded mode", async () => {
      setupWindow("?embedded=1&projectCwd=/Users/test/my-project", "");
      const mod = await import("./embedded");
      expect(mod.EMBEDDED_PROJECT_CWD).toBe("/Users/test/my-project");
    });

    it("should be null when embedded but no projectCwd param", async () => {
      setupWindow("?embedded=1", "");
      const mod = await import("./embedded");
      expect(mod.EMBEDDED_PROJECT_CWD).toBeNull();
    });

    it("should be null when embedded and projectCwd is empty", async () => {
      setupWindow("?embedded=1&projectCwd=", "");
      const mod = await import("./embedded");
      expect(mod.EMBEDDED_PROJECT_CWD).toBeNull();
    });

    it("should trim whitespace from projectCwd", async () => {
      setupWindow("?embedded=1&projectCwd=%20/path/trimmed%20", "");
      const mod = await import("./embedded");
      expect(mod.EMBEDDED_PROJECT_CWD).toBe("/path/trimmed");
    });

    it("should handle URL-encoded paths", async () => {
      setupWindow(
        "?embedded=1&projectCwd=" + encodeURIComponent("/Users/test/My Project"),
        "",
      );
      const mod = await import("./embedded");
      expect(mod.EMBEDDED_PROJECT_CWD).toBe("/Users/test/My Project");
    });
  });

  describe("postThreadIdToHost", () => {
    it("should be a function", async () => {
      setupWindow("", "");
      const mod = await import("./embedded");
      expect(typeof mod.postThreadIdToHost).toBe("function");
    });

    it("should not throw when webkit bridge is not available", async () => {
      setupWindow("", "");
      const mod = await import("./embedded");
      expect(() => mod.postThreadIdToHost("test-thread-id")).not.toThrow();
    });

    it("should call webkit bridge when available", async () => {
      const mockPostMessage = vi.fn();
      vi.stubGlobal("window", {
        location: { search: "", hash: "" },
        webkit: {
          messageHandlers: {
            cmuxThreadSync: {
              postMessage: mockPostMessage,
            },
          },
        },
      });

      const mod = await import("./embedded");
      mod.postThreadIdToHost("thread-abc-123");

      expect(mockPostMessage).toHaveBeenCalledTimes(1);
      expect(mockPostMessage).toHaveBeenCalledWith({ threadId: "thread-abc-123" });
    });

    it("should gracefully handle webkit bridge errors", async () => {
      vi.stubGlobal("window", {
        location: { search: "", hash: "" },
        webkit: {
          messageHandlers: {
            cmuxThreadSync: {
              postMessage: () => {
                throw new Error("bridge disconnected");
              },
            },
          },
        },
      });

      const mod = await import("./embedded");
      // Should not throw even when the bridge errors
      expect(() => mod.postThreadIdToHost("thread-xyz")).not.toThrow();
    });

    it("should handle partial webkit chain (no messageHandlers)", async () => {
      vi.stubGlobal("window", {
        location: { search: "", hash: "" },
        webkit: {},
      });

      const mod = await import("./embedded");
      expect(() => mod.postThreadIdToHost("thread-123")).not.toThrow();
    });

    it("should handle partial webkit chain (no cmuxThreadSync)", async () => {
      vi.stubGlobal("window", {
        location: { search: "", hash: "" },
        webkit: { messageHandlers: {} },
      });

      const mod = await import("./embedded");
      expect(() => mod.postThreadIdToHost("thread-123")).not.toThrow();
    });
  });

  describe("module exports shape", () => {
    it("should export exactly EMBEDDED_MODE, EMBEDDED_PROJECT_CWD, and postThreadIdToHost", async () => {
      setupWindow("", "");
      const mod = await import("./embedded");
      const exportKeys = Object.keys(mod).sort();
      expect(exportKeys).toEqual(
        ["EMBEDDED_MODE", "EMBEDDED_PROJECT_CWD", "postThreadIdToHost"].sort(),
      );
    });
  });
});
