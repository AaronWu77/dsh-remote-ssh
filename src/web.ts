import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { RemoteOpenFileMode, RemoteSshManager, RemoteSshServer } from './manager.ts'
import { openRemoteFile } from './open-file.ts'
import z from '@deepseek-ai/schemastery'
import { AgentHostConnectionError, SshExecutionError, formatConnectionDiagnostic } from './connection-error.ts'
import { appendSshHost, defaultSshConfigFiles, discoverSshConfigHosts } from './ssh-config.ts'
import { RemoteSshDiagnostics, parseDiagnosticId, parseDiagnosticRequest } from './diagnostics.ts'
import { RemoteSshManagementError } from './management-error.ts'

export const REMOTE_SSH_STATE_PATH = '/plugins/dsh-remote-ssh/state'
export const REMOTE_SSH_SERVER_PATH = '/plugins/dsh-remote-ssh/server'
export const REMOTE_SSH_SERVER_REMOVE_PATH = '/plugins/dsh-remote-ssh/server/remove'
export const REMOTE_SSH_WORKSPACE_PATH = '/plugins/dsh-remote-ssh/workspace'
export const REMOTE_SSH_WORKSPACE_REMOVE_PATH = '/plugins/dsh-remote-ssh/workspace/remove'
export const REMOTE_SSH_LOCAL_WORKSPACE_PATH = '/plugins/dsh-remote-ssh/local-workspace'
export const REMOTE_SSH_PROBE_PATH = '/plugins/dsh-remote-ssh/probe'
export const REMOTE_SSH_CONFIG_HOST_PATH = '/plugins/dsh-remote-ssh/ssh-config/host'
export const REMOTE_SSH_SETTINGS_PATH = '/plugins/dsh-remote-ssh/settings'
export const REMOTE_SSH_DIRECTORY_PATH = '/plugins/dsh-remote-ssh/directory'
export const REMOTE_SSH_OPEN_FILE_PATH = '/plugins/dsh-remote-ssh/open-file'
export const REMOTE_SSH_DIAGNOSTIC_START_PATH = '/plugins/dsh-remote-ssh/diagnostics/start'
export const REMOTE_SSH_DIAGNOSTIC_STATUS_PATH = '/plugins/dsh-remote-ssh/diagnostics/status'
export const REMOTE_SSH_DIAGNOSTIC_CANCEL_PATH = '/plugins/dsh-remote-ssh/diagnostics/cancel'

export const name = 'dsh-remote-ssh-web'
export const inject = ['remoteSshManager']

/** Maximum number of diagnostic characters returned by the Web endpoints. */
export const Config = z.object({
  maxErrorCharacters: z.number().default(16_384),
  diagnosticTimeoutMs: z.number().default(120_000),
  diagnosticTerminalTimeoutMs: z.number().default(15_000),
  diagnosticLeaseMs: z.number().default(45_000),
  diagnosticRetentionMs: z.number().default(600_000),
  diagnosticMaxConcurrent: z.number().default(2),
  diagnosticMaxRetained: z.number().default(20),
})
interface WebConfig {
  maxErrorCharacters: number
  diagnosticTimeoutMs?: number
  diagnosticTerminalTimeoutMs?: number
  diagnosticLeaseMs?: number
  diagnosticRetentionMs?: number
  diagnosticMaxConcurrent?: number
  diagnosticMaxRetained?: number
}

function resolveDiagnosticPolicy(config: WebConfig) {
  const policy = {
    timeoutMs: config.diagnosticTimeoutMs ?? 120_000,
    terminalTimeoutMs: config.diagnosticTerminalTimeoutMs ?? 15_000,
    leaseMs: config.diagnosticLeaseMs ?? 45_000,
    retentionMs: config.diagnosticRetentionMs ?? 600_000,
    maxConcurrent: config.diagnosticMaxConcurrent ?? 2,
    maxRetained: config.diagnosticMaxRetained ?? 20,
  }
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('dsh-remote-ssh/web: diagnostic ' + key + ' must be a positive integer')
  }
  if (policy.maxRetained < policy.maxConcurrent) throw new Error('dsh-remote-ssh/web: diagnostic retention must cover all concurrent tasks')
  return policy
}

