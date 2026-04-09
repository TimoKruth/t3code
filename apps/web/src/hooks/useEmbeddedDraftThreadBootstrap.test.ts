import { EnvironmentId, ProjectId, type ServerLifecycleWelcomePayload, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { resolveEmbeddedBootstrapProjectId } from "./embeddedDraftThreadBootstrap";
import type { Project } from "../types";

const TEST_ENVIRONMENT_ID = EnvironmentId.makeUnsafe("environment-local");

const projects: readonly Project[] = [
  {
    id: ProjectId.makeUnsafe("project-1"),
    environmentId: TEST_ENVIRONMENT_ID,
    name: "Project One",
    cwd: "/workspace/project-one",
    defaultModelSelection: null,
    scripts: [],
  },
  {
    id: ProjectId.makeUnsafe("project-2"),
    environmentId: TEST_ENVIRONMENT_ID,
    name: "Project Two",
    cwd: "/workspace/project-two",
    defaultModelSelection: null,
    scripts: [],
  },
];

function makeWelcome(bootstrapProjectId?: Project["id"]): ServerLifecycleWelcomePayload {
  return {
    environment: {
      environmentId: TEST_ENVIRONMENT_ID,
      label: "Local",
      capabilities: { repositoryIdentity: false },
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.1",
    },
    cwd: "/workspace",
    projectName: "t3code",
    bootstrapProjectId,
    bootstrapThreadId: ThreadId.makeUnsafe("thread-1"),
  };
}

describe("resolveEmbeddedBootstrapProjectId", () => {
  it("prefers the embedded project cwd match", () => {
    expect(
      resolveEmbeddedBootstrapProjectId({
        projects,
        latestWelcome: makeWelcome(projects[1]!.id),
        embeddedProjectCwd: projects[0]!.cwd,
      }),
    ).toBe(projects[0]!.id);
  });

  it("falls back to the welcome bootstrap project id", () => {
    expect(
      resolveEmbeddedBootstrapProjectId({
        projects,
        latestWelcome: makeWelcome(projects[1]!.id),
        embeddedProjectCwd: "/workspace/missing",
      }),
    ).toBe(projects[1]!.id);
  });

  it("falls back to the first project when the welcome project is unavailable", () => {
    expect(
      resolveEmbeddedBootstrapProjectId({
        projects,
        latestWelcome: makeWelcome(ProjectId.makeUnsafe("project-missing")),
        embeddedProjectCwd: "/workspace/missing",
      }),
    ).toBe(projects[0]!.id);
  });

  it("returns undefined when no projects are available", () => {
    expect(
      resolveEmbeddedBootstrapProjectId({
        projects: [],
        latestWelcome: null,
        embeddedProjectCwd: null,
      }),
    ).toBeUndefined();
  });
});
