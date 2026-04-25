import { createContext, onCleanup, type ParentProps, useContext } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useGlobalSDK } from "./global-sdk"

type SimplifiedStatus = "idle" | "busy" | "error"
type SessionProject = { id: string; projectID: string }

type StatusStore = {
  sessions: Record<string, SimplifiedStatus>
  busySessions: Record<string, Set<string>>
  errorSessions: Record<string, Set<string>>
  version: number
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  return value as Record<string, unknown>
}

function asString(value: unknown) {
  return typeof value === "string" && value ? value : undefined
}

function simplify(raw: string): SimplifiedStatus {
  if (raw === "busy" || raw === "retry" || raw === "waiting_for_permission") return "busy"
  if (raw === "error" || raw === "aborted") return "error"
  return "idle"
}

function readInfo(properties: unknown) {
  return asRecord(asRecord(properties)?.info)
}

export function createProjectStatusTracker() {
  const sessionToProject = new Map<string, string>()

  const [store, setStore] = createStore<StatusStore>({
    sessions: {},
    busySessions: {},
    errorSessions: {},
    version: 0,
  })

  const bump = () => setStore("version", (value) => value + 1)

  function setSessionForProject(projectID: string, sessionID: string, status: SimplifiedStatus) {
    setStore("sessions", sessionID, status)
    setStore("busySessions", projectID, (prev = new Set()) => {
      const next = new Set(prev)
      if (status === "busy") next.add(sessionID)
      else next.delete(sessionID)
      return next
    })
    setStore("errorSessions", projectID, (prev = new Set()) => {
      const next = new Set(prev)
      if (status === "error") next.add(sessionID)
      else next.delete(sessionID)
      return next
    })
  }

  function rememberSessionProject(sessionID: string, projectID: string) {
    const previous = sessionToProject.get(sessionID)
    if (previous && previous !== projectID) setSessionForProject(previous, sessionID, "idle")
    sessionToProject.set(sessionID, projectID)
  }

  function forgetSession(sessionID: string) {
    const projectID = sessionToProject.get(sessionID)
    if (projectID) setSessionForProject(projectID, sessionID, "idle")
    sessionToProject.delete(sessionID)
    setStore(
      "sessions",
      produce((draft) => {
        delete draft[sessionID]
      }),
    )
  }

  function apply(details: unknown) {
    const event = asRecord(details)
    const type = asString(event?.type)
    const properties = event?.properties
    const info = readInfo(properties)

    if (type === "session.created") {
      const sessionID = asString(info?.id) ?? asString(asRecord(properties)?.sessionID)
      const projectID = asString(info?.projectID)
      if (sessionID && projectID) rememberSessionProject(sessionID, projectID)
      bump()
      return
    }

    if (type === "session.updated") {
      const sessionID = asString(info?.id) ?? asString(asRecord(properties)?.sessionID)
      const projectID = asString(info?.projectID) ?? (sessionID ? sessionToProject.get(sessionID) : undefined)
      if (sessionID && projectID) rememberSessionProject(sessionID, projectID)
      bump()
      return
    }

    if (type === "session.status") {
      const props = asRecord(properties)
      const sessionID = asString(props?.sessionID)
      const status = asString(asRecord(props?.status)?.type)
      if (!sessionID || !status) return
      const projectID = sessionToProject.get(sessionID)
      if (!projectID) return
      setSessionForProject(projectID, sessionID, simplify(status))
      // Status badges read this store directly; only lifecycle events bump the session-list refresh key.
      return
    }

    if (type === "session.deleted") {
      const sessionID = asString(info?.id) ?? asString(asRecord(properties)?.sessionID)
      if (sessionID) forgetSession(sessionID)
      bump()
    }
  }

  return {
    apply,
    reconcileSessions(sessions: readonly SessionProject[]) {
      const next = new Set<string>()
      sessions.forEach((session) => {
        rememberSessionProject(session.id, session.projectID)
        next.add(session.id)
      })
      const tracked = Array.from(sessionToProject.keys())
      tracked.forEach((sessionID) => {
        if (!next.has(sessionID)) forgetSession(sessionID)
      })
    },
    version() {
      return store.version
    },
    statusFor(projectID: string): SimplifiedStatus {
      if ((store.busySessions[projectID]?.size ?? 0) > 0) return "busy"
      if ((store.errorSessions[projectID]?.size ?? 0) > 0) return "error"
      return "idle"
    },
    activeSessionFor(projectID: string): string | undefined {
      return store.busySessions[projectID]?.values().next().value
    },
    sessionStatusFor(sessionID: string): SimplifiedStatus {
      return store.sessions[sessionID] ?? "idle"
    },
  }
}

function createProjectStatus() {
  const globalSDK = useGlobalSDK()
  const tracker = createProjectStatusTracker()
  const unsub = globalSDK.event.listen((e) => tracker.apply(e.details))

  onCleanup(unsub)

  return tracker
}

const ProjectStatusContext = createContext<ReturnType<typeof createProjectStatus>>()

export function ProjectStatusProvider(props: ParentProps) {
  return <ProjectStatusContext.Provider value={createProjectStatus()}>{props.children}</ProjectStatusContext.Provider>
}

export function useProjectStatus() {
  const context = useContext(ProjectStatusContext)
  if (!context) throw new Error("useProjectStatus must be used within ProjectStatusProvider")
  return context
}