/**
 * The composition's browser-trust fence (`ctx.connection`, owned by
 * `@deepseek-ai/dsh-client-connection`): its Host/Origin checks defeat DNS
 * rebinding and cross-site calls, and its browser authentication rejects
 * callers that never exchanged the launch token. These routes exist only where
 * that fence does, because without it they are unauthenticated writes to the
 * SSH config, the workspace catalog, and the remote filesystem.
 */
interface ConnectionFence {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
  /** rc.2 raw admission also accepts live API Peers; these routes remain owner-only. */
  admit?(request: { readonly headers: IncomingMessage['headers'] }):
    { rejection: 401 | 403 } | { peer: { principal: { kind: string } } }
}

/** Activate the Web surface only in compositions that provide a Web host and its trust fence. */
export function apply(ctx: Context, config: WebConfig): void {
  if (!Number.isSafeInteger(config.maxErrorCharacters) || config.maxErrorCharacters <= 0) throw new Error('dsh-remote-ssh/web: maxErrorCharacters must be a positive integer')
  resolveDiagnosticPolicy(config)
  ctx.inject(['webServer', 'connection'], ctx => registerWebRoutes(ctx, config))
}

/** Register same-origin catalog mutation and connection-probe endpoints. */
function registerWebRoutes(ctx: Context, config: WebConfig): void {
  const fence = ctx.get('connection') as ConnectionFence | undefined
  if (fence === undefined) throw new Error('dsh-remote-ssh/web: the composition browser-trust fence is unavailable')
  const diagnostics = new RemoteSshDiagnostics(ctx.remoteSshManager, resolveDiagnosticPolicy(config))
  const route = (ctx: Context, path: string, method: string | readonly string[], handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): (() => void) => registerRoute(ctx, path, method, handler, config.maxErrorCharacters, fence)
  const routes = [
    route(ctx, REMOTE_SSH_DIAGNOSTIC_START_PATH, 'POST', async (req, res) => {
      const input = parseDiagnosticRequest(await readJson(req))
      const server = await resolveAvailableServer(ctx.remoteSshManager, input.serverId)
      json(res, 202, diagnostics.start(input, server))
    }),
    route(ctx, REMOTE_SSH_DIAGNOSTIC_STATUS_PATH, 'POST', async (req, res) => {
      json(res, 200, diagnostics.status(parseDiagnosticId((await readJson(req)).id)))
    }),
    route(ctx, REMOTE_SSH_DIAGNOSTIC_CANCEL_PATH, 'POST', async (req, res) => {
      const report = diagnostics.cancel(parseDiagnosticId((await readJson(req)).id))
      if (report) json(res, 200, report)
      else { res.statusCode = 204; res.end() }
    }),
    route(ctx, REMOTE_SSH_STATE_PATH, 'GET', async (_req, res) => {
      json(res, 200, await catalogState(ctx.remoteSshManager))
    }),
    route(ctx, REMOTE_SSH_SETTINGS_PATH, ['GET', 'POST'], async (req, res) => {
      if (req.method === 'GET') { json(res, 200, ctx.remoteSshManager.preferencesState()); return }
      const body = await readJson(req)
      const sshConfigFile = optionalString(body, 'sshConfigFile')
      const openFileEditorPath = optionalString(body, 'openFileEditorPath')
      const openFileMode = body.openFileMode === undefined ? undefined : parseOpenFileMode(body.openFileMode)
      const current = ctx.remoteSshManager.preferencesState()
      const expectedRevision = requiredString(body, 'expectedRevision')
      if (body.confirmConnectionReset !== undefined && typeof body.confirmConnectionReset !== 'boolean') throw new Error('confirmConnectionReset must be boolean')
      json(res, 200, await ctx.remoteSshManager.savePreferences({
        expectedRevision, sshConfigFile: sshConfigFile ?? current.sshConfigFile,
        openFileMode: openFileMode ?? current.openFileMode,
        openFileEditorPath: openFileEditorPath ?? current.openFileEditorPath,
        confirmConnectionReset: body.confirmConnectionReset === true,
      }))
    }),
    route(ctx, REMOTE_SSH_DIRECTORY_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      const server = await resolveAvailableServer(ctx.remoteSshManager, requiredString(body, 'serverId'))
      const path = body.path
      if (path !== undefined && typeof path !== 'string') throw new Error('path must be a string')
      json(res, 200, await ctx.remoteSshManager.listRemoteDirectory(server, path as string | undefined))
    }),
    route(ctx, REMOTE_SSH_OPEN_FILE_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      json(res, 200, await openRemoteFile(
        ctx.remoteSshManager,
        requiredString(body, 'workspaceId'),
        requiredString(body, 'path'),
      ))
    }),
    route(ctx, REMOTE_SSH_WORKSPACE_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      const server = await resolveAvailableServer(ctx.remoteSshManager, requiredString(body, 'serverId'))
      const configured = ctx.remoteSshManager.snapshot().servers.find(candidate => candidate.id === server.id)
        ?? await ctx.remoteSshManager.addServer({ id: server.id, label: server.label, sshTarget: server.sshTarget })
      const created = await ctx.remoteSshManager.addWorkspace(configured.id, requiredString(body, 'remotePath'))
      json(res, 201, { id: created.workspace.id, aliasPath: created.aliasPath })
    }),
    route(ctx, REMOTE_SSH_WORKSPACE_REMOVE_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      json(res, 200, { removed: await ctx.remoteSshManager.removeWorkspace(requiredString(body, 'id')) })
    }),
    route(ctx, REMOTE_SSH_LOCAL_WORKSPACE_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      json(res, 200, { path: await ctx.remoteSshManager.adoptLocalWorkspace(requiredString(body, 'path')) })
    }),
    route(ctx, REMOTE_SSH_PROBE_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      const server = await resolveAvailableServer(ctx.remoteSshManager, requiredString(body, 'id'))
      const transport = ctx.remoteSshManager.transportFor(server, 'probe')
      json(res, 200, await probeServer(transport.executable, server.sshTarget, transport.args))
    }),
    route(ctx, REMOTE_SSH_CONFIG_HOST_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      const configPath = resolve(requiredString(body, 'configPath'))
      const allowed = activeConfigFiles(ctx.remoteSshManager)
      if (!allowed.some(candidate => samePath(candidate, configPath))) throw new Error('selected SSH config file is not active')
      json(res, 201, await appendSshHost(configPath, requiredString(body, 'command')))
    }),
  ]
  ctx.effect(() => async () => { for (const dispose of routes) dispose(); await diagnostics.close() }, 'Remote SSH Web routes')
}

