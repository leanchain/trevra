import { createHash } from 'node:crypto';
import { z } from 'zod';
import { id, type Db } from '../db.js';
import { getNango } from '../integration-service.js';

const sourceInput = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(160),
  connectionId: z.string().min(1),
  subreddits: z.array(z.string().trim().regex(/^[A-Za-z0-9_]{2,21}$/)).min(1).max(20),
  queries: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
  includeComments: z.boolean().default(true),
  maxPostsPerRun: z.number().int().min(1).max(200).default(50),
  maxCommentsPerPost: z.number().int().min(0).max(500).default(100),
  maxPagesPerRun: z.number().int().min(1).max(10).default(2),
  pollIntervalMinutes: z.number().int().min(15).max(10080).default(60),
  enabled: z.boolean().default(true)
});

export type ResearchSourceInput = z.infer<typeof sourceInput>;
export interface ResearchSource {
  id:string; provider:string; connectionId:string; name:string; subreddits:string[]; queries:string[];
  includeComments:boolean; maxPostsPerRun:number; maxCommentsPerPost:number; maxPagesPerRun:number;
  pollIntervalMinutes:number; enabled:boolean; lastSyncedAt:string|null; nextSyncAt:string; lastError:string|null;
}

const cfg=(v:unknown)=>typeof v==='string'?JSON.parse(v):v as Record<string,unknown>;
const uniq=(v:string[])=>[...new Map(v.map(x=>[x.trim().toLowerCase(),x.trim()])).values()];
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const ahash=(ws:string,v:unknown)=>typeof v==='string'&&v&&v!=='[deleted]'?hash([ws,v.toLowerCase()]).slice(0,32):null;
const text=(v:unknown)=>typeof v==='string'?v.replaceAll('\u0000','').trim():'';
const date=(v:unknown)=>typeof v==='number'&&v>0?new Date(v*1000).toISOString():null;
const obj=(v:unknown)=>typeof v==='object'&&v!==null&&!Array.isArray(v)?v as Record<string,unknown>:{};
const arr=(v:unknown)=>Array.isArray(v)?v:[];

function serialize(row:Record<string,unknown>):ResearchSource {
  const c=cfg(row.config_json) as Record<string,unknown>;
  return { id:String(row.id),provider:String(row.provider),connectionId:String(row.connection_id),name:String(row.name),
    subreddits:Array.isArray(c.subreddits)?c.subreddits.map(String):[], queries:Array.isArray(c.queries)?c.queries.map(String):[],
    includeComments:c.includeComments!==false,maxPostsPerRun:Number(c.maxPostsPerRun??50),maxCommentsPerPost:Number(c.maxCommentsPerPost??100),
    maxPagesPerRun:Number(c.maxPagesPerRun??2),pollIntervalMinutes:Number(row.poll_interval_minutes),enabled:Boolean(row.enabled),
    lastSyncedAt:row.last_synced_at?String(row.last_synced_at):null,nextSyncAt:String(row.next_sync_at),lastError:row.last_error?String(row.last_error):null };
}

export async function saveResearchSource(db:Db,workspaceId:string,raw:ResearchSourceInput):Promise<ResearchSource>{
  const input=sourceInput.parse(raw); const connection=await db.prepare("SELECT id,provider FROM connections WHERE id=? AND workspace_id=? AND status='connected'").get<{id:string;provider:string}>(input.connectionId,workspaceId);
  if(!connection||connection.provider!=='reddit') throw new Error('Connect Reddit through Nango before creating a Reddit research source');
  const config={subreddits:uniq(input.subreddits).map(x=>x.toLowerCase()),queries:uniq(input.queries),includeComments:input.includeComments,maxPostsPerRun:input.maxPostsPerRun,maxCommentsPerPost:input.maxCommentsPerPost,maxPagesPerRun:input.maxPagesPerRun};
  const now=new Date().toISOString(); const sourceId=input.id??id('rsrc');
  const row=await db.prepare(`INSERT INTO research_sources(id,workspace_id,provider,connection_id,name,config_json,enabled,poll_interval_minutes,next_sync_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?::jsonb,?,?,?::timestamptz,?,?) ON CONFLICT(workspace_id,provider,name) DO UPDATE SET connection_id=EXCLUDED.connection_id,config_json=EXCLUDED.config_json,enabled=EXCLUDED.enabled,poll_interval_minutes=EXCLUDED.poll_interval_minutes,next_sync_at=LEAST(research_sources.next_sync_at,EXCLUDED.next_sync_at),updated_at=EXCLUDED.updated_at RETURNING *`)
    .get<Record<string,unknown>>(sourceId,workspaceId,'reddit',input.connectionId,input.name,JSON.stringify(config),input.enabled,input.pollIntervalMinutes,now,now,now);
  if(!row) throw new Error('Could not save research source'); return serialize(row);
}

