import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';

import { projectCausalDag } from '@agent-loop-snapshot/graph';
import { reconstructState } from '@agent-loop-snapshot/recorder';
import { createSnapshotPathBoundary, inspectSnapshotPath } from '@agent-loop-snapshot/schema';
import { loadTraceSnapshot, type TraceSnapshot } from '@agent-loop-snapshot/trace';

export const viewerPackageName = '@agent-loop-snapshot/viewer' as const;
export const viewerApiVersion = 'viewer-api-1.0' as const;

export interface ViewerOptions {
  /** Explicit snapshot directory. The viewer never scans outside this boundary. */
  readonly snapshotDirectory: string;
  /** `0` asks the OS for an available loopback port. */
  readonly port?: number;
  /** Bounded page size for event and graph APIs. */
  readonly maxPageSize?: number;
}

export interface LocalViewer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

interface JsonContent {
  readonly availability: 'recorded' | 'unavailable' | 'truncated';
  readonly text?: string;
}

const defaultPageSize = 100;
const hardPageSize = 500;
const maxDetailBytes = 256 * 1024;

function pageNumber(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function jsonContent(value: unknown): JsonContent {
  if (value === undefined) return { availability: 'unavailable' };
  try {
    const text = JSON.stringify(value, null, 2);
    if (text === undefined) return { availability: 'unavailable' };
    if (Buffer.byteLength(text, 'utf8') > maxDetailBytes) {
      return { availability: 'truncated' };
    }
    return { availability: 'recorded', text };
  } catch {
    return { availability: 'unavailable' };
  }
}

function eventSummary(snapshot: TraceSnapshot, offset: number, limit: number) {
  const events = snapshot.events.slice(offset, offset + limit).map((event) => ({
    eventId: event.event_id,
    sequence: event.sequence,
    timestamp: event.timestamp,
    type: event.type,
    actor: event.actor,
    parentCount: event.parent_ids.length,
  }));
  return { offset, limit, total: snapshot.events.length, events };
}

function responseJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function responseHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  response.end(html);
}

