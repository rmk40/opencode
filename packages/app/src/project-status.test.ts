import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createProjectStatusTracker } from "./context/project-status"

function withTracker(run: (tracker: ReturnType<typeof createProjectStatusTracker>) => void) {
  createRoot((dispose) => {
    try {
      run(createProjectStatusTracker())
    } finally {
      dispose()
    }
  })
}

describe("project status tracker", () => {
  test("maps status events through the cached session project", () => {
    withTracker((tracker) => {
      tracker.apply({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } })
      expect(tracker.sessionStatusFor("ses_1")).toBe("idle")

      tracker.reconcileSessions([{ id: "ses_1", projectID: "proj_1" }])
      tracker.apply({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } })

      expect(tracker.sessionStatusFor("ses_1")).toBe("busy")
      expect(tracker.statusFor("proj_1")).toBe("busy")
      expect(tracker.activeSessionFor("proj_1")).toBe("ses_1")
    })
  })

  test("created updated and deleted events refresh dashboard data", () => {
    withTracker((tracker) => {
      expect(tracker.version()).toBe(0)

      tracker.apply({
        type: "session.created",
        properties: { sessionID: "ses_1", info: { id: "ses_1", projectID: "proj_1" } },
      })
      expect(tracker.version()).toBe(1)

      tracker.apply({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "retry" } } })
      expect(tracker.statusFor("proj_1")).toBe("busy")

      tracker.apply({ type: "session.updated", properties: { sessionID: "ses_1", info: { id: "ses_1" } } })
      expect(tracker.version()).toBe(2)

      tracker.apply({ type: "session.deleted", properties: { sessionID: "ses_1", info: { id: "ses_1" } } })
      expect(tracker.version()).toBe(3)
      expect(tracker.statusFor("proj_1")).toBe("idle")
      expect(tracker.sessionStatusFor("ses_1")).toBe("idle")
    })
  })

  test("clears the previous project when a session moves projects", () => {
    withTracker((tracker) => {
      tracker.reconcileSessions([{ id: "ses_1", projectID: "proj_1" }])
      tracker.apply({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } })
      tracker.apply({
        type: "session.updated",
        properties: { sessionID: "ses_1", info: { id: "ses_1", projectID: "proj_2" } },
      })

      expect(tracker.statusFor("proj_1")).toBe("idle")
    })
  })

  test("keeps project busy when one session errors while another is busy", () => {
    withTracker((tracker) => {
      tracker.reconcileSessions([
        { id: "ses_1", projectID: "proj_1" },
        { id: "ses_2", projectID: "proj_1" },
      ])
      tracker.apply({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "error" } } })
      tracker.apply({ type: "session.status", properties: { sessionID: "ses_2", status: { type: "busy" } } })

      expect(tracker.statusFor("proj_1")).toBe("busy")
    })
  })

  test("reconcileSessions drops sessions absent from the latest list", () => {
    withTracker((tracker) => {
      tracker.reconcileSessions([{ id: "ses_1", projectID: "proj_1" }])
      tracker.apply({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } })

      tracker.reconcileSessions([])

      expect(tracker.statusFor("proj_1")).toBe("idle")
      expect(tracker.sessionStatusFor("ses_1")).toBe("idle")
    })
  })

  test("clears a deleted busy session without clearing other project sessions", () => {
    withTracker((tracker) => {
      tracker.reconcileSessions([
        { id: "ses_1", projectID: "proj_1" },
        { id: "ses_2", projectID: "proj_1" },
      ])
      tracker.apply({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } })
      tracker.apply({ type: "session.deleted", properties: { sessionID: "ses_1", info: { id: "ses_1" } } })

      expect(tracker.statusFor("proj_1")).toBe("idle")
      expect(tracker.sessionStatusFor("ses_2")).toBe("idle")
    })
  })
})