interface AvailableServer extends RemoteSshServer {
  source: 'ssh-config' | 'saved'
  configPath?: string
  hostName?: string
  user?: string
  port?: number
}

async function catalogState(manager: RemoteSshManager) {
  const snapshot = manager.snapshot()
  const configFiles = activeConfigFiles(manager)
  const discovery = await discoverSshConfigHosts(configFiles)
  const servers: AvailableServer[] = snapshot.servers.map(server => ({ ...server, source: 'saved' }))
  for (const discovered of discovery.hosts) {
    const configured = servers.find(server => server.sshTarget === discovered.sshTarget)
    if (configured === undefined) servers.push({ ...discovered, source: 'ssh-config' })
    else Object.assign(configured, {
      source: 'ssh-config' as const,
      configPath: discovered.configPath,
      ...(discovered.hostName === undefined ? {} : { hostName: discovered.hostName }),
      ...(discovered.user === undefined ? {} : { user: discovered.user }),
      ...(discovered.port === undefined ? {} : { port: discovered.port }),
    })
  }
  return {
    servers,
    workspaces: snapshot.workspaces.map(workspace => ({ ...workspace, aliasPath: manager.workspace(workspace.id).aliasPath })),
    serverCount: servers.length,
    discoveredServerCount: discovery.hosts.length,
    workspaceCount: snapshot.workspaces.length,
    configFiles,
    loadedConfigFiles: discovery.files,
    configErrors: discovery.errors,
    customConfigFile: snapshot.sshConfigFile,
    openFileMode: snapshot.openFileMode,
    openFileEditorPath: snapshot.openFileEditorPath,
  }
}

