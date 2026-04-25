import { DateTime } from "luxon"
import type { GlobalSession } from "@opencode-ai/sdk/v2/client"

export type SortMode = "recent" | "name" | "sessions"
export type ProjectCard = {
  id: string
  worktree: string
  name: string | null
  time: { created: number; updated: number }
}

export function cleanSessionTitle(title: string) {
  const match = title.match(/^New session - (\d{4}-\d{2}-\d{2}T[\d:.]+Z)$/)
  if (!match) return title || "Untitled session"
  const time = DateTime.fromISO(match[1])
  return time.isValid ? `Session from ${time.toFormat("LLL d, h:mm a")}` : "Untitled session"
}

export function displayProjectName(project: Pick<ProjectCard, "name" | "worktree">) {
  if (project.name) return project.name
  return project.worktree.split("/").filter(Boolean).at(-1) ?? project.worktree
}

export function groupSessionsByProject(sessions: readonly GlobalSession[]) {
  return Object.fromEntries(
    Object.entries(
      sessions.reduce<Record<string, GlobalSession[]>>((acc, session) => {
        if (!session.projectID) return acc
        acc[session.projectID] = [...(acc[session.projectID] ?? []), session]
        return acc
      }, {}),
    ).map(([projectID, projectSessions]) => [
      projectID,
      projectSessions.slice().sort((a, b) => (b.time.updated ?? 0) - (a.time.updated ?? 0)),
    ]),
  )
}