export async function listResearchSources(db:Db,workspaceId:string):Promise<Array<ResearchSource&{documents:number;runs:number}>>{
  // `sd.source_id=s.id` counted the corpus by PARENT ID ALONE. A join row whose
  // source_id pointed at another tenant's source -- the only way this table
  // could ever be wrong, since it has no other identity -- was counted straight
  // into this workspace's document total. 058 gave the join table a
  // workspace_id, so the count can now require the child to agree with the
  // source it hangs off. The `IS NULL` arm covers rows written before
  // `syncResearchSource` below started supplying the column and disappears with
  // the NOT NULL migration.
  const rows=await db.prepare(`SELECT s.*,(SELECT COUNT(*)::int FROM research_source_documents sd WHERE sd.source_id=s.id AND (sd.workspace_id IS NULL OR sd.workspace_id=s.workspace_id)) documents,(SELECT COUNT(*)::int FROM research_runs r WHERE r.source_id=s.id) runs FROM research_sources s WHERE workspace_id=? ORDER BY created_at DESC`).all<Record<string,unknown>>(workspaceId);
  return rows.map(r=>({...serialize(r),documents:Number(r.documents),runs:Number(r.runs)}));
}

async function connection(db:Db,workspaceId:string,id:string){const r=await db.prepare("SELECT * FROM connections WHERE id=? AND workspace_id=? AND status='connected' AND provider='reddit'").get<Record<string,unknown>>(id,workspaceId);if(!r)throw new Error('Connected Reddit account not found');return r;}

async function proxyGet<T>(c:Record<string,unknown>,endpoint:string,params:Record<string,string>):Promise<T>{
  const response=await getNango().get<T>({endpoint,providerConfigKey:String(c.provider_config_key),connectionId:String(c.external_connection_id),retries:2,params}); return response.data;
}

function upstreamStatus(error:unknown):number|null{
  if(typeof error!=='object'||error===null)return null;
  const record=error as {status?:unknown;response?:{status?:unknown};cause?:unknown};
  const direct=typeof record.status==='number'?record.status:null;
  const response=typeof record.response?.status==='number'?record.response.status:null;
  if(direct!==null||response!==null)return direct??response;
  return record.cause===error?null:upstreamStatus(record.cause);
}

async function recordRedditAuthFailure(db:Db,connectionRow:Record<string,unknown>,message:string,now:string):Promise<void>{
  await db.prepare("UPDATE connections SET status='needs_reauth',last_error=?,updated_at=? WHERE id=?")
    .run(message,now,String(connectionRow.id));
}

interface ParsedDocument { externalId:string; type:'post'|'comment'; parent:string|null; community:string; title:string; content:string|null; url:string; author:unknown; score:number; replies:number; occurredAt:string|null; removed:boolean; metadata:Record<string,unknown> }

