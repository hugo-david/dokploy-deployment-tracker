import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
	createBacklogClient,
	syncBacklog,
	validateBacklog,
} from "../src/backlog.mjs";
import { groupedDeployments, sourceKey } from "../src/grouping.mjs";

const config = JSON.parse(
	await readFile(new URL("../config.example.json", import.meta.url)),
).backlog;
const repo = "drakkr-team/2i-group-studio";
const sha = (n) => n.toString(16).padStart(40, "0");
function item(number = 1, status = "In review") {
	return {
		id: `item${number}`,
		isArchived: false,
		fieldValueByName: { name: status },
		content: {
			__typename: "Issue",
			id: `issue${number}`,
			number,
			title: "Ticket",
			url: `https://github.com/${repo}/issues/${number}`,
			repository: { nameWithOwner: repo },
		},
	};
}
function pr(number = 1, fields = {}) {
	return {
		number,
		url: `https://github.com/${repo}/pull/${number}`,
		repository: { nameWithOwner: repo },
		baseRefName: "dev",
		state: "MERGED",
		mergeCommit: { oid: sha(number) },
		...fields,
	};
}
function deployment(environment, n, fields = {}) {
	return {
		repository: repo,
		environment,
		sha: sha(n),
		status: "success",
		finishedAt: "2026-10-01T12:00:00Z",
		...fields,
	};
}
function fixture({
	items = [item()],
	prs = [pr()],
	contains = async () => true,
	...overrides
} = {}) {
	const updates = [];
	const client = {
		project: async () => ({ id: "project", title: "Backlog" }),
		items: async () => items,
		pullRequests: async () => prs,
		contains,
		item: async (id) => items.find((i) => i.id === id),
		update: async (...args) => updates.push(args),
		...overrides,
	};
	return { client, updates };
}
const run = (f, deployments, dryRun = true) =>
	syncBacklog({ config, client: f.client, deployments, dryRun });

test("configuration : ordre explicite, statuts protégés et doublons", () => {
	validateBacklog(config);
	validateBacklog(undefined);
	assert.throws(() =>
		validateBacklog({
			...config,
			stages: [...config.stages, config.stages[0]],
		}),
	);
	assert.throws(() => validateBacklog({ ...config, protectedStatuses: [] }));
	assert.throws(() => validateBacklog({ ...config, ignoredRepositories: [repo] }));
	assert.throws(() => validateBacklog({ ...config, ignoredRepositories: ["invalide"] }));
});

test("squash conservé par les promotions : choisit le plus haut succès, sans écriture en simulation", async () => {
	const f = fixture({
		contains: async (_, ancestor, head) =>
			ancestor === sha(1) && [sha(10), sha(20)].includes(head),
	});
	const result = await run(f, [
		deployment("staging", 10),
		deployment("test", 20),
		deployment("preprod", 30, { status: "failure" }),
	]);
	assert.equal(result.rows[0].to, "In TEST");
	assert.equal(result.rows[0].outcome, "would_update");
	assert.equal(result.rows[0].evidence[0].pullRequests[0].sha, sha(1));
	assert.equal(result.rows[0].evidence[0].sha, sha(20));
	assert.equal(f.updates.length, 0);
});

test("un merge de promotion ne prouve pas la présence d'un squash absent", async () => {
	const result = await run(fixture({ contains: async () => false }), [
		deployment("preprod", 30),
	]);
	assert.equal(result.rows[0].to, null);
});

test("une PR empilée suit les déploiements qui contiennent son commit", async () => {
	const stacked = pr(1, { baseRefName: "feat/parent", stack: { baseRefName: "dev" } });
	const f = fixture({
		prs: [stacked],
		contains: async (_, ancestor, head) =>
			ancestor === sha(1) && [sha(10), sha(20), sha(30)].includes(head),
	});
	for (const [environment, n, status] of [
		["staging", 10, "In STAGING"],
		["test", 20, "In TEST"],
		["preprod", 30, "In PREPROD"],
	]) {
		assert.equal((await run(f, [deployment(environment, n)])).rows[0].to, status);
	}
	const absent = fixture({ prs: [stacked], contains: async () => false });
	assert.equal((await run(absent, [deployment("test", 20)])).rows[0].reason, "no_higher_proven_stage");
});

