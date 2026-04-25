import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { Logo } from "@opencode-ai/ui/logo"
import { base64Encode } from "@opencode-ai/shared/util/encode"
import { useNavigate } from "@solidjs/router"
import { DateTime } from "luxon"
import { createMemo, createResource, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useProjectStatus } from "@/context/project-status"
import { useServer } from "@/context/server"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { GlobalSession } from "@opencode-ai/sdk/v2/client"
import {
  cleanSessionTitle,
  displayProjectName,
  groupSessionsByProject,
  type ProjectCard,
  type SortMode,
} from "./dashboard-helpers"

export default function Dashboard() {
  const sync = useGlobalSync()
  const layout = useLayout()
  const platform = usePlatform()
  const dialog = useDialog()
  const navigate = useNavigate()
  const server = useServer()
  const language = useLanguage()
  const projectStatus = useProjectStatus()
  const globalSDK = useGlobalSDK()
  const [state, setState] = createStore({ search: "", sort: "recent" as SortMode })

  onMount(() => {
    layout.mobileSidebar.hide()
  })

  const homedir = createMemo(() => sync.data.path.home ?? "")
  const serverDotClass = createMemo(() => {
    const healthy = server.healthy()
    if (healthy === true) return "bg-icon-success-base"
    if (healthy === false) return "bg-icon-critical-base"
    return "bg-border-weak-base"
  })

  const [allSessions, sessions] = createResource(
    () => `${server.key}:${projectStatus.version()}`,
    () =>
      globalSDK
        .createClient({ throwOnError: false })
        .experimental.session.list({ roots: true, limit: 500 })
        .then((result) => {
          const data = (result.data ?? []) as GlobalSession[]
          projectStatus.reconcileSessions(data.map((session) => ({ id: session.id, projectID: session.projectID })))
          return data
        })
        .catch(() => [] as GlobalSession[]),
  )

  onMount(() => {
    const handler = () => {
      if (document.visibilityState === "visible") void sessions.refetch()
    }
    document.addEventListener("visibilitychange", handler)
    onCleanup(() => document.removeEventListener("visibilitychange", handler))
  })

  const sessionsByProject = createMemo(() => groupSessionsByProject(allSessions() ?? []))
  const allProjects = createMemo<ProjectCard[]>(() =>
    sync.data.project.map((project) => ({
      id: project.id,
      worktree: project.worktree,
      name: project.name ?? null,
      time: { created: project.time.created, updated: project.time.updated },
    })),
  )
  const projectById = createMemo(() => new Map(allProjects().map((project) => [project.id, project])))
  const filteredProjectIDs = createMemo(() => {
    const query = state.search.toLowerCase().trim()
    const matched = query
      ? allProjects().filter((project) => {
          const sessionTitles = (sessionsByProject()[project.id] ?? [])
            .map((session) => session.title.toLowerCase())
            .join(" ")
          return (
            displayProjectName(project).toLowerCase().includes(query) ||
            project.worktree.toLowerCase().includes(query) ||
            sessionTitles.includes(query)
          )
        })
      : allProjects()

    const sorted = matched.slice().sort((a, b) => {
      if (state.sort === "name") return displayProjectName(a).localeCompare(displayProjectName(b))
      if (state.sort === "sessions")
        return (sessionsByProject()[b.id]?.length ?? 0) - (sessionsByProject()[a.id]?.length ?? 0)
      return (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created)
    })
    return sorted.map((project) => project.id)
  })

  const sortLabel = createMemo(() => (state.sort === "recent" ? "Recent" : state.sort === "name" ? "A-Z" : "Sessions"))

  function bestSessionHref(project: ProjectCard) {
    const encoded = base64Encode(project.worktree)
    const projectSessions = sessionsByProject()[project.id] ?? []
    const activeID = projectStatus.activeSessionFor(project.id)
    if (activeID && projectSessions.some((session) => session.id === activeID)) return `/${encoded}/session/${activeID}`
    if (projectSessions[0]) return `/${encoded}/session/${projectSessions[0].id}`
    return `/${encoded}/session`
  }

  function navigateToProject(project: ProjectCard, href = bestSessionHref(project)) {
    layout.projects.open(project.worktree)
    server.projects.touch(project.worktree)
    navigate(href)
  }

  async function chooseProject() {
    const resolve = (result: string | string[] | null) => {
      if (Array.isArray(result)) {
        result.forEach((directory) => {
          layout.projects.open(directory)
          server.projects.touch(directory)
        })
        if (result[0]) navigate(`/${base64Encode(result[0])}`)
        return
      }
      if (!result) return
      layout.projects.open(result)
      server.projects.touch(result)
      navigate(`/${base64Encode(result)}`)
    }

    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      resolve(
        await platform.openDirectoryPickerDialog({
          title: language.t("command.project.open"),
          multiple: true,
        }),
      )
      return
    }

    dialog.show(
      () => <DialogSelectDirectory multiple={true} onSelect={resolve} />,
      () => resolve(null),
    )
  }

  const initialCenter = typeof document !== "undefined" ? document.getElementById("opencode-titlebar-center") : null
  const initialRight = typeof document !== "undefined" ? document.getElementById("opencode-titlebar-right") : null
  const [mounts, setMounts] = createStore({ center: initialCenter, right: initialRight })
  if (!initialCenter || !initialRight) {
    onMount(() => {
      if (!initialCenter) setMounts("center", document.getElementById("opencode-titlebar-center"))
      if (!initialRight) setMounts("right", document.getElementById("opencode-titlebar-right"))
    })
  }

  const SortDropdown = (props: { class?: string }) => (
    <DropdownMenu>
      <DropdownMenu.Trigger
        as={Button}
        size="small"
        variant="ghost"
        class={`text-12-regular gap-1 ${props.class ?? ""}`}
      >
        {sortLabel()}
        <Icon name="chevron-down" size="small" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content>
          <DropdownMenu.Item onSelect={() => setState("sort", "recent")}>
            <DropdownMenu.ItemLabel>Recent</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => setState("sort", "name")}>
            <DropdownMenu.ItemLabel>A-Z</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => setState("sort", "sessions")}>
            <DropdownMenu.ItemLabel>Sessions</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )

  const ProjectStatusDot = (props: { projectID: string; class?: string }) => {
    const status = createMemo(() => projectStatus.statusFor(props.projectID))
    return (
      <div
        class={`rounded-full shrink-0 ${props.class ?? "size-2"}`}
        classList={{
          "bg-icon-success-base animate-pulse": status() === "busy",
          "bg-icon-critical-base": status() === "error",
          "bg-border-weak-base": status() === "idle",
        }}
        title={status() === "busy" ? "Active" : status() === "error" ? "Error" : "Idle"}
      />
    )
  }

  const TitlebarCenter = () => (
    <Show when={mounts.center}>
      <Portal mount={mounts.center!}>
        <div class="xl:hidden flex items-center gap-1 w-[180px] max-w-[50vw]">
          <input
            type="text"
            placeholder="Search..."
            value={state.search}
            onInput={(event) => setState("search", event.currentTarget.value)}
            class="w-full px-2 py-0.5 text-13-regular bg-surface-raised-base border border-border-weak-base rounded text-text-base placeholder:text-text-weak focus:outline-none focus:border-border-accent-base"
          />
        </div>
      </Portal>
    </Show>
  )

  const TitlebarRight = () => (
    <Show when={mounts.right}>
      <Portal mount={mounts.right!}>
        <div class="xl:hidden flex items-center gap-1 pr-1">
          <button
            type="button"
            class="flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-surface-raised-base transition-colors"
            onClick={() => dialog.show(() => <DialogSelectServer />)}
          >
            <div classList={{ "size-2 rounded-full shrink-0": true, [serverDotClass()]: true }} />
          </button>
        </div>
      </Portal>
    </Show>
  )

  return (
    <>
      <TitlebarCenter />
      <TitlebarRight />
      <div class="mx-auto mt-2 sm:mt-12 w-full max-w-5xl px-4 pb-16">
        <div class="hidden xl:flex items-center justify-between mb-8">
          <Logo class="h-8 opacity-70" />
          <Button
            size="normal"
            variant="ghost"
            class="text-12-regular text-text-weak"
            onClick={() => dialog.show(() => <DialogSelectServer />)}
          >
            <div classList={{ "size-2 rounded-full": true, [serverDotClass()]: true }} />
            {server.name}
          </Button>
        </div>

        <div class="hidden xl:flex gap-2 items-center mb-5">
          <input
            type="text"
            placeholder="Search projects or sessions..."
            value={state.search}
            onInput={(event) => setState("search", event.currentTarget.value)}
            class="flex-1 min-w-0 px-3 py-1.5 text-14-regular bg-surface-base border border-border-weak-base rounded-lg text-text-base placeholder:text-text-weak focus:outline-none focus:border-border-accent-base"
          />
          <SortDropdown />
          <Button icon="folder-add-left" size="normal" class="pl-2 pr-3 shrink-0" onClick={chooseProject}>
            {language.t("command.project.open")}
          </Button>
        </div>

        <Switch>
          <Match when={!sync.ready}>
            <div class="flex flex-col items-center gap-3 mt-20">
              <div class="text-12-regular text-text-weak">{language.t("common.loading")}</div>
            </div>
          </Match>
          <Match when={allProjects().length === 0}>
            <div class="flex flex-col items-center gap-3 mt-20">
              <Icon name="folder-add-left" size="large" />
              <div class="flex flex-col gap-1 items-center">
                <div class="text-14-medium text-text-strong">{language.t("home.empty.title")}</div>
                <div class="text-12-regular text-text-weak">{language.t("home.empty.description")}</div>
              </div>
              <Button class="px-3 mt-1" onClick={chooseProject}>
                {language.t("command.project.open")}
              </Button>
            </div>
          </Match>
          <Match when={filteredProjectIDs().length === 0 && state.search}>
            <div class="flex flex-col items-center gap-3 mt-16">
              <div class="text-14-regular text-text-weak">No projects match "{state.search}"</div>
              <Button size="small" variant="ghost" onClick={() => setState("search", "")}>
                Clear search
              </Button>
            </div>
          </Match>
          <Match when={true}>
            <div class="sm:hidden flex items-center justify-between px-1 mb-1">
              <span class="text-11-regular text-text-weak">{filteredProjectIDs().length} projects</span>
              <SortDropdown />
            </div>

            <div class="sm:hidden flex flex-col divide-y divide-border-weak-base border border-border-weak-base rounded-lg overflow-hidden">
              <For each={filteredProjectIDs()}>
                {(projectID) => <MobileProjectRow project={projectById().get(projectID)!} />}
              </For>
            </div>

            <div class="hidden sm:grid sm:grid-cols-2 lg:grid-cols-2 gap-4">
              <For each={filteredProjectIDs()}>
                {(projectID) => <ProjectCardView project={projectById().get(projectID)!} />}
              </For>
            </div>

            <div class="mt-6 text-12-regular text-text-weak text-center">
              {filteredProjectIDs().length === allProjects().length
                ? `${allProjects().length} project${allProjects().length === 1 ? "" : "s"}`
                : `${filteredProjectIDs().length} of ${allProjects().length} projects`}
            </div>
          </Match>
        </Switch>
      </div>
    </>
  )

  function MobileProjectRow(props: { project: ProjectCard }) {
    const projectSessions = createMemo(() => sessionsByProject()[props.project.id] ?? [])
    const latestSession = createMemo(() => projectSessions()[0])
    return (
      <a
        href={bestSessionHref(props.project)}
        onClick={(event) => {
          event.preventDefault()
          navigateToProject(props.project)
        }}
        class="flex items-center gap-3 px-3 py-2.5 bg-surface-base hover:bg-surface-base-hover active:bg-surface-raised-base transition-colors cursor-pointer"
      >
        <ProjectStatusDot projectID={props.project.id} />
        <div class="flex-1 min-w-0">
          <div class="text-13-medium text-text-strong truncate">{displayProjectName(props.project)}</div>
          <div class="text-11-regular text-text-weak truncate">
            <Show
              when={latestSession()}
              fallback={<span class="font-mono">{props.project.worktree.replace(homedir(), "~")}</span>}
            >
              {cleanSessionTitle(latestSession()!.title)}
            </Show>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <Show when={projectSessions().length > 0}>
            <span class="text-11-regular text-text-weak">{projectSessions().length}</span>
          </Show>
          <Icon name="arrow-right" />
        </div>
      </a>
    )
  }

  function ProjectCardView(props: { project: ProjectCard }) {
    const projectSessions = createMemo(() => sessionsByProject()[props.project.id] ?? [])
    const newSessionHref = createMemo(() => `/${base64Encode(props.project.worktree)}/session`)
    return (
      <div class="group flex flex-col h-48 rounded-lg border border-border-weak-base bg-surface-base hover:border-border-base transition-colors overflow-hidden">
        <a
          href={bestSessionHref(props.project)}
          onClick={(event) => {
            event.preventDefault()
            navigateToProject(props.project)
          }}
          class="flex-1 block p-4 cursor-pointer overflow-hidden"
        >
          <div class="flex items-start justify-between gap-2 mb-2">
            <div class="flex items-center gap-2 min-w-0">
              <ProjectStatusDot projectID={props.project.id} class="size-2 mt-0.5" />
              <span class="text-14-medium text-text-strong truncate">{displayProjectName(props.project)}</span>
            </div>
            <Show when={projectSessions().length > 0}>
              <span class="text-11-regular text-text-weak bg-surface-raised-base rounded px-1.5 py-0.5 shrink-0">
                {projectSessions().length}
              </span>
            </Show>
          </div>
          <div class="text-11-regular text-text-weak font-mono break-all mb-3">
            {props.project.worktree.replace(homedir(), "~")}
          </div>
          <Show when={projectSessions().length > 0}>
            <div class="flex flex-col gap-1">
              <For each={projectSessions().slice(0, 3)}>
                {(session) => {
                  const sessionStatus = createMemo(() => projectStatus.sessionStatusFor(session.id))
                  return (
                    <div class="flex items-center gap-2 min-w-0">
                      <div
                        class="size-1.5 rounded-full shrink-0"
                        classList={{
                          "bg-icon-success-base animate-pulse": sessionStatus() === "busy",
                          "bg-icon-critical-base": sessionStatus() === "error",
                          "bg-border-weak-base opacity-40": sessionStatus() === "idle",
                        }}
                      />
                      <span class="text-12-regular text-text-base truncate">{cleanSessionTitle(session.title)}</span>
                    </div>
                  )
                }}
              </For>
              <Show when={projectSessions().length > 3}>
                <div class="text-11-regular text-text-weak pl-3.5">+{projectSessions().length - 3} more</div>
              </Show>
            </div>
          </Show>
          <div class="mt-3 text-11-regular text-text-weak">
            {DateTime.fromMillis(props.project.time.updated ?? props.project.time.created).toRelative()}
          </div>
        </a>
        <div class="flex items-center justify-end px-3 pb-2 pt-0 gap-1 border-t border-border-weak-base">
          <div class="invisible group-hover:visible">
            <Button
              size="small"
              variant="ghost"
              class="text-11-regular text-text-weak gap-1"
              onClick={(event: MouseEvent) => {
                event.stopPropagation()
                navigateToProject(props.project, newSessionHref())
              }}
            >
              <Icon name="edit" />
              New session
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