function parsePost(v:unknown):ParsedDocument|null{const d=obj(obj(v).data),rid=text(d.id);if(!rid)return null;const body=text(d.selftext);return {externalId:rid,type:'post',parent:null,community:text(d.subreddit),title:text(d.title),content:['[deleted]','[removed]'].includes(body)?null:body,url:`https://www.reddit.com${text(d.permalink)||`/comments/${rid}`}`,author:d.author,score:Number(d.score??0),replies:Number(d.num_comments??0),occurredAt:date(d.created_utc),removed:['[deleted]','[removed]'].includes(body),metadata:{upvoteRatio:d.upvote_ratio,flair:d.link_flair_text}};}
function parseComments(v:unknown,postId:string,out:ParsedDocument[],limit:number){if(out.length>=limit)return;const w=obj(v),kind=text(w.kind),d=obj(w.data);if(kind==='t1'){const body=text(d.body),rid=text(d.id);if(rid)out.push({externalId:rid,type:'comment',parent:text(d.parent_id).replace(/^t[13]_/,'')||postId,community:'',title:'',content:['[deleted]','[removed]'].includes(body)?null:body,url:`https://www.reddit.com${text(d.permalink)}`,author:d.author,score:Number(d.score??0),replies:0,occurredAt:date(d.created_utc),removed:['[deleted]','[removed]'].includes(body),metadata:{depth:d.depth,controversiality:d.controversiality}});const replies=obj(d.replies);for(const child of arr(obj(replies.data).children))parseComments(child,postId,out,limit);}}

async function upsertDoc(db:Db,workspaceId:string,provider:string,d:ParsedDocument,now:string){const ch=hash([d.title,d.content,d.removed]);const row=await db.prepare(`WITH prior AS(SELECT id,content_hash FROM research_documents WHERE workspace_id=? AND provider=? AND external_id=?),up AS(INSERT INTO research_documents(id,workspace_id,provider,external_id,parent_external_id,document_type,community,title,content,source_url,author_hash,score,reply_count,occurred_at,removed,content_hash,metadata_json,first_seen_at,last_seen_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?,?,?) ON CONFLICT(workspace_id,provider,external_id) DO UPDATE SET parent_external_id=EXCLUDED.parent_external_id,community=EXCLUDED.community,title=EXCLUDED.title,content=EXCLUDED.content,source_url=EXCLUDED.source_url,author_hash=EXCLUDED.author_hash,score=EXCLUDED.score,reply_count=EXCLUDED.reply_count,occurred_at=COALESCE(EXCLUDED.occurred_at,research_documents.occurred_at),removed=EXCLUDED.removed,content_hash=EXCLUDED.content_hash,metadata_json=EXCLUDED.metadata_json,last_seen_at=EXCLUDED.last_seen_at,updated_at=EXCLUDED.updated_at RETURNING id) SELECT (SELECT id FROM up) id,NOT EXISTS(SELECT 1 FROM prior) inserted,EXISTS(SELECT 1 FROM prior WHERE content_hash<>?) changed`)
.get<{id:string;inserted:boolean;changed:boolean}>(workspaceId,provider,d.externalId,id('rdoc'),workspaceId,provider,d.externalId,d.parent,d.type,d.community,d.title,d.content,d.url,ahash(workspaceId,d.author),Math.trunc(d.score),Math.trunc(d.replies),d.occurredAt,d.removed,ch,JSON.stringify(d.metadata),now,now,now,ch);if(!row)throw new Error('Could not store research document');return row;}

