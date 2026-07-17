import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { validateProject, type ValidatedProject } from './project.js';

const SKIP_DIRECTORIES = new Set(['.git', 'dist', 'node_modules']);

const DEV_BOOTSTRAP = String.raw`<script>(()=>{
  const listeners=new Set();
  const key='rcx-dev-storage';
  const read=()=>{try{return JSON.parse(localStorage.getItem(key)||'{}')}catch{return {}}};
  const write=value=>localStorage.setItem(key,JSON.stringify(value));
  const reply=(id,result,error)=>queueMicrotask(()=>{const data={jsonrpc:'2.0',id,...(error?{error:{code:-32000,message:error}}:{result})};for(const listener of listeners)listener({data})});
  const call=(method,params={})=>{
    const storage=read();
    if(method==='storage.get')return storage[params.key];
    if(method==='storage.set'){storage[params.key]=params.value;write(storage);return {ok:true}}
    if(method==='storage.delete'){delete storage[params.key];write(storage);return {ok:true}}
    if(method==='storage.list')return Object.entries(storage).map(([key,value])=>({key,value}));
    if(method==='chat.current')return {rid:'dev-room',messages:[{_id:'dev-message',msg:'RocketX development preview',u:{username:'developer',name:'Developer'}}]};
    if(method==='chat.postMessage'){console.info('[rcx-app dev] postMessage',params);return {ok:true}}
    if(method==='rooms.list')return [{rid:'dev-room',name:'Development room',type:'c',unread:0}];
    if(method==='users.read')return [{_id:'dev-user',username:'developer',name:'Developer',status:'online'}];
    throw new Error('Unsupported mock capability: '+method);
  };
  const bridge=Object.freeze({
    postMessage(message){try{
      if(message?.method==='rcx/call')reply(message.id,call(message.params?.method,message.params?.params));
      else if(message?.method==='rcx/requestUI'){console.info('[rcx-app dev] notify',message.params?.props);reply(message.id,{ok:true})}
      else reply(message?.id,undefined,'Unknown Bridge method');
    }catch(error){reply(message?.id,undefined,error instanceof Error?error.message:String(error))}},
    addEventListener(type,listener){if(type==='message')listeners.add(listener)},
    removeEventListener(type,listener){if(type==='message')listeners.delete(listener)}
  });
  Object.defineProperty(window,'__RCX_BRIDGE__',{value:bridge});
  const events=new EventSource('/__rcx_reload');
  events.onmessage=event=>{if(event.data==='reload')location.reload()};
})()</script>`;

function injectBootstrap(html: string): string {
  return /<head(?:\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${DEV_BOOTSTRAP}`)
    : `${DEV_BOOTSTRAP}${html}`;
}

function contentType(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    default: return 'application/octet-stream';
  }
}

async function projectSignature(root: string): Promise<string> {
  const values: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const info = await stat(absolute);
        values.push(`${path.relative(root, absolute)}:${info.size}:${info.mtimeMs}`);
      }
    }
  }
  await visit(root);
  return values.sort().join('|');
}

function safeFile(project: ValidatedProject, pathname: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  const relative = decoded === '/' ? path.relative(project.root, project.entryPath) : decoded.replace(/^\/+/, '');
  const candidate = path.resolve(project.root, relative);
  const boundary = path.relative(project.root, candidate);
  if (boundary.startsWith('..') || path.isAbsolute(boundary)) return null;
  return candidate;
}

export interface DevServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export async function startDevServer(directory = '.', port = 4174): Promise<DevServer> {
  const project = await validateProject(directory);
  const clients = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/__rcx_reload') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      response.write('data: ready\n\n');
      clients.add(response);
      request.on('close', () => clients.delete(response));
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end('Method not allowed');
      return;
    }
    const file = safeFile(project, url.pathname);
    if (!file) {
      response.writeHead(404).end('Not found');
      return;
    }
    try {
      const raw = await readFile(file);
      const body = file === project.entryPath ? Buffer.from(injectBootstrap(raw.toString('utf8'))) : raw;
      response.writeHead(200, { 'Content-Type': contentType(file), 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Development server did not expose a TCP port');
  let signature = await projectSignature(project.root);
  const timer = setInterval(async () => {
    try {
      const next = await projectSignature(project.root);
      if (next === signature) return;
      signature = next;
      for (const client of clients) client.write('data: reload\n\n');
    } catch {
      // A file can disappear between readdir and stat while the editor saves it.
    }
  }, 500);
  timer.unref();

  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      clearInterval(timer);
      for (const client of clients) client.end();
      clients.clear();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
