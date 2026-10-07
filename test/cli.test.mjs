import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/index.mjs", import.meta.url));
const config = JSON.parse(
	await readFile(new URL("../config.example.json", import.meta.url)),
);
config.backlog.enabled = true;
config.targets = ["api", "web"].map((service) => ({
	type: "application",
	id: service,
	service,
	repository: "drakkr-team/2i-group-studio",
	environment: "test",
}));

// Le CLI complet tourne dans un processus séparé. Aucun accès réseau réel ;
// toute écriture inattendue (Deployments ou Dokploy) fait échouer le test.
const mock = `
import {appendFileSync} from 'node:fs';
const sha='a'.repeat(40);
const issue={id:'item',isArchived:false,fieldValueByName:{name:'In review'},content:{__typename:'Issue',id:'issue',number:1,title:'Ticket',url:'https://github.com/drakkr-team/2i-group-studio/issues/1',repository:{nameWithOwner:'drakkr-team/2i-group-studio'}}};
globalThis.fetch=async(input,options={})=>{
 const url=new URL(input);
 const body=options.body?JSON.parse(options.body):null;
 let data;
 if(url.hostname==='dokploy.test') {
  if(process.env.HISTORY_ERROR && url.searchParams.get('applicationId')==='web') return new Response('',{status:503});
  data=[{deploymentId:url.searchParams.get('applicationId'),commitSha:sha,status:'done',createdAt:process.env.DEPLOYED_AT||'2020-01-01T00:00:00Z',finishedAt:process.env.DEPLOYED_AT||'2020-01-01T00:00:00Z'}];
 } else if(url.pathname==='/graphql') {
  const q=body.query;
  if(q.includes('mutation')) {
   appendFileSync(process.env.CALLS_FILE,'update\\n');
   if(process.env.PROJECT_ERROR) return Response.json({errors:[{type:'FORBIDDEN'}]});
   data={data:{updateProjectV2ItemFieldValue:{projectV2Item:{id:'item'}}}};
  } else if(q.includes('organization(login:')) {
   data={data:{organization:{projectV2:{id:'project',title:'Backlog',field:{id:'status',options:${JSON.stringify([...config.backlog.initialStatuses, ...config.backlog.protectedStatuses, ...config.backlog.stages.map((s) => s.status)].map((name, index) => ({ id: String(index), name })))}}}}}};
  } else if(q.includes('items(first:')) data={data:{node:{items:{nodes:[issue],pageInfo:{hasNextPage:false}}}}};
  else if(q.includes('closedByPullRequestsReferences')) data={data:{node:{closedByPullRequestsReferences:{nodes:[{number:1,url:'pr',state:'MERGED',baseRefName:'dev',mergeCommit:{oid:sha},repository:{nameWithOwner:'drakkr-team/2i-group-studio'}}],pageInfo:{hasNextPage:false}}}}};
  else data={data:{node:issue}};
 } else if(url.pathname.endsWith('/deployments') && !body) data=[];
 else if(url.pathname.endsWith('/deployments') && body && process.env.ALLOW_DEPLOYMENTS) {appendFileSync(process.env.CALLS_FILE,'deployment\\n');data={id:42};}
 else if(url.pathname.endsWith('/statuses') && process.env.ALLOW_DEPLOYMENTS) data=body?{id:43}:[];
 else throw new Error('Unexpected request: '+url.pathname);
 return Response.json(data);
};`;

