/**
 * Dev-server API for the editor (a Vite plugin, so the editor runs with `vite`):
 *
 *   GET  /api/projects                 folders with a skeleton under the project roots
 *   GET  /api/project?id=<id>          the skeleton JSON (animations from animations.json if any)
 *   PUT  /api/project/animations?id=   { animations } -> validated, written to animations.json and
 *                                      patched into <name>.l2d.json (the MCP Project does both)
 *   GET  /files/<encoded id>/<path>    files of a project (images)
 *
 * Project roots: samples/, out/projects/ and the folders in LLM2D_EDITOR_DIRS (path-separated).
 * A project id is its path relative to the repository. When a skeleton or animations.json
 * changes on disk (e.g. Claude edited it through MCP), clients get an `llm2d:changed` event.
 *
 * The API reads and writes project files, so it answers only requests addressed to this machine
 * (Host is localhost, an IP address or one of server.allowedHosts: no DNS rebinding) and writes
 * only for pages of the editor itself (Origin, when sent, must be the editor's).
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { delimiter, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { Project } from '@llm2d/mcp';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface ProjectInfo {
  id: string;
  name: string;
  /** Skeleton file name inside the project folder. */
  skeleton: string;
  /** Saving writes animations.json; false when animations come from code (animations.ts, build.ts). */
  editable: boolean;
  note?: string;
}

function roots(): string[] {
  const extra = (process.env.LLM2D_EDITOR_DIRS ?? '').split(delimiter).filter(Boolean).map((d) => resolve(d));
  return [join(repo, 'samples'), join(repo, 'out/projects'), ...extra];
}

async function describe(dir: string): Promise<ProjectInfo | null> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const skeletons = files.filter((f) => f.endsWith('.l2d.json'));
  if (skeletons.length !== 1) return null;
  const id = relative(repo, dir).split(sep).join('/');
  const code = ['animations.ts', 'build.ts'].find((f) => files.includes(f));
  return {
    id,
    name: id.replace(/^samples\//, '').replace(/^out\/projects\//, ''),
    skeleton: skeletons[0],
    editable: !code,
    note: code ? `애니메이션이 ${code} 코드로 만들어지는 샘플입니다. 저장 대신 JSON 내보내기를 쓰세요.` : undefined,
  };
}

export async function listProjects(): Promise<ProjectInfo[]> {
  const out: ProjectInfo[] = [];
  const seen = new Set<string>();
  for (const root of roots()) {
    // A root may itself be a project, or hold projects one level down.
    const candidates = [root, ...(await readdir(root, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => join(root, d.name))];
    for (const dir of candidates) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      const info = await describe(dir);
      if (info) out.push(info);
    }
  }
  return out;
}

/** The folder of a project id, only if it is one of the listed projects. */
async function projectDir(id: string | null): Promise<{ dir: string; info: ProjectInfo }> {
  if (!id) throw new HttpError(400, 'id is required');
  const info = (await listProjects()).find((p) => p.id === id);
  if (!info) throw new HttpError(404, `No project "${id}"`);
  return { dir: resolve(repo, id), info };
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Files the editor fetches from a project (images and skeletons); nothing else is served. */
const TYPES: Record<string, string> = { '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json' };

/** Host header names this server answers to: localhost, IP literals, or allowed names. */
export function hostAllowed(host: string | undefined, allowed: true | string[] = []): boolean {
  if (allowed === true) return true;
  if (!host) return false;
  const name = host.toLowerCase().replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.includes(':')) return true; // IP literal
  return allowed.some((a) => (a.startsWith('.') ? name === a.slice(1) || name.endsWith(a) : name === a.toLowerCase()));
}