export async function syncResearchSource(db:Db,workspaceId:string,sourceId:string,mode:'incremental'|'backfill'='incremental'){
  const srow=await db.prepare("UPDATE research_sources SET lease_until=now()+interval '15 minutes' WHERE id=? AND workspace_id=? AND enabled AND (lease_until IS NULL OR lease_until<=now()) RETURNING *").get<Record<string,unknown>>(sourceId,workspaceId);if(!srow)throw new Error('Source is disabled, missing, or already syncing');
  const source=serialize(srow),c=await connection(db,workspaceId,source.connectionId),runId=id('rrun'),started=new Date().toISOString();await db.prepare("INSERT INTO research_runs(id,workspace_id,source_id,provider,mode,status,started_at) VALUES (?,?,?,?,?,'running',?)").run(runId,workspaceId,source.id,'reddit',mode,started);
  // Every `research_source_documents` row written below is attributed to the
  // SOURCE's workspace, read off the row this call just leased under
  // `WHERE id=? AND workspace_id=?`. Not the `workspaceId` argument passed
  // through again, and not a default: the source row is the parent, and the
  // parent is the only thing entitled to say which tenant its join rows belong
  // to. (`runDueResearchSources` enters with a workspace it read out of
  // `research_sources` in the first place, so the two agree by construction --
  // taking it from `srow` just removes the need to trust that.)
  const sourceWorkspaceId=String(srow.workspace_id);
  let seen=0,inserted=0,updated=0,requests=0;const warnings:string[]=[];const checkpoint=obj(srow.checkpoint_json);try{
    const feeds=[null,...source.queries];const docs=new Map<string,{d:ParsedDocument;matches:string[]}>();
    for(const q of feeds){let after=mode==='backfill'?text(obj(checkpoint[q??'new']).after)||'': '';for(let page=0;page<source.maxPagesPerRun&&docs.size<source.maxPostsPerRun;page++){
      const endpoint=q?`/r/${source.subreddits.join('+')}/search.json`:`/r/${source.subreddits.join('+')}/new.json`;const payload=await proxyGet<Record<string,unknown>>(c,endpoint,{limit:String(Math.min(100,source.maxPostsPerRun)),raw_json:'1',...(after?{after}:{}),...(q?{q,restrict_sr:'1',sort:'new',t:'all'}:{})});requests++;const data=obj(payload.data);for(const child of arr(data.children)){const d=parsePost(child);if(!d)continue;const ex=docs.get(d.externalId);if(ex){if(q)ex.matches.push(q)}else docs.set(d.externalId,{d,matches:q?[q]:[]});if(docs.size>=source.maxPostsPerRun)break;}after=text(data.after);if(!after)break;}if(mode==='backfill')checkpoint[q??'new']={after:after||null};}
    // `workspace_id=EXCLUDED.workspace_id` on both upserts is not redundant: it
    // repairs the NULL on any join row written between 058 and this change,
    // using the source's workspace, which is what the migration's backfill
    // would have written anyway.
    for(const item of docs.values()){seen++;const row=await upsertDoc(db,workspaceId,'reddit',item.d,started);if(row.inserted)inserted++;else if(row.changed)updated++;await db.prepare(`INSERT INTO research_source_documents(workspace_id,source_id,document_id,matched_queries,discovered_at,last_seen_at) VALUES (?,?,?,?,?,?) ON CONFLICT(source_id,document_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,matched_queries=ARRAY(SELECT DISTINCT x FROM unnest(research_source_documents.matched_queries||EXCLUDED.matched_queries)x),last_seen_at=EXCLUDED.last_seen_at`).run(sourceWorkspaceId,source.id,row.id,uniq(item.matches),started,started);
      if(source.includeComments&&item.d.replies>0){const payload=await proxyGet<unknown[]>(c,`/comments/${item.d.externalId}.json`,{limit:String(source.maxCommentsPerPost),depth:'10',sort:'top',raw_json:'1'});requests++;const out:ParsedDocument[]=[],listing=obj(arr(payload)[1]);for(const child of arr(obj(listing.data).children))parseComments(child,item.d.externalId,out,source.maxCommentsPerPost);for(const d of out){if(!d)continue;seen++;const cr=await upsertDoc(db,workspaceId,'reddit',d,started);if(cr.inserted)inserted++;else if(cr.changed)updated++;await db.prepare(`INSERT INTO research_source_documents(workspace_id,source_id,document_id,matched_queries,discovered_at,last_seen_at) VALUES (?,?,?,?,?,?) ON CONFLICT(source_id,document_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,last_seen_at=EXCLUDED.last_seen_at`).run(sourceWorkspaceId,source.id,cr.id,[],started,started);}}
    }
    const finished=new Date().toISOString();await db.prepare("UPDATE research_runs SET status='completed',documents_seen=?,documents_inserted=?,documents_updated=?,request_count=?,warnings_json=?::jsonb,finished_at=? WHERE id=?").run(seen,inserted,updated,requests,JSON.stringify(warnings),finished,runId);await db.prepare("UPDATE research_sources SET checkpoint_json=?::jsonb,last_synced_at=?,next_sync_at=?::timestamptz+make_interval(mins=>poll_interval_minutes),lease_until=NULL,last_error=NULL,updated_at=? WHERE id=?").run(JSON.stringify(checkpoint),finished,finished,finished,source.id);return{runId,seen,inserted,updated,requests,warnings};
  }catch(e){const status=upstreamStatus(e);const raw=e instanceof Error?e.message:String(e);const msg=status===401?'Reddit authorization failed. Reconnect Reddit through Nango, then run this source again.':raw;const finished=new Date().toISOString();await db.prepare("UPDATE research_runs SET status='failed',documents_seen=?,documents_inserted=?,documents_updated=?,request_count=?,warnings_json=?::jsonb,error=?,finished_at=? WHERE id=?").run(seen,inserted,updated,requests,JSON.stringify(warnings),msg,finished,runId);await db.prepare("UPDATE research_sources SET lease_until=NULL,last_error=?,updated_at=? WHERE id=?").run(msg,finished,source.id);if(status===401)await recordRedditAuthFailure(db,c,msg,finished);if(status===401)throw new Error(msg);throw e;}
}