test("une pile qui ne cible pas la branche configurée ne permet pas de déplacer le ticket", async () => {
	const stacked = pr(1, { baseRefName: "feat/parent", stack: { baseRefName: "test" } });
	assert.equal(
		(await run(fixture({ prs: [stacked] }), [deployment("test", 20)])).rows[0].reason,
		"unsupported_pr",
	);
});

test("un changement de branche cible de pile pendant la synchronisation bloque l'écriture", async () => {
	let calls = 0;
	const f = fixture({
		pullRequests: async () => [
			pr(1, { baseRefName: "feat/parent", stack: { baseRefName: ++calls === 1 ? "dev" : "test" } }),
		],
	});
	const result = await run(f, [deployment("test", 20)], false);
	assert.equal(result.rows[0].reason, "changed_during_sync");
	assert.equal(f.updates.length, 0);
});

test("un succès API seul ne déplace aucun ticket", async () => {
	const targets = ["api", "web"].map((service) => ({
		repository: repo,
		environment: "test",
		service,
		id: service,
		type: "application",
	}));
	const sources = {
		[sourceKey(targets[0], "https://dokploy")]: {
			[sha(1)]: {
				id: "api1",
				sha: sha(1),
				status: "success",
				createdAt: "2026-10-01T12:00:00Z",
			},
		},
	};
	const grouped = groupedDeployments(targets, sources, "https://dokploy").map(
		(d) => ({ ...d, repository: repo, environment: "test" }),
	);
	assert.equal((await run(fixture(), grouped)).summary.would_update, 0);
});

test("toutes les PR doivent coexister dans une même version", async () => {
	const f = fixture({
		prs: [pr(1), pr(2)],
		contains: async (_, ancestor, head) =>
			(head === sha(10) && ancestor === sha(1)) ||
			(head === sha(20) && ancestor === sha(2)),
	});
	assert.equal(
		(await run(f, [deployment("test", 10), deployment("test", 20)])).rows[0].to,
		null,
	);
});

test("PR ouverte, liens absents ou promotion liée : laisse le ticket en place", async () => {
	for (const [prs, reason] of [
		[[], "no_linked_pr"],
		[[pr(1, { state: "OPEN" })], "unmerged_pr"],
		[[pr(1, { state: "OPEN", baseRefName: "feat/parent", stack: { baseRefName: "dev" } })], "unmerged_pr"],
		[[pr(1, { baseRefName: "test" })], "unsupported_pr"],
	]) {
		const result = await run(fixture({ prs }), [deployment("test", 10)]);
		assert.equal(result.rows[0].reason, reason);
	}
});

test("une PR abandonnée ne bloque pas la PR de remplacement fusionnée", async () => {
	const result = await run(
		fixture({ prs: [pr(), pr(2, { state: "CLOSED", mergeCommit: null })] }),
		[deployment("test", 10)],
	);
	assert.equal(result.rows[0].to, "In TEST");
});

test("une PR liée inaccessible bloque le ticket sans masquer les autres", async () => {
	const f = fixture({
		items: [item(1), item(2)],
		pullRequests: async (id) => id === "issue1" ? [pr(), null] : [pr(2)],
	});
	const result = await run(f, [deployment("test", 10)], false);
	assert.equal(result.rows[0].reason, "inaccessible_pr");
	assert.equal(result.rows[0].outcome, "skipped");
	assert.equal(result.rows[1].outcome, "updated");
	assert.equal(f.updates.length, 1);
});

test("un dépôt explicitement ignoré ne nécessite pas de preuve de déploiement", async () => {
	const odoo = pr(2, { repository: { nameWithOwner: "drakkr-team/2i-group-odoo" } });
	const f = fixture({ prs: [pr(), odoo] });
	const result = await syncBacklog({
		config: { ...config, ignoredRepositories: ["drakkr-team/2i-group-odoo"] },
		client: f.client, deployments: [deployment("test", 10)], dryRun: true,
	});
	assert.equal(result.rows[0].to, "In TEST");
	assert.equal(result.rows[0].evidence[0].pullRequests.length, 1);
});