async function resolveAvailableServer(manager: RemoteSshManager, id: string): Promise<RemoteSshServer> {
  const state = await catalogState(manager)
  const server = state.servers.find(candidate => candidate.id === id)
  if (server === undefined) throw new Error('SSH host is no longer present in the active config')
  return server
}

function activeConfigFiles(manager: RemoteSshManager): string[] {
  const custom = manager.snapshot().sshConfigFile
  return custom === undefined || custom.trim() === '' ? defaultSshConfigFiles() : [resolve(custom)]
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right)
}

function registerRoute(
  ctx: Context,
  path: string,
  method: string | readonly string[],
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  maxErrorCharacters: number,
  fence: ConnectionFence,
): () => void {
  return ctx.webServer.register({
    kind: 'exact', path,
    handler: async (req, res) => {
      let rejection = fence.requestRejection(req)
      if (rejection === undefined && typeof fence.admit === 'function') {
        const admission = fence.admit(req)
        rejection = 'rejection' in admission ? admission.rejection
          : admission.peer.principal.kind === 'owner' ? undefined : 403
      }
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (!(typeof method === 'string' ? req.method === method : method.includes(req.method ?? ''))) return json(res, 405, { error: 'method not allowed' })
      try {
        await handler(req, res)
      } catch (error: unknown) {
        json(res, error instanceof RemoteSshManagementError ? error.status : 400, { error: safeMessage(error, maxErrorCharacters), ...(error instanceof AgentHostConnectionError || error instanceof SshExecutionError || error instanceof RemoteSshManagementError ? { code: error.code } : {}) })
      }
    },
  })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > 64 * 1024) throw new Error('request body exceeds 64 KiB')
    chunks.push(bytes)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('request body must be an object')
  return value as Record<string, unknown>
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${key} must be a non-empty string`)
  return value
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value
}

function parseOpenFileMode(value: unknown): RemoteOpenFileMode {
  if (value === 'auto' || value === 'vscode' || value === 'cursor' || value === 'windsurf'
    || value === 'vscodium' || value === 'custom' || value === 'download') return value
  throw new Error('openFileMode is invalid')
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

function safeMessage(error: unknown, maxErrorCharacters: number): string {
  return formatConnectionDiagnostic(error instanceof Error ? error.message : String(error), maxErrorCharacters)
}

async function probeServer(executable: string, sshTarget: string, sshArgs: string[]): Promise<{
  reachable: boolean
  hostname?: string
  commands?: Record<string, boolean>
  error?: string
}> {
  const command = 'printf "hostname=%s\\n" "$(hostname)"; for dsh_cmd in bash pwsh rg code; do if command -v "$dsh_cmd" >/dev/null 2>&1; then printf "%s=1\\n" "$dsh_cmd"; else printf "%s=0\\n" "$dsh_cmd"; fi; done'
  const child = spawn(executable, [...sshArgs, '-T', sshTarget, command], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk) })
  child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk) })
  const timer = setTimeout(() => { child.kill() }, 8_000)
  const code = await new Promise<number | null>((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('close', resolvePromise)
  }).finally(() => { clearTimeout(timer) })
  const output = Buffer.concat(stdout).toString('utf8')
  if (code !== 0) return { reachable: false, error: Buffer.concat(stderr).toString('utf8').trim().slice(0, 500) || `ssh exit ${code}` }
  const facts = Object.fromEntries(output.trim().split(/\r?\n/).map(line => line.split('=', 2) as [string, string]))
  return {
    reachable: true,
    ...(facts.hostname === undefined ? {} : { hostname: facts.hostname }),
    commands: Object.fromEntries(['bash', 'pwsh', 'rg', 'code'].map(name => [name, facts[name] === '1'])),
  }
}