async function sandbox(t) {
	const dir = await mkdtemp(join(tmpdir(), "tracker-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "config.json"), JSON.stringify(config));
	await writeFile(join(dir, "mock.mjs"), mock);
	await writeFile(join(dir, "calls"), "");
	const statePath = join(dir, "state.json");
	const initial = JSON.stringify({ version: 2, groups: {}, sources: {} });
	await writeFile(statePath, initial);
	return {
		dir,
		statePath,
		initial,
		run(args, env = {}) {
			return spawnSync(
				process.execPath,
				["--import", join(dir, "mock.mjs"), entry, ...args],
				{
					cwd: dir,
					encoding: "utf8",
					timeout: 15_000,
					env: {
						...process.env,
						CONFIG_FILE: join(dir, "config.json"),
						STATE_FILE: statePath,
						DOKPLOY_URL: "https://dokploy.test",
						DOKPLOY_API_KEY: "fake",
						GITHUB_TOKEN: "fake",
						GITHUB_PROJECT_TOKEN: "fake",
						DRY_RUN: "false",
						CALLS_FILE: join(dir, "calls"),
						...env,
					},
				},
			);
		},
	};
}

test("backfill simule par défaut : rapport complet, aucune mutation ni changement d'état", async (t) => {
	const s = await sandbox(t);
	const result = s.run(["backfill", "--report", "report.json"]);
	assert.equal(result.status, 0, result.stderr + result.stdout);
	const report = JSON.parse(await readFile(join(s.dir, "report.json")));
	assert.equal(report.summary.would_update, 1);
	assert.equal(report.rows[0].to, "In TEST");
	assert.equal(await readFile(s.statePath, "utf8"), s.initial);
	assert.equal(await readFile(join(s.dir, "calls"), "utf8"), "");
});

test("backfill --apply ne modifie que Projects ; DRY_RUN reste prioritaire", async (t) => {
	const s = await sandbox(t);
	assert.equal(s.run(["backfill", "--apply"], { DRY_RUN: "true" }).status, 1);
	const result = s.run(["backfill", "--apply"]);
	assert.equal(result.status, 0, result.stderr + result.stdout);
	assert.equal(await readFile(join(s.dir, "calls"), "utf8"), "update\n");
	assert.equal(await readFile(s.statePath, "utf8"), s.initial);
});

test("historique incomplet : aucune mutation du backlog et code d'échec", async (t) => {
	const s = await sandbox(t);
	const result = s.run(["backfill", "--apply"], { HISTORY_ERROR: "1" });
	assert.equal(result.status, 1);
	assert.match(result.stdout, /backlog_failed/);
	assert.equal(await readFile(join(s.dir, "calls"), "utf8"), "");
});

test("le filtre since limite les preuves du rattrapage", async (t) => {
	const s = await sandbox(t);
	const result = s.run([
		"backfill",
		"--since",
		"2021-01-01",
		"--report",
		"report.json",
	]);
	assert.equal(result.status, 0, result.stderr + result.stdout);
	assert.equal(
		JSON.parse(await readFile(join(s.dir, "report.json"))).summary.would_update,
		0,
	);
});

test("le suivi courant ignore l'historique initial puis réessaie Projects même si le déploiement est inchangé", async (t) => {
	const s = await sandbox(t);
	const first = s.run(["sync"], { ALLOW_DEPLOYMENTS: "1" });
	assert.equal(first.status, 0, first.stderr + first.stdout);
	let state = JSON.parse(await readFile(s.statePath));
	assert.equal(Object.keys(state.backlogs).length, 1);
	assert.equal(await readFile(join(s.dir, "calls"), "utf8"), "deployment\n");
	const future = new Date(Date.now() + 60_000).toISOString();
	const failed = s.run(["sync"], {
		ALLOW_DEPLOYMENTS: "1",
		DEPLOYED_AT: future,
		PROJECT_ERROR: "1",
	});
	assert.equal(failed.status, 1);
	state = JSON.parse(await readFile(s.statePath));
	assert.equal(Object.values(state.groups)[0].complete, true);
	const retry = s.run(["sync"], {
		ALLOW_DEPLOYMENTS: "1",
		DEPLOYED_AT: future,
	});
	assert.equal(retry.status, 0, retry.stderr + retry.stdout);
	assert.match(retry.stdout, /"unchanged":1/);
	assert.match(retry.stdout, /"event":"backlog_updated"/);
	assert.equal(
		await readFile(join(s.dir, "calls"), "utf8"),
		"deployment\nupdate\nupdate\n",
	);
});
