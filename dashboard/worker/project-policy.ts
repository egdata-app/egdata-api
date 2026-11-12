export class ProjectCreationError extends Error {
  constructor(
    public readonly code: "PROJECT_LIMIT_REACHED" | "PROJECT_CREATION_COOLDOWN",
  ) {
    super(
      code === "PROJECT_LIMIT_REACHED"
        ? "Your account has reached its project allowance. One project is included by default; contact the egdata team to request additional projects."
        : "You can create one project every 24 hours, including after deleting a project. Please try again later.",
    );
    this.name = "ProjectCreationError";
  }
}

/** Translate only known database policy failures; other failures must surface. */
export function projectCreationError(
  error: unknown,
): ProjectCreationError | null {
  if (!(error instanceof Error)) return null;
  for (const code of [
    "PROJECT_LIMIT_REACHED",
    "PROJECT_CREATION_COOLDOWN",
  ] as const) {
    if (error.message.includes(code)) return new ProjectCreationError(code);
  }
  return error.cause ? projectCreationError(error.cause) : null;
}