/** Same origin as the page: the Origin header (if any) names the host the request went to. */
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function editorServer(): Plugin {
  /** What our own saves wrote, per file: a change event with the same content is not news. */
  const written = new Map<string, string>();
  /** Pending change notices per project (one MCP save touches two files). */
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<string, Set<string>>();
  return {
    name: 'llm2d-editor-api',
    configureServer(server) {
      // Roots that do not exist yet (out/projects on a fresh clone) are watched too, so projects
      // created after the start still report changes.
      for (const r of roots()) server.watcher.add(r);
      const notify = (file: string) => {
        if (!/(\.l2d\.json|animations\.json)$/.test(file)) return;
        const dir = dirname(file);
        const id = relative(repo, dir).split(sep).join('/');
        (pending.get(id) ?? pending.set(id, new Set()).get(id)!).add(file);
        clearTimeout(timers.get(id));
        // Settle first (both files of a save), then tell clients unless it is what we wrote.
        timers.set(
          id,
          setTimeout(async () => {
            timers.delete(id);
            const files = [...(pending.get(id) ?? [])];
            pending.delete(id);
            const changed: string[] = [];
            for (const f of files) if ((await readFile(f, 'utf8').catch(() => null)) !== written.get(f)) changed.push(f);
            if (changed.length) server.ws.send({ type: 'custom', event: 'llm2d:changed', data: { id, file: relative(dir, changed[0]) } });
          }, 150),
        );
      };
      server.watcher.on('change', notify);
      server.watcher.on('add', notify);

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://local');
        const api = url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/');
        if (!api) return next();
        // Vite's host check runs after plugin middlewares, so the API checks for itself.
        if (!hostAllowed(req.headers.host, server.config.server.allowedHosts))
          return send(res, 403, { ok: false, error: `Host "${req.headers.host}" is not allowed (add it to server.allowedHosts).` });
        if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req.headers.origin, req.headers.host))
          return send(res, 403, { ok: false, error: 'Writes are accepted only from the editor page.' });
        try {
          if (url.pathname === '/api/projects' && req.method === 'GET') return send(res, 200, await listProjects());

          if (url.pathname === '/api/project' && req.method === 'GET') {
            const { dir, info } = await projectDir(url.searchParams.get('id'));
            const project = new Project(dir);
            const file = JSON.parse(await readFile(join(dir, info.skeleton), 'utf8'));
            if (existsSync(project.animationsPath)) file.animations = await project.readAnimations();
            const mtime = (await stat(join(dir, info.skeleton))).mtimeMs;
            return send(res, 200, { info, file, mtime });
          }

          if (url.pathname === '/api/project/animations' && req.method === 'PUT') {
            const { dir, info } = await projectDir(url.searchParams.get('id'));
            if (!info.editable) throw new HttpError(403, info.note ?? 'This project cannot be saved.');
            const { animations } = (await body(req).catch(() => ({}))) as { animations?: Record<string, unknown> };
            if (!animations || typeof animations !== 'object') throw new HttpError(400, 'animations is required');
            const project = new Project(dir);
            const result = await project.writeAnimations(animations as never);
            // Remember what we wrote, so the watcher does not report our own save as outside.
            for (const f of [project.animationsPath, join(dir, info.skeleton)]) {
              const text = await readFile(f, 'utf8').catch(() => null);
              if (text !== null) written.set(f, text);
            }
            return send(res, result.ok ? 200 : 422, { ok: result.ok, errors: result.errors, warnings: result.warnings });
          }

          if (url.pathname.startsWith('/files/')) {
            // /files/<encoded project id>/<path>: the id is one segment so "../" in it survives.
            const [encodedId, ...parts] = url.pathname.slice('/files/'.length).split('/');
            const decode = (v: string) => {
              try {
                return decodeURIComponent(v);
              } catch {
                throw new HttpError(400, 'Bad URL encoding');
              }
            };
            const { dir } = await projectDir(decode(encodedId));
            const path = resolve(dir, decode(parts.join('/')));
            if (!path.startsWith(dir + sep)) throw new HttpError(403, 'Outside the project');
            if (!TYPES[extname(path).toLowerCase()]) throw new HttpError(403, 'Only images and JSON files are served');
            const data = await readFile(path).catch(() => null);
            if (!data) throw new HttpError(404, 'Not found');
            res.setHeader('content-type', TYPES[extname(path).toLowerCase()]);
            res.setHeader('cache-control', 'no-store');
            return res.end(data);
          }
        } catch (e) {
          const status = e instanceof HttpError ? e.status : 500;
          return send(res, status, { ok: false, error: (e as Error).message });
        }
        return send(res, 404, { ok: false, error: 'No such API route' });
      });
    },
  };
}