test("ignorer un dépôt ne suffit pas sans PR suivie ni avec une PR inaccessible", async () => {
	const odoo = pr(2, { repository: { nameWithOwner: "drakkr-team/2i-group-odoo" } });
	for (const [prs, reason] of [[[odoo], "no_linked_pr"], [[pr(), null, odoo], "inaccessible_pr"]]) {
		const result = await syncBacklog({
			config: { ...config, ignoredRepositories: ["drakkr-team/2i-group-odoo"] },
			client: fixture({ prs }).client, deployments: [deployment("test", 10)], dryRun: true,
		});
		assert.equal(result.rows[0].reason, reason);
	}
});

test("une PR devenue inaccessible avant écriture bloque le déplacement", async () => {
	let calls = 0;
	const f = fixture({ pullRequests: async () => ++calls === 1 ? [pr()] : [pr(), null] });
	const result = await run(f, [deployment("test", 10)], false);
	assert.equal(result.rows[0].reason, "changed_during_sync");
	assert.equal(f.updates.length, 0);
});

test("ne rétrograde pas, protège Closed, Canceled, les archives et les statuts inconnus", async () => {
	for (const status of [
		"In PREPROD",
		"In PROD",
		"Closed",
		"Canceled",
		"Custom",
		null,
	]) {
		const f = fixture({ items: [item(1, status)] });
		assert.equal(
			(await run(f, [deployment("test", 10)], false)).summary.updated,
			0,
		);
		assert.equal(f.updates.length, 0);
	}
	const archived = { ...item(), isArchived: true };
	assert.equal(
		(await run(fixture({ items: [archived] }), [deployment("test", 10)]))
			.rows[0].reason,
		"archived",
	);
});

test("une issue GitHub fermée reste livrable si le statut du projet est actif", async () => {
	const issue = item();
	issue.content.state = "CLOSED";
	assert.equal(
		(await run(fixture({ items: [issue] }), [deployment("test", 10)])).rows[0]
			.to,
		"In TEST",
	);
});

test("relit statut et liens avant écriture, puis ne répète pas une mise à jour déjà appliquée", async () => {
	const original = item();
	const f = fixture({
		items: [original],
		update: async (_, id, status) => {
			assert.equal(id, original.id);
			original.fieldValueByName.name = status;
		},
	});
	assert.equal(
		(await run(f, [deployment("test", 10)], false)).summary.updated,
		1,
	);
	assert.equal(
		(await run(f, [deployment("test", 10)], false)).summary.updated,
		0,
	);
	const changed = fixture({ item: async () => item(1, "Canceled") });
	assert.equal(
		(await run(changed, [deployment("test", 10)], false)).rows[0].reason,
		"changed_during_sync",
	);
	assert.equal(changed.updates.length, 0);
	let calls = 0;
	const relinked = fixture({
		pullRequests: async () =>
			++calls === 1 ? [pr()] : [pr(), pr(2, { state: "OPEN" })],
	});
	assert.equal(
		(await run(relinked, [deployment("test", 10)], false)).rows[0].reason,
		"changed_during_sync",
	);
	assert.equal(relinked.updates.length, 0);
});

test("erreur Projects réessayable sans rejouer un déploiement", async () => {
	let failures = 1;
	const f = fixture({
		update: async () => {
			if (failures--) throw new Error("HTTP 503");
		},
	});
	assert.equal(
		(await run(f, [deployment("test", 10)], false)).summary.failed,
		1,
	);
	assert.equal(
		(await run(f, [deployment("test", 10)], false)).summary.updated,
		1,
	);
});

test("cache partagé entre tickets d'une même PR", async () => {
	let calls = 0;
	const f = fixture({
		items: [item(1), item(2)],
		contains: async () => {
			calls++;
			return true;
		},
	});
	assert.equal(
		(await run(f, [deployment("test", 10)])).summary.would_update,
		2,
	);
	assert.equal(calls, 1);
});