export async function runDueResearchSources(db:Db){const rows=await db.prepare("SELECT workspace_id,id FROM research_sources WHERE enabled AND next_sync_at<=now() AND (lease_until IS NULL OR lease_until<=now()) ORDER BY next_sync_at LIMIT 3").all<{workspace_id:string;id:string}>();let done=0;for(const r of rows){try{await syncResearchSource(db,r.workspace_id,r.id);done++;}catch(e){console.error('Research source sync failed',r,e)}}return done;}

// `input.sourceId` arrives from a request body, so the EXISTS below is the one
// place in this file where a caller chooses which join rows are consulted. It
// was matched on `document_id` and `source_id` only; `d.workspace_id=?` bounded
// the DOCUMENTS but nothing bounded the join row, so a `research_source_documents`
// row belonging to another tenant that happened to name a visible document was
// enough to keep that document in the result for an arbitrary `sourceId`.
// Requiring the join row's workspace to equal the document's closes that
// without adding a placeholder -- the parameter order in `params` is built by
// hand here and a new `?` would have to be pushed in exactly the right place.
export async function searchResearchCorpus(db:Db,workspaceId:string,input:{text?:string;sourceId?:string;community?:string;includeComments?:boolean;limit?:number}){const clauses=['d.workspace_id=?'],params:unknown[]=[workspaceId];if(input.sourceId){clauses.push('EXISTS(SELECT 1 FROM research_source_documents sd WHERE sd.document_id=d.id AND sd.source_id=? AND (sd.workspace_id IS NULL OR sd.workspace_id=d.workspace_id))');params.push(input.sourceId)}if(input.community){clauses.push('LOWER(d.community)=LOWER(?)');params.push(input.community)}if(input.includeComments===false)clauses.push("d.document_type='post'");if(input.text?.trim()){clauses.push("(d.title ILIKE ? OR COALESCE(d.content,'') ILIKE ?)");params.push(`%${input.text.trim()}%`,`%${input.text.trim()}%`)}params.push(Math.max(1,Math.min(200,input.limit??50)));return db.prepare(`SELECT id,provider,external_id,parent_external_id,document_type,community,title,content,source_url,score,reply_count,occurred_at,removed FROM research_documents d WHERE ${clauses.join(' AND ')} ORDER BY score DESC,occurred_at DESC NULLS LAST LIMIT ?`).all<Record<string,unknown>>(...params);}
export async function listResearchRuns(db:Db,workspaceId:string,limit=50){return db.prepare('SELECT * FROM research_runs WHERE workspace_id=? ORDER BY started_at DESC LIMIT ?').all<Record<string,unknown>>(workspaceId,Math.max(1,Math.min(200,limit)));}
