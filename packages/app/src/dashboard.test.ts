import { describe, expect, test } from "bun:test"
import { DateTime } from "luxon"
import type { GlobalSession } from "@opencode-ai/sdk/v2/client"
import { cleanSessionTitle, displayProjectName, groupSessionsByProject } from "./pages/dashboard-helpers"

const session = (input: {
  id: string
  projectID: string
  updated: number
  title?: string
  project?: GlobalSession["project"]
}): GlobalSession => ({
  id: input.id,
  slug: input.id,
  projectID: input.projectID,
  directory: "/repo",
  title: input.title ?? input.id,
  version: "1.0.0",
  time: { created: 1, updated: input.updated },
  project: input.project ?? null,
})

describe("dashboard helpers", () => {
  test("groups sessions by projectID and preserves display-orphaned sessions", () => {
    const grouped = groupSessionsByProject([
      session({ id: "older", projectID: "project-a", updated: 1, project: null }),
      session({ id: "newer", projectID: "project-a", updated: 3, project: null }),
      session({ id: "other", projectID: "project-b", updated: 2, project: { id: "project-b", worktree: "/b" } }),
    ])

    expect(grouped["project-a"]?.map((item) => item.id)).toEqual(["newer", "older"])
    expect(grouped["project-b"]?.map((item) => item.id)).toEqual(["other"])
  })

  test("derives friendly names and generated session titles", () => {
    expect(displayProjectName({ name: "Custom", worktree: "/tmp/project" })).toBe("Custom")
    expect(displayProjectName({ name: null, worktree: "/tmp/project" })).toBe("project")
    const expected = `Session from ${DateTime.fromISO("2026-03-20T22:41:49.230Z").toFormat("LLL d, h:mm a")}`
    expect(cleanSessionTitle("New session - 2026-03-20T22:41:49.230Z")).toBe(expected)
    expect(cleanSessionTitle("")).toBe("Untitled session")
  })
})
