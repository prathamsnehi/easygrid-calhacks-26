import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const resources=new Map([
  ['/', ['index.html','text/html; charset=utf-8']],
  ['/index.html', ['index.html','text/html; charset=utf-8']],
  ['/parcel-fixtures.json', ['parcel-fixtures.json','application/json; charset=utf-8']],
  ['/demo-handoff-example.json', ['demo-handoff-example.json','application/json; charset=utf-8']],
]);
createServer(async (req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/favicon.ico'){res.writeHead(204).end();return;}
  const resource=resources.get(path);
  if(!resource){res.writeHead(404).end('Not found.');return;}
  try{
    const bytes=await readFile(new URL(`./dist/${resource[0]}`,import.meta.url));
    res.writeHead(200,{'content-type':resource[1],'cache-control':'no-store'});res.end(bytes);
  }catch{res.writeHead(500).end('Build the preview first.');}
}).listen(4177,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:4177'));