function appHtml(token: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Loop Snapshot Viewer</title><style>body{font:14px system-ui;margin:0;background:#10151d;color:#e8eef7}main{max-width:1200px;margin:auto;padding:24px}section{background:#18212d;border:1px solid #304155;border-radius:8px;padding:16px;margin:14px 0}button{background:#4b8ef7;color:white;border:0;border-radius:5px;padding:7px 10px;margin-right:8px}pre{max-height:360px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#0d131b;padding:12px;border-radius:5px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.row{padding:6px;border-bottom:1px solid #304155;cursor:pointer}.failed{border-left:3px solid #ef6b73;padding-left:7px}.muted{color:#aebdce}@media(max-width:700px){.grid{grid-template-columns:1fr}}</style><main><h1>Agent Loop Snapshot Viewer</h1><p id="summary" class="muted">Loading read-only snapshot…</p><section><h2>Task / run</h2><pre id="manifest"></pre></section><div class="grid"><section><h2>Timeline</h2><button id="all">All events</button><button id="failures">Failures</button><div id="events"></div><button id="more">Load more</button></section><section><h2>Call graph</h2><button id="loadGraph">Load graph</button><div id="graph"></div><button id="moreGraph">Load more</button></section></div><div class="grid"><section><h2>Selected input / output / event</h2><p class="muted">Displayed as inert text; unavailable and oversized content is labeled.</p><pre id="detail">Select an event.</pre></section><section><h2>State, checkpoints, and artifacts</h2><button id="loadState">Load reconstructed state</button><pre id="state">State has not been loaded.</pre><pre id="artifacts"></pre></section></div></main><script>const token=${JSON.stringify(token)};let offset=0,graphOffset=0,failures=false;const get=p=>fetch(p+(p.includes('?')?'&':'?')+'token='+encodeURIComponent(token)).then(r=>{if(!r.ok)throw Error('Viewer request failed');return r.json()});const text=(id,v)=>document.getElementById(id).textContent=typeof v==='string'?v:JSON.stringify(v,null,2);async function loadEvents(reset=false){if(reset){offset=0;document.getElementById('events').replaceChildren()}const data=await get('/api/events?offset='+offset+'&limit=100');const root=document.getElementById('events');for(const event of data.events){if(failures&&!event.type.endsWith('.failed')&&event.type!=='run.failed')continue;const row=document.createElement('div');row.className='row '+(event.type.endsWith('.failed')?'failed':'');row.textContent='#'+event.sequence+' '+event.timestamp+' '+event.type+' · '+event.actor;row.onclick=()=>get('/api/event?sequence='+event.sequence).then(data=>text('detail',data.content.text??('Content '+data.content.availability)));root.append(row)}offset+=data.limit;document.getElementById('more').hidden=offset>=data.total}async function loadGraph(reset=false){if(reset){graphOffset=0;document.getElementById('graph').replaceChildren()}const data=await get('/api/graph?offset='+graphOffset+'&limit=100');const root=document.getElementById('graph');for(const node of data.nodes){const row=document.createElement('div');row.className='row '+(node.status==='failed'?'failed':'');row.textContent=node.sequence+' '+node.label+' ['+node.status+']';root.append(row)}graphOffset+=data.limit;document.getElementById('moreGraph').hidden=graphOffset>=data.total}Promise.all([get('/api/summary'),get('/api/artifacts')]).then(([summary,artifacts])=>{text('manifest',summary.manifest);text('summary',summary.valid?'Read-only local snapshot: '+summary.eventCount+' events':'Snapshot has diagnostics; it remains viewable.');text('artifacts',artifacts)}).catch(error=>text('summary',String(error)));document.getElementById('all').onclick=()=>{failures=false;loadEvents(true)};document.getElementById('failures').onclick=()=>{failures=true;loadEvents(true)};document.getElementById('more').onclick=()=>loadEvents();document.getElementById('loadGraph').onclick=()=>loadGraph(true);document.getElementById('moreGraph').onclick=()=>loadGraph();document.getElementById('loadState').onclick=()=>get('/api/state').then(data=>text('state',data));loadEvents();</script>`;
}

function allowedRequest(request: IncomingMessage, expectedHost: string): boolean {
  const host = request.headers.host;
  if (host !== expectedHost) return false;
  const origin = request.headers.origin;
  return origin === undefined || origin === `http://${expectedHost}`;
}

/** Starts a local, read-only Viewer bound only to 127.0.0.1. */
export async function startViewer(options: ViewerOptions): Promise<LocalViewer> {
  const boundary = await createSnapshotPathBoundary(options.snapshotDirectory);
  await inspectSnapshotPath(boundary, boundary.directory, 'directory');
  const snapshot = await loadTraceSnapshot(boundary.directory);
  const token = randomUUID();
  const maxPageSize = Math.min(Math.max(1, options.maxPageSize ?? defaultPageSize), hardPageSize);
  let graph: ReturnType<typeof projectCausalDag> | undefined;
  let state: Promise<unknown> | undefined;
  const loadedGraph = () => (graph ??= projectCausalDag(snapshot));
  const loadedState = () =>
    (state ??= reconstructState(snapshot.events, { checkpoints: snapshot.checkpoints })
      .then((result) => ({
        availability: 'recorded' as const,
        sequence: result.sequence,
        state: jsonContent(result.state),
        diagnostics: result.diagnostics,
      }))
      .catch((error: unknown) => ({
        availability: 'unavailable' as const,
        message: error instanceof Error ? error.message : 'State could not be reconstructed.',
      })));
  let expectedHost = '';
  const server = createServer((request, response) => {
    if (!allowedRequest(request, expectedHost))
      return responseJson(response, 403, { error: 'loopback origin required' });
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return responseJson(response, 405, { error: 'read-only viewer' });
    const url = new URL(request.url ?? '/', `http://${expectedHost}`);
    if (url.searchParams.get('token') !== token)
      return responseJson(response, 404, { error: 'not found' });
    if (url.pathname === '/') return responseHtml(response, appHtml(token));
    const offset = pageNumber(url.searchParams.get('offset'), 0);
    const limit = Math.min(pageNumber(url.searchParams.get('limit'), maxPageSize), maxPageSize);
    if (url.pathname === '/api/summary')
      return responseJson(response, 200, {
        apiVersion: viewerApiVersion,
        valid: snapshot.valid,
        manifest: snapshot.manifest,
        eventCount: snapshot.events.length,
        diagnostics: snapshot.diagnostics,
        checkpointCount: snapshot.checkpoints.length,
        artifactCount: snapshot.artifacts.size,
      });
    if (url.pathname === '/api/events')
      return responseJson(response, 200, eventSummary(snapshot, offset, limit));
    if (url.pathname === '/api/event') {
      const sequence = pageNumber(url.searchParams.get('sequence'), -1);
      const event = snapshot.events.find((candidate) => candidate.sequence === sequence);
      return responseJson(
        response,
        event === undefined ? 404 : 200,
        event === undefined
          ? { error: 'event not found' }
          : { sequence, content: jsonContent(event.payload) },
      );
    }
    if (url.pathname === '/api/graph') {
      const graph = loadedGraph();
      const nodes = graph.nodes.slice(offset, offset + limit);
      const visible = new Set(nodes.map((node) => node.id));
      return responseJson(response, 200, {
        offset,
        limit,
        total: graph.nodes.length,
        nodes,
        edges: graph.edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to)),
      });
    }
    if (url.pathname === '/api/state') {
      void loadedState().then((value) => responseJson(response, 200, value));
      return;
    }
    if (url.pathname === '/api/artifacts')
      return responseJson(response, 200, {
        artifacts: [...snapshot.artifacts.values()],
        checkpoints: snapshot.checkpoints.map((checkpoint) => ({
          checkpoint_id: checkpoint.checkpoint_id,
          sequence: checkpoint.sequence,
          state_hash: checkpoint.state_hash,
        })),
      });
    return responseJson(response, 404, { error: 'not found' });
  });
  server.listen(options.port ?? 0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Viewer did not bind a TCP port.');
  expectedHost = `127.0.0.1:${String(address.port)}`;
  return {
    url: `http://${expectedHost}/?token=${encodeURIComponent(token)}`,
    port: address.port,
    close: async () =>
      new Promise((resolvePromise, reject) =>
        server.close((error) => (error === undefined ? resolvePromise() : reject(error))),
      ),
  };
}
