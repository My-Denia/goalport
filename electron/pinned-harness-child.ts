import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const PIN = "bfec2387b8102975c84690f99be0f5f834fd0cbe";
const UNAUTHORIZED = "No model turn was sent, because this session is not authorized to spend subscription quota.";
const PIN_MISMATCH = "The pinned checkout does not match, so no harness was assigned.";
const PREPARE_FAILED = "The read-only session was not prepared, so nothing was sent.";
const CLOSE_FAILED = "The prepared session could not be closed, so nothing was sent.";
const NOT_HELD = "The read-only check did not hold, so nothing was sent.";
const TURN_STARTED = "A model turn was started, so this stopped.";
const UNCONFIGURED = "The pinned checkout is not configured, so no harness was assigned.";

function checkout(): string {
  const value = process.env.GOALPORT_HARNESS_CHECKOUT;
  return typeof value === "string" ? value : "";
}

console.log = (...args: unknown[]) => {
  const text = args.filter((item): item is string => typeof item === "string").join(" ");
  if (text) process.stderr.write(`${text}\n`);
};

function stateDir(): string {
  const value = process.env.GOALPORT_HARNESS_STATE_DIR;
  return typeof value === "string" ? value : "";
}

function configured(): string | null {
  if (!checkout() || !stateDir()) return UNCONFIGURED;
  return null;
}

