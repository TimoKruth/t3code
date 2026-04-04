import { type ProjectId, type ServerLifecycleWelcomePayload } from "@t3tools/contracts";

import type { Project } from "../types";

export function resolveEmbeddedBootstrapProjectId(input: {
  readonly projects: readonly Project[];
  readonly latestWelcome: ServerLifecycleWelcomePayload | null;
  readonly embeddedProjectCwd: string | null;
}): ProjectId | undefined {
  const { projects, latestWelcome, embeddedProjectCwd } = input;

  if (embeddedProjectCwd) {
    const projectFromCwd = projects.find((project) => project.cwd === embeddedProjectCwd);
    if (projectFromCwd) {
      return projectFromCwd.id;
    }
  }

  const bootstrapProjectId = latestWelcome?.bootstrapProjectId;
  if (bootstrapProjectId && projects.some((project) => project.id === bootstrapProjectId)) {
    return bootstrapProjectId;
  }

  return projects[0]?.id;
}