test("arrête les écritures après un refus de permission pour éviter les appels inutiles", async () => {
	let calls = 0;
	const f = fixture({
		items: [item(1), item(2)],
		update: async () => {
			calls++;
			const error = new Error("INSUFFICIENT_SCOPES");
			error.code = "INSUFFICIENT_SCOPES";
			throw error;
		},
	});
	const result = await run(f, [deployment("test", 10)], false);
	assert.equal(result.summary.failed, 1);
	assert.equal(result.rows[1].reason, "access_blocked");
	assert.equal(calls, 1);
});

test("comparaison GitHub : seuls ahead et identical prouvent l'inclusion", async () => {
	for (const status of ["ahead", "identical", "behind", "diverged"]) {
		const client = createBacklogClient(async (path) => {
			assert.match(path, /compare\/.*\.\.\./);
			return { status };
		});
		assert.equal(
			await client.contains(repo, sha(1), sha(2)),
			["ahead", "identical"].includes(status),
		);
	}
});

test("pagination complète des tickets et PR, erreurs GraphQL même HTTP 200", async () => {
	let calls = 0;
	const client = createBacklogClient(async (_, { query, variables }) => {
		if (query.includes("closedByPullRequestsReferences")) {
			assert.match(query, /stack\s*\{\s*baseRefName\s*\}/);
		}
		calls++;
		const page = {
			nodes: [variables.cursor ? { id: "second" } : { id: "first" }],
			pageInfo: {
				hasNextPage: !variables.cursor,
				endCursor: variables.cursor ? null : "next",
			},
		};
		return {
			data: { node: { items: page, closedByPullRequestsReferences: page } },
		};
	});
	assert.equal((await client.items("project", "Status")).length, 2);
	assert.equal((await client.pullRequests("issue")).length, 2);
	assert.equal(calls, 4);
	const denied = createBacklogClient(async () => ({
		data: { organization: null },
		errors: [{ type: "FORBIDDEN" }],
	}));
	await assert.rejects(denied.project(config), /FORBIDDEN/);
});

test("un parent suit le déploiement commun le moins avancé de ses sous-issues", async () => {
	const parent = item(1);
	parent.content.subIssuesSummary = { total: 2 };
	const children = [item(2, "In TEST"), item(3, "In STAGING")];
	const f = fixture({
		items: [parent, ...children], prs: [],
		subIssues: async () => children.map((child) => child.content),
		update: async (_, id, status) => { f.updates.push([id, status]); },
	});
	const result = await run(f, [], false);
	assert.equal(result.rows.find((row) => row.issue === parent.content.url).to, "In STAGING");
	assert.deepEqual(f.updates, [[parent.id, "In STAGING"]]);
});

test("un parent attend chaque sous-issue et respecte les statuts protégés", async () => {
	const parent = item(1);
	parent.content.subIssuesSummary = { total: 2 };
	const child = item(2, "In TEST");
	const f = fixture({ items: [parent, child], prs: [], subIssues: async () => [child.content, { id: "missing" }] });
	assert.equal((await run(f, [])).rows.find((row) => row.issue === parent.content.url).reason, "sub_issue_not_in_project");
	const other = item(3, "Canceled");
	f.client.items = async () => [parent, child, other];
	f.client.subIssues = async () => [child.content, other.content];
	assert.equal((await run(f, [])).rows.find((row) => row.issue === parent.content.url).reason, "sub_issue_not_deployed");
});

test("les parents imbriqués avancent en simulation et un changement concurrent bloque l'écriture", async () => {
	const parent = item(1), middle = item(2), child = item(3, "In TEST");
	parent.content.subIssuesSummary = { total: 1 };
	middle.content.subIssuesSummary = { total: 1 };
	const f = fixture({ items: [parent, middle, child], prs: [], subIssues: async (id) => [id === parent.content.id ? middle.content : child.content] });
	const result = await run(f, []);
	assert.equal(result.rows.find((row) => row.issue === parent.content.url).to, "In TEST");
	assert.equal(result.summary.would_update, 2);
	const g = fixture({ items: [middle, child], prs: [], subIssues: async () => [child.content], item: async (id) => id === child.id ? item(3, "In progress") : middle });
	assert.equal((await run(g, [], false)).rows.find((row) => row.issue === middle.content.url).reason, "changed_during_sync");
	assert.equal(g.updates.length, 0);
});