function reply(id: string, body: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify({ id, ...body })}\n`);
}

function redact(text: string): string {
  return text
    .replace(/\/home\/[^/\s]+/g, "/home/<user>")
    .replace(/\/Users\/[^/\s]+/g, "/Users/<user>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>");
}

async function pinnedHead(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", checkout(), "rev-parse", "HEAD"], { timeout: 5000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

function serverFile(relativePath: string): string {
  return pathToFileURL(path.join(checkout(), "apps/server/src", relativePath)).href;
}

function packageFile(packageName: string, relativePath: string): string {
  const linked = fs.realpathSync(path.join(checkout(), "apps/server/node_modules", packageName));
  return pathToFileURL(path.join(linked, relativePath)).href;
}

async function loadModules() {
  const [Effect, Layer, Option, Exit, Cause, http, NodeServices, NodeHttpServer, nodeHttp, contracts, Net] = await Promise.all([
    import(packageFile("effect", "dist/Effect.js")),
    import(packageFile("effect", "dist/Layer.js")),
    import(packageFile("effect", "dist/Option.js")),
    import(packageFile("effect", "dist/Exit.js")),
    import(packageFile("effect", "dist/Cause.js")),
    import(packageFile("effect", "dist/http/index.js")),
    import(packageFile("@effect/platform-node", "dist/NodeServices.js")),
    import(packageFile("@effect/platform-node", "dist/NodeHttpServer.js")),
    import("node:http"),
    import(pathToFileURL(path.join(checkout(), "packages/contracts/src/index.ts")).href),
    import(pathToFileURL(path.join(checkout(), "packages/shared/src/Net.ts")).href),
  ]);
  const load = (relativePath: string) => import(serverFile(relativePath));
  const [
    ServerSecretStore,
    BackgroundPolicy,
    HostPowerMonitor,
    ServerConfig,
    ServerEnvironment,
    OpenCodeRuntime,
    OpenCodeServerLedger,
    ProviderEventLoggers,
    ModelManifest,
    AntigravityInstallation,
    CodexInstallation,
    ServerSettings,
    ResetCreditCoordinator,
    ProviderInstanceRegistryHydration,
    ProviderInstanceRegistry,
    SourceControlProviderRegistry,
    SqlitePersistence,
    ThreadManagement,
    WorktreeSetupTracker,
    ProjectCloneTracker,
    TerminalManager,
    ProjectService,
    GitWorkflow,
    ProjectSetupScriptRunner,
    TextGeneration,
    ProviderRegistry,
    ThreadLaunch,
    ProjectStore,
    RuntimePolicy,
    AcpClientPolicy,
    RuntimeLayer,
    ProjectEnrichment,
    ProjectFavicon,
    ProjectFiles,
    WorkspacePaths,
    RepositoryIdentity,
    VcsRegistry,
    VcsProcess,
    CheckpointStore,
    GitVcs,
    GitManager,
    ProjectionStore,
    NodePtyAdapter,
    PortScanner,
    NativeTelemetry,
    ResourceMonitorBinary,
    ProcessRunner,
    AzureDevOpsCli,
    BitbucketApi,
    GitHubCli,
    GitLabCli,
    ForgejoCli,
    SourceControlRepository,
    McpSessionRegistry,
  ] = await Promise.all([
    load("auth/ServerSecretStore.ts"),
    load("background/BackgroundPolicy.ts"),
    load("background/HostPowerMonitor.ts"),
    load("config.ts"),
    load("environment/ServerEnvironment.ts"),
    load("provider/opencodeRuntime.ts"),
    load("provider/OpenCodeServerLedger.ts"),
    load("provider/ProviderEventLoggers.ts"),
    load("provider/ModelManifest.ts"),
    load("provider/AntigravityInstallation.ts"),
    load("provider/CodexInstallation.ts"),
    load("serverSettings.ts"),
    load("provider/resetCreditCoordinator.ts"),
    load("provider/ProviderInstanceRegistryHydration.ts"),
    load("provider/ProviderInstanceRegistry.ts"),
    load("sourceControl/SourceControlProviderRegistry.ts"),
    load("persistence/Sqlite.ts"),
    load("orchestration-v2/ThreadManagementService.ts"),
    load("project/WorktreeSetupTracker.ts"),
    load("project/ProjectCloneTracker.ts"),
    load("terminal/Manager.ts"),
    load("project/ProjectService.ts"),
    load("git/GitWorkflowService.ts"),
    load("project/ProjectSetupScriptRunner.ts"),
    load("textGeneration/TextGeneration.ts"),
    load("provider/ProviderRegistry.ts"),
    load("orchestration-v2/ThreadLaunchService.ts"),
    load("orchestration-v2/ProjectStore.ts"),
    load("orchestration-v2/RuntimePolicy.ts"),
    load("provider/acp/AcpClientPolicy.ts"),
    load("orchestration-v2/runtimeLayer.ts"),
    load("project/ProjectEnrichmentService.ts"),
    load("project/ProjectFaviconResolver.ts"),
    load("project/T3ProjectFileLoader.ts"),
    load("workspace/WorkspacePaths.ts"),
    load("project/RepositoryIdentityResolver.ts"),
    load("vcs/VcsDriverRegistry.ts"),
    load("vcs/VcsProcess.ts"),
    load("checkpointing/CheckpointStore.ts"),
    load("vcs/GitVcsDriver.ts"),
    load("git/GitManager.ts"),
    load("orchestration-v2/ProjectionStore.ts"),
    load("terminal/NodePtyAdapter.ts"),
    load("preview/PortScanner.ts"),
    load("resourceTelemetry/NativeTelemetryClient.ts"),
    load("resourceTelemetry/ResourceMonitorBinary.ts"),
    load("processRunner.ts"),
    load("sourceControl/AzureDevOpsCli.ts"),
    load("sourceControl/BitbucketApi.ts"),
    load("sourceControl/GitHubCli.ts"),
    load("sourceControl/GitLabCli.ts"),
    load("sourceControl/ForgejoCli.ts"),
    load("sourceControl/SourceControlRepositoryService.ts"),
    load("mcp/McpSessionRegistry.ts"),
  ]);
  return {
    Effect, Layer, Option, Exit, Cause, http, NodeServices, NodeHttpServer, nodeHttp, contracts, Net,
    ServerSecretStore, BackgroundPolicy, HostPowerMonitor, ServerConfig, ServerEnvironment,
    OpenCodeRuntime, OpenCodeServerLedger, ProviderEventLoggers, ModelManifest,
    AntigravityInstallation, CodexInstallation, ServerSettings, ResetCreditCoordinator,
    ProviderInstanceRegistryHydration, ProviderInstanceRegistry, SourceControlProviderRegistry,
    SqlitePersistence, ThreadManagement, WorktreeSetupTracker, ProjectCloneTracker,
    TerminalManager, ProjectService, GitWorkflow, ProjectSetupScriptRunner, TextGeneration,
    ProviderRegistry, ThreadLaunch, ProjectStore, RuntimePolicy, AcpClientPolicy,
    RuntimeLayer, ProjectEnrichment, ProjectFavicon, ProjectFiles, WorkspacePaths, RepositoryIdentity,
    VcsRegistry, VcsProcess, CheckpointStore, GitVcs, GitManager, ProjectionStore, NodePtyAdapter,
    PortScanner, NativeTelemetry, ResourceMonitorBinary, ProcessRunner, AzureDevOpsCli, BitbucketApi,
    GitHubCli, GitLabCli, ForgejoCli, SourceControlRepository, McpSessionRegistry,
  };
}

let modulesPromise: ReturnType<typeof loadModules> | null = null;
function modules() {
  if (!modulesPromise) modulesPromise = loadModules();
  return modulesPromise;
}

function publicProvider(snapshot: {
  instanceId?: string;
  displayName?: string;
  driver?: string;
  enabled?: boolean;
  installed?: boolean;
  availability?: string;
  status?: string;
  auth?: { status?: string; type?: string; label?: string };
  models?: ReadonlyArray<{ slug?: string; name?: string; isDefault?: boolean; isLegacy?: boolean }>;
  usageLimits?: { unavailable?: { reason?: string }; windows?: ReadonlyArray<{ id?: string; usedPercent?: number }> };
}) {
  const limits = snapshot.usageLimits;
  return {
    instanceId: snapshot.instanceId,
    displayName: snapshot.displayName,
    driver: snapshot.driver,
    enabled: snapshot.enabled,
    installed: snapshot.installed,
    availability: snapshot.availability,
    status: snapshot.status,
    auth: {
      status: snapshot.auth?.status,
      type: snapshot.auth?.type,
      label: snapshot.auth?.label,
    },
    models: (snapshot.models ?? []).map((model) => ({
      slug: model.slug,
      name: model.name,
      isDefault: model.isDefault === true,
      isLegacy: model.isLegacy === true,
    })),
    ...(limits === undefined
      ? {}
      : {
          usageLimits: {
            ...(limits.unavailable === undefined ? {} : { unavailable: { reason: limits.unavailable.reason } }),
            windows: (limits.windows ?? []).flatMap((window) => (
              typeof window.id === "string" && typeof window.usedPercent === "number"
                ? [{ id: window.id, usedPercent: window.usedPercent }]
                : []
            )),
          },
        }),
  };
}

function failedProvider(instance: { instanceId?: string; displayName?: string; driverKind?: string }) {
  return {
    instanceId: instance.instanceId,
    displayName: instance.displayName || instance.instanceId,
    driver: instance.driverKind,
    enabled: false,
    installed: false,
    availability: "unavailable",
    status: "error",
    auth: { status: "unknown" },
    models: [],
  };
}

function registryLayer(mods: Awaited<ReturnType<typeof loadModules>>, directory: string) {
  const { Effect, Layer, http, NodeServices } = mods;
  const layerPlatform = Layer.merge(
    NodeServices.layer,
    Layer.mock(mods.SourceControlProviderRegistry.SourceControlProviderRegistry)({
      resolveLink: () => Effect.die("unused"),
    }),
  );
  const layerServerConfig = mods.ServerConfig.layerTest(directory, directory).pipe(Layer.provide(layerPlatform));
  return mods.ProviderInstanceRegistryHydration.layer.pipe(
    Layer.provide(Layer.mergeAll(
      layerServerConfig,
      mods.ServerSettings.layerTest(),
      mods.ServerSecretStore.layer.pipe(Layer.provide(layerServerConfig), Layer.provide(layerPlatform)),
      NodeServices.layer,
      http.FetchHttpClient.layer,
      mods.OpenCodeRuntime.layer.pipe(
        Layer.provide(mods.OpenCodeServerLedger.layerTest),
        Layer.provide(layerPlatform),
      ),
      Layer.succeed(mods.ProviderEventLoggers.ProviderEventLoggers, mods.ProviderEventLoggers.NoOpProviderEventLoggers),
      mods.ModelManifest.layerTest,
      mods.AntigravityInstallation.AntigravityInstallation.layer.pipe(
        Layer.provide(layerServerConfig),
        Layer.provide(http.FetchHttpClient.layer),
        Layer.provide(layerPlatform),
      ),
      mods.CodexInstallation.CodexInstallation.layer.pipe(
        Layer.provide(mods.ModelManifest.layerTest),
        Layer.provide(http.FetchHttpClient.layer),
        Layer.provide(layerServerConfig),
        Layer.provide(layerPlatform),
      ),
      Layer.succeed(mods.ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(mods.contracts.EnvironmentId.make("00000000-0000-4000-8000-0000000000c1")),
      }),
      mods.BackgroundPolicy.layer.pipe(
        Layer.provide(Layer.effect(mods.HostPowerMonitor.HostPowerMonitor, mods.HostPowerMonitor.make())),
        Layer.provide(mods.ServerSettings.layerTest()),
      ),
      mods.ResetCreditCoordinator.layer.pipe(Layer.provide(NodeServices.layer)),
    )),
  );
}

function executionLayer(mods: Awaited<ReturnType<typeof loadModules>>, directory: string) {
  const { Effect, Layer, NodeServices, http } = mods;
  const platform = NodeServices.layer;
  const config = mods.ServerConfig.layerTest(directory, directory).pipe(Layer.provide(platform));
  const database = mods.SqlitePersistence.layerConfig.pipe(Layer.provide(config), Layer.provide(platform));
  const settings = mods.ServerSettings.layerTest().pipe(Layer.provide(platform));
  const workspace = mods.WorkspacePaths.layer.pipe(Layer.provide(platform));
  const favicon = mods.ProjectFavicon.layer.pipe(
    Layer.provide(workspace),
    Layer.provide(mods.ProjectFiles.layer),
    Layer.provide(platform),
  );
  const enrichment = mods.ProjectEnrichment.layer.pipe(
    Layer.provide(mods.RepositoryIdentity.layer),
    Layer.provide(favicon),
  );
  const vcsProcess = mods.VcsProcess.layer.pipe(Layer.provide(config), Layer.provide(platform));
  const vcs = mods.VcsRegistry.layer.pipe(
    Layer.provide(vcsProcess),
    Layer.provide(config),
    Layer.provide(platform),
  );
  const checkpoints = mods.CheckpointStore.layer.pipe(Layer.provide(vcs));
  const registryPlatform = Layer.merge(
    platform,
    Layer.mock(mods.SourceControlProviderRegistry.SourceControlProviderRegistry)({
      resolveLink: () => Effect.die("unused"),
    }),
  );
  const registryConfig = mods.ServerConfig.layerTest(directory, directory).pipe(Layer.provide(registryPlatform));
  const registry = mods.ProviderInstanceRegistryHydration.layer.pipe(
    Layer.provide(Layer.mergeAll(
      registryConfig,
      settings,
      mods.ServerSecretStore.layer.pipe(Layer.provide(registryConfig), Layer.provide(registryPlatform)),
      platform,
      http.FetchHttpClient.layer,
      mods.OpenCodeRuntime.layer.pipe(Layer.provide(mods.OpenCodeServerLedger.layerTest), Layer.provide(registryPlatform)),
      Layer.succeed(mods.ProviderEventLoggers.ProviderEventLoggers, mods.ProviderEventLoggers.NoOpProviderEventLoggers),
      mods.ModelManifest.layerTest,
      mods.AntigravityInstallation.AntigravityInstallation.layer.pipe(
        Layer.provide(registryConfig),
        Layer.provide(http.FetchHttpClient.layer),
        Layer.provide(registryPlatform),
      ),
      mods.CodexInstallation.CodexInstallation.layer.pipe(
        Layer.provide(mods.ModelManifest.layerTest),
        Layer.provide(http.FetchHttpClient.layer),
        Layer.provide(registryConfig),
        Layer.provide(registryPlatform),
      ),
      Layer.succeed(mods.ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(mods.contracts.EnvironmentId.make("00000000-0000-4000-8000-0000000000c1")),
      }),
      mods.BackgroundPolicy.layer.pipe(
        Layer.provide(Layer.effect(mods.HostPowerMonitor.HostPowerMonitor, mods.HostPowerMonitor.make())),
        Layer.provide(settings),
      ),
      mods.ResetCreditCoordinator.layer.pipe(Layer.provide(platform)),
    )),
  );
  const environment = mods.ServerEnvironment.layer.pipe(
    Layer.provide(config),
    Layer.provide(mods.ServerSecretStore.layer.pipe(Layer.provide(registryConfig), Layer.provide(registryPlatform))),
    Layer.provide(platform),
  );
  const httpServer = mods.NodeHttpServer.layer(() => mods.nodeHttp.createServer(), {
    host: "127.0.0.1",
    port: 0,
  });
  const mcp = mods.McpSessionRegistry.layer.pipe(Layer.provide(environment), Layer.provide(httpServer));
  const stores = Layer.mergeAll(mods.ProjectionStore.layer, mods.ProjectStore.layer).pipe(Layer.provide(database));
  const providers = mods.ProviderRegistry.layer.pipe(
    Layer.provide(registry),
    Layer.provide(mods.ModelManifest.layerTest),
    Layer.provide(config),
    Layer.provide(platform),
  );
  const gitDriver = mods.GitVcs.layer.pipe(Layer.provide(mods.VcsProcess.layer), Layer.provide(config), Layer.provide(platform));
  const sourceControl = mods.SourceControlProviderRegistry.layer.pipe(
    Layer.provide(Layer.mergeAll(
      mods.AzureDevOpsCli.layer,
      mods.BitbucketApi.layer,
      mods.GitHubCli.layer,
      mods.GitLabCli.layer,
      mods.ForgejoCli.layer,
    )),
    Layer.provide(gitDriver),
    Layer.provide(vcs),
    Layer.provide(platform),
  );
  const gitManager = mods.GitManager.layer.pipe(
    Layer.provide(gitDriver),
    Layer.provide(sourceControl),
    Layer.provide(mods.TextGeneration.layer),
    Layer.provide(providers),
    Layer.provide(mods.RuntimeLayer.layerProjectSetupScriptRunner.pipe(
      Layer.provide(enrichment),
      Layer.provide(workspace),
      Layer.provide(database),
      Layer.provide(checkpoints),
      Layer.provide(config),
      Layer.provide(settings),
      Layer.provide(platform),
    )),
    Layer.provide(stores),
    Layer.provide(settings),
    Layer.provide(platform),
  );
  const git = mods.GitWorkflow.layer.pipe(Layer.provide(vcs), Layer.provide(gitDriver), Layer.provide(gitManager));
  const telemetry = mods.NativeTelemetry.layer.pipe(Layer.provide(mods.ResourceMonitorBinary.layer));
  const ports = mods.PortScanner.layer.pipe(
    Layer.provide(mods.Net.layer),
    Layer.provide(mods.ProcessRunner.layer),
    Layer.provide(http.FetchHttpClient.layer),
    Layer.provide(platform),
  );
  const terminal = mods.TerminalManager.layer.pipe(
    Layer.provide(mods.NodePtyAdapter.layer),
    Layer.provide(ports),
    Layer.provide(telemetry),
    Layer.provide(config),
    Layer.provide(settings),
    Layer.provide(platform),
  );
  return mods.RuntimeLayer.layerProduction.pipe(
    Layer.provide(terminal),
    Layer.provide(git),
    Layer.provide(mcp),
    Layer.provide(registry),
    Layer.provide(enrichment),
    Layer.provide(workspace),
    Layer.provide(checkpoints),
    Layer.provide(database),
    Layer.provide(config),
    Layer.provide(settings),
    Layer.provide(platform),
    Layer.provide(terminal),
    Layer.provide(sourceControl),
    Layer.provide(vcsProcess),
    Layer.provide(settings),
    Layer.provide(platform),
    Layer.provide(config),
    Layer.provide(http.FetchHttpClient.layer),
    Layer.provide(gitDriver),
    Layer.provide(mods.WorktreeSetupTracker.layer),
    Layer.provide(mods.ProjectCloneTracker.layer.pipe(
      Layer.provide(mods.SourceControlRepository.layer.pipe(
        Layer.provide(gitDriver),
        Layer.provide(sourceControl),
      )),
    )),
    Layer.provide(vcsProcess),
    Layer.provide(settings),
    Layer.provide(config),
    Layer.provide(platform),
    Layer.provide(http.FetchHttpClient.layer),
    Layer.provide(providers),
    Layer.provide(mods.TextGeneration.layer.pipe(Layer.provide(registry), Layer.provide(sourceControl))),
    Layer.provide(vcsProcess),
    Layer.provide(platform),
    Layer.provide(config),
    Layer.provide(settings),
    Layer.provide(http.FetchHttpClient.layer),
    Layer.provide(mods.ServerSecretStore.layer.pipe(Layer.provide(config), Layer.provide(platform))),
    Layer.provide(stores),
    Layer.provide(database),
    Layer.provideMerge(registry),
    Layer.provideMerge(stores),
  );
}

async function discover() {
  const missing = configured();
  if (missing) return { ok: false, providers: [], stopReason: missing };
  const head = await pinnedHead();
  if (head !== PIN) return { ok: false, providers: [], stopReason: PIN_MISMATCH };
  const mods = await modules();
  const { Effect } = mods;
  fs.mkdirSync(stateDir(), { recursive: true });
  const providers = await Effect.runPromise(Effect.gen(function* () {
    const registry = yield* mods.ProviderInstanceRegistry.ProviderInstanceRegistry;
    const instances = yield* registry.listInstances;
    return yield* Effect.forEach(
      instances,
      (instance) => instance.snapshot.refresh.pipe(
        Effect.timeout("40 seconds"),
        Effect.catch(() => Effect.succeed(null)),
        Effect.map((snapshot) => snapshot ? publicProvider(snapshot) : failedProvider(instance)),
      ),
      { concurrency: "unbounded" },
    );
  }).pipe(Effect.provide(registryLayer(mods, stateDir())), Effect.scoped));
  return { ok: true, providers, stopReason: null };
}

function worktreePathOf(command: Record<string, unknown>): string {
  const strategy = command.workspaceStrategy;
  if (!strategy || typeof strategy !== "object") return "";
  const record = strategy as { type?: unknown; worktreePath?: unknown };
  if (record.type !== "existing_worktree" || typeof record.worktreePath !== "string") return "";
  return record.worktreePath.trim();
}

async function prepare(command: Record<string, unknown>) {
  const missing = configured();
  if (missing) {
    return { ok: false, disposition: null, sandbox: null, approval: null, messageDispatched: false, errorText: missing };
  }
  const head = await pinnedHead();
  if (head !== PIN) {
    return { ok: false, disposition: null, sandbox: null, approval: null, messageDispatched: false, errorText: PIN_MISMATCH };
  }
  const safe = { ...command };
  delete safe.initialMessage;
  if (safe.type !== "goalport.coordinateTurn" || safe.runtimeMode !== "approval-required" || safe.approvalPolicy !== "never") {
    return { ok: false, disposition: null, sandbox: null, approval: null, messageDispatched: false, errorText: PREPARE_FAILED };
  }
  const sandboxPolicy = safe.sandboxPolicy;
  if (!sandboxPolicy || typeof sandboxPolicy !== "object" || (sandboxPolicy as { type?: unknown }).type !== "readOnly") {
    return { ok: false, disposition: null, sandbox: null, approval: null, messageDispatched: false, errorText: PREPARE_FAILED };
  }
  const selection = safe.modelSelection;
  if (!selection || typeof selection !== "object") {
    return { ok: false, disposition: null, sandbox: null, approval: null, messageDispatched: false, errorText: PREPARE_FAILED };
  }
  const instanceId = (selection as { instanceId?: unknown }).instanceId;
  const model = (selection as { model?: unknown }).model;
  const worktreePath = worktreePathOf(safe);
  if (typeof instanceId !== "string" || instanceId.trim().length === 0 || typeof model !== "string" || model.trim().length === 0 || worktreePath.length === 0) {
    return { ok: false, disposition: null, sandbox: null, approval: null, messageDispatched: false, errorText: PREPARE_FAILED };
  }
  const mods = await modules();
  const { Effect, Exit } = mods;
  const directory = stateDir();
  fs.mkdirSync(directory, { recursive: true });
  const projectId = mods.contracts.ProjectId.make("project-goalport-harness");
  const modelSelection = {
    instanceId: mods.contracts.ProviderInstanceId.make(instanceId),
    model,
  };
  const launched = await Effect.runPromise(Effect.gen(function* () {
    const projects = yield* mods.ProjectService.ProjectService;
    if (mods.Option.isNone(yield* projects.getById(projectId))) {
      yield* projects.create({
        commandId: mods.contracts.CommandId.make(`command-project-${randomUUID()}`),
        projectId,
        title: "Read-only session",
        workspaceRoot: worktreePath,
        scripts: [],
      });
    }
    const launches = yield* mods.ThreadLaunch.ThreadLaunchService;
    const launchInput = {
      commandId: mods.contracts.CommandId.make(`command-prepare-${randomUUID()}`),
      projectId,
      title: "Read-only session",
      modelSelection,
      runtimeMode: "approval-required" as const,
      interactionMode: "default" as const,
      coordinateCommand: {
        type: "goalport.coordinateTurn" as const,
        sandboxPolicy: { type: "readOnly" as const },
        approvalPolicy: "never" as const,
      },
      workspaceStrategy: { type: "existing_worktree" as const, worktreePath },
      createdBy: "user" as const,
      creationSource: "web" as const,
    };
    if ("initialMessage" in launchInput) return { kind: "dispatched" as const };
    const result = yield* launches.launch(launchInput);
    const messages = result.projection?.messages ?? [];
    const runs = result.projection?.runs ?? [];
    const dispatched = messages.length > 0 || runs.length > 0;
    const checked = yield* Effect.gen(function* () {
      if (dispatched) return { kind: "dispatched" as const };
      const registry = yield* mods.ProviderInstanceRegistry.ProviderInstanceRegistry;
      const projectStore = yield* mods.ProjectStore.ProjectStoreV2;
      const resolved = yield* Effect.gen(function* () {
        const policy = yield* mods.RuntimePolicy.RuntimePolicyV2;
        return yield* policy.resolve({ thread: result.projection.thread, modelSelection });
      }).pipe(Effect.provide(mods.RuntimePolicy.layerFromProjectStore.pipe(
        mods.Layer.provide(mods.Layer.succeed(mods.ProviderInstanceRegistry.ProviderInstanceRegistry, registry)),
        mods.Layer.provide(mods.Layer.succeed(mods.ProjectStore.ProjectStoreV2, projectStore)),
      )));
      const disposition = mods.AcpClientPolicy.acpPermissionDisposition(resolved, {
        options: [],
        sessionId: "prepare",
        toolCall: { kind: "edit", toolCallId: "prepare-edit" },
      });
      const sandbox = resolved.sandboxPolicy?.type ?? null;
      const approval = resolved.approvalPolicy ?? null;
      if (disposition !== "deny" || sandbox !== "readOnly" || approval !== "never") {
        return { kind: "deny" as const, disposition, sandbox, approval };
      }
      return { kind: "ready" as const, disposition, sandbox, approval };
    }).pipe(Effect.exit);
    const threads = yield* mods.ThreadManagement.ThreadManagementService;
    const closed = yield* threads.dispatch({
      type: "thread.stop",
      commandId: mods.contracts.CommandId.make(`command-stop-${randomUUID()}`),
      threadId: result.threadId,
      reason: "nothing was sent",
    }).pipe(Effect.exit);
    if (Exit.isFailure(checked)) {
      process.stderr.write(`${redact(mods.Cause.pretty(checked.cause))}\n`);
      return { kind: "failed" as const };
    }
    if (checked.value.kind === "dispatched") return checked.value;
    if (Exit.isFailure(closed)) return { kind: "close" as const };
    return checked.value;
  }).pipe(
    Effect.provide(executionLayer(mods, directory)),
    Effect.scoped,
    Effect.catchCause((cause) => {
      process.stderr.write(`${redact(mods.Cause.pretty(cause))}\n`);
      return Effect.succeed({ kind: "failed" as const });
    }),
  ));
  if (launched.kind === "ready") {
    return {
      ok: true,
      disposition: launched.disposition,
      sandbox: launched.sandbox,
      approval: launched.approval,
      messageDispatched: false,
      errorText: "",
    };
  }
  if (launched.kind === "dispatched") {
    return { ok: false, disposition: null, sandbox: null, approval: null, messageDispatched: true, errorText: TURN_STARTED };
  }
  if (launched.kind === "close") {
    return { ok: false, disposition: null, sandbox: null, approval: null, messageDispatched: false, errorText: CLOSE_FAILED };
  }
  if (launched.kind === "deny") {
    return {
      ok: false,
      disposition: launched.disposition,
      sandbox: launched.sandbox,
      approval: launched.approval,
      messageDispatched: false,
      errorText: NOT_HELD,
    };
  }
  return { ok: false, disposition: null, sandbox: null, approval: null, messageDispatched: false, errorText: PREPARE_FAILED };
}

function grantLines(): string[] {
  const file = path.join(stateDir(), "send-authorization");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

function grantListed(commandId: string): boolean {
  return commandId.length > 0 && grantLines().includes(commandId);
}

function takeGrant(commandId: string): boolean {
  if (!grantListed(commandId)) return false;
  const next = grantLines().filter((line) => line !== commandId);
  const file = path.join(stateDir(), "send-authorization");
  if (next.length === 0) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, `${next.join("\n")}\n`);
  return true;
}

function projectionStatus(projection: { runs?: ReadonlyArray<{ status?: string }> }): string {
  const runs = projection.runs ?? [];
  const last = runs[runs.length - 1];
  return typeof last?.status === "string" ? last.status : "";
}

function assistantReply(projection: { messages?: ReadonlyArray<{ role?: string; streaming?: boolean; text?: string }> }): string {
  let text = "";
  for (const message of projection.messages ?? []) {
    if (message.role === "assistant" && message.streaming !== true && typeof message.text === "string" && message.text.trim().length > 0) {
      text = message.text.trim();
    }
  }
  return text;
}

async function sendGranted(command: Record<string, unknown>) {
  const selection = command.modelSelection as { instanceId?: unknown; model?: unknown };
  const instanceId = typeof selection.instanceId === "string" ? selection.instanceId : "";
  const model = typeof selection.model === "string" ? selection.model : "";
  const worktreePath = worktreePathOf(command);
  const text = (command.initialMessage as { text?: unknown } | undefined)?.text;
  if (typeof text !== "string" || text.trim().length === 0 || !instanceId || !model || !worktreePath) {
    return { ok: false, text: "", errorText: PREPARE_FAILED, messageDispatched: false };
  }
  const mods = await modules();
  const { Effect } = mods;
  const directory = stateDir();
  const projectId = mods.contracts.ProjectId.make("project-goalport-harness");
  const modelSelection = {
    instanceId: mods.contracts.ProviderInstanceId.make(instanceId),
    model,
  };
  const sent = await Effect.runPromise(Effect.gen(function* () {
    const launches = yield* mods.ThreadLaunch.ThreadLaunchService;
    const threads = yield* mods.ThreadManagement.ThreadManagementService;
    const result = yield* launches.launch({
      commandId: mods.contracts.CommandId.make(`command-send-${randomUUID()}`),
      projectId,
      title: "Read-only session",
      modelSelection,
      runtimeMode: "approval-required" as const,
      interactionMode: "default" as const,
      coordinateCommand: {
        type: "goalport.coordinateTurn" as const,
        sandboxPolicy: { type: "readOnly" as const },
        approvalPolicy: "never" as const,
      },
      workspaceStrategy: { type: "existing_worktree" as const, worktreePath },
      initialMessage: { text },
      createdBy: "user" as const,
      creationSource: "web" as const,
    });
    let status = "";
    let replyText = "";
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const projection = yield* threads.getThreadProjection(result.threadId);
      status = projectionStatus(projection);
      replyText = assistantReply(projection);
      if (status === "waiting") break;
      if (status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled" || status === "rolled_back") break;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 4000)));
    }
    yield* threads.dispatch({
      type: "thread.stop",
      commandId: mods.contracts.CommandId.make(`command-stop-${randomUUID()}`),
      threadId: result.threadId,
      reason: "the check stopped",
    }).pipe(Effect.exit);
    return { status, replyText };
  }).pipe(
    Effect.provide(executionLayer(mods, directory)),
    Effect.scoped,
    Effect.catchCause((cause) => {
      process.stderr.write(`${redact(mods.Cause.pretty(cause))}\n`);
      return Effect.succeed({ status: "failed", replyText: "" });
    }),
  ));
  if (sent.status === "completed" && sent.replyText.length > 0) {
    return { ok: true, text: sent.replyText, errorText: "", messageDispatched: true };
  }
  if (sent.status === "waiting") {
    return { ok: false, text: sent.replyText, errorText: "The harness asked for approval, so this stopped.", messageDispatched: true };
  }
  if (sent.status === "completed") {
    return { ok: false, text: "", errorText: "The harness finished without any text, so this stopped.", messageDispatched: true };
  }
  return { ok: false, text: sent.replyText, errorText: "The harness did not finish, so this stopped.", messageDispatched: true };
}

async function run(command: Record<string, unknown> = {}) {
  if (!stateDir()) return { ok: false, text: "", errorText: UNAUTHORIZED, messageDispatched: false };
  const commandId = typeof command.commandId === "string" ? command.commandId.trim() : "";
  if (!grantListed(commandId)) return { ok: false, text: "", errorText: UNAUTHORIZED, messageDispatched: false };
  const missing = configured();
  if (missing) return { ok: false, text: "", errorText: missing, messageDispatched: false };
  const head = await pinnedHead();
  if (head !== PIN) return { ok: false, text: "", errorText: PIN_MISMATCH, messageDispatched: false };
  const prepared = await prepare(command);
  if (!prepared.ok || prepared.messageDispatched) {
    if (prepared.messageDispatched) takeGrant(commandId);
    return {
      ok: false,
      text: "",
      errorText: prepared.errorText || (prepared.messageDispatched ? TURN_STARTED : PREPARE_FAILED),
      messageDispatched: prepared.messageDispatched === true,
    };
  }
  if (!takeGrant(commandId)) return { ok: false, text: "", errorText: UNAUTHORIZED, messageDispatched: false };
  return sendGranted(command);
}

async function handle(message: { id?: string; method?: string; command?: Record<string, unknown> }) {
  const id = typeof message.id === "string" ? message.id : "missing";
  if (message.method === "shutdown") {
    process.exit(0);
  }
  if (message.method === "discover") {
    reply(id, await discover());
    return;
  }
  if (message.method === "prepare") {
    reply(id, await prepare(message.command ?? {}));
    return;
  }
  if (message.method === "run") {
    reply(id, await run(message.command ?? {}));
    return;
  }
  reply(id, { ok: false, errorText: PREPARE_FAILED });
}

let chain = Promise.resolve();
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (!line) continue;
    let message: { id?: string; method?: string; command?: Record<string, unknown> };
    try {
      message = JSON.parse(line) as { id?: string; method?: string; command?: Record<string, unknown> };
    } catch {
      continue;
    }
    chain = chain.then(() => handle(message)).catch(() => {
      reply(typeof message.id === "string" ? message.id : "missing", {
        ok: false,
        errorText: PREPARE_FAILED,
        messageDispatched: false,
      });
    });
  }
});
process.stdin.on("end", () => {
  chain.finally(() => process.exit(0));
});
