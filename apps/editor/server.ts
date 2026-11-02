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

const TYPES: Record<string, string> = { '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json' };

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
  /** Recent saves per project, so our own writes do not come back as "changed outside". */
  const savedAt = new Map<string, number>();
  return {
    name: 'llm2d-editor-api',
    configureServer(server) {
      for (const r of roots()) if (existsSync(r)) server.watcher.add(r);
      const notify = async (file: string) => {
        if (!/(\.l2d\.json|animations\.json)$/.test(file)) return;
        const dir = dirname(file);
        const id = relative(repo, dir).split(sep).join('/');
        if (Date.now() - (savedAt.get(id) ?? 0) < 2000) return;
        server.ws.send({ type: 'custom', event: 'llm2d:changed', data: { id, file: relative(dir, file) } });
      };
      server.watcher.on('change', notify);
      server.watcher.on('add', notify);

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://local');
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
            const { animations } = (await body(req)) as { animations: Record<string, unknown> };
            if (!animations || typeof animations !== 'object') throw new HttpError(400, 'animations is required');
            savedAt.set(info.id, Date.now());
            const result = await new Project(dir).writeAnimations(animations as never);
            savedAt.set(info.id, Date.now());
            return send(res, result.ok ? 200 : 422, { ok: result.ok, errors: result.errors, warnings: result.warnings });
          }

          if (url.pathname.startsWith('/files/')) {
            // /files/<encoded project id>/<path>: the id is one segment so "../" in it survives.
            const [encodedId, ...parts] = url.pathname.slice('/files/'.length).split('/');
            const { dir } = await projectDir(decodeURIComponent(encodedId));
            const path = resolve(dir, decodeURIComponent(parts.join('/')));
            if (!path.startsWith(dir + sep)) throw new HttpError(403, 'Outside the project');
            const data = await readFile(path).catch(() => null);
            if (!data) throw new HttpError(404, 'Not found');
            res.setHeader('content-type', TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream');
            res.setHeader('cache-control', 'no-store');
            return res.end(data);
          }
        } catch (e) {
          const status = e instanceof HttpError ? e.status : 500;
          return send(res, status, { ok: false, error: (e as Error).message });
        }
        next();
      });
    },
  };
}
