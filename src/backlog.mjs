// Les PR de fonctionnalité sont squashées vers dev ; les promotions conservent
// ce commit. L'ascendance Git prouve son inclusion, même plusieurs merges après.
export function validateBacklog(config) {
	if (config === undefined) return;
	if (!config || typeof config !== "object" || Array.isArray(config))
		throw new Error("backlog doit être un objet.");
	if (
		typeof config.enabled !== "boolean" ||
		!/^[\w-]+$/.test(config.organization ?? "") ||
		!Number.isInteger(config.projectNumber) ||
		config.projectNumber < 1 ||
		typeof config.field !== "string" ||
		!config.field
	)
		throw new Error(
			"backlog : enabled, organization, projectNumber et field sont requis.",
		);
	if (
		!Array.isArray(config.stages) ||
		!config.stages.length ||
		config.stages.some(
			(stage) =>
				!stage ||
				typeof stage.environment !== "string" ||
				!stage.environment ||
				typeof stage.status !== "string" ||
				!stage.status,
		) ||
		new Set(config.stages.map((stage) => stage.environment)).size !==
			config.stages.length ||
		new Set(config.stages.map((stage) => stage.status)).size !==
			config.stages.length
	)
		throw new Error(
			"backlog.stages : environnements et statuts distincts, dans l'ordre de promotion.",
		);
	if (
		!config.repositories ||
		typeof config.repositories !== "object" ||
		Array.isArray(config.repositories) ||
		!Object.keys(config.repositories).length ||
		Object.entries(config.repositories).some(
			([repo, branch]) =>
				!/^[\w.-]+\/[\w.-]+$/.test(repo) ||
				typeof branch !== "string" ||
				!branch,
		)
	)
		throw new Error(
			"backlog.repositories : associer chaque dépôt à sa branche de développement.",
		);
	for (const field of ["initialStatuses", "protectedStatuses"]) {
		if (
			!Array.isArray(config[field]) ||
			config[field].some((s) => typeof s !== "string" || !s)
		)
			throw new Error(`backlog.${field} doit être une liste de statuts.`);
	}
	const names = [
		...config.initialStatuses,
		...config.protectedStatuses,
		...config.stages.map((s) => s.status),
	];
	if (
		new Set(names).size !== names.length ||
		!config.protectedStatuses.includes("Closed") ||
		!config.protectedStatuses.includes("Canceled")
	)
		throw new Error(
			"backlog : statuts disjoints ; Closed et Canceled doivent être protégés.",
		);
}

const itemFields = `id isArchived
	fieldValueByName(name: $field) { ... on ProjectV2ItemFieldSingleSelectValue { name } }
	content { __typename ... on Issue { id number title url repository { nameWithOwner } subIssuesSummary { total } } }`;
const prFields = `number url state baseRefName mergedAt repository { nameWithOwner }
	mergeCommit { oid }`;

export function createBacklogClient(github) {
	async function graphql(query, variables) {
		const result = await github("/graphql", { query, variables });
		if (result.errors?.length || !result.data) {
			const error = new Error(
				`API GitHub Projects : ${result.errors?.map((e) => e.type ?? "GRAPHQL_ERROR").join(", ") ?? "réponse invalide"}. Vérifier les droits du token.`,
			);
			error.code = result.errors?.find((e) =>
				["FORBIDDEN", "INSUFFICIENT_SCOPES", "RATE_LIMITED"].includes(e.type),
			)?.type;
			throw error;
		}
		return result.data;
	}
	return {
		async project(config) {
			const { organization } = await graphql(
				`
					query ($org: String!, $number: Int!, $field: String!) {
						organization(login: $org) {
							projectV2(number: $number) {
								id
								title
								field(name: $field) {
									... on ProjectV2SingleSelectField {
										id
										options {
											id
											name
										}
									}
								}
							}
						}
					}
				`,
				{
					org: config.organization,
					number: config.projectNumber,
					field: config.field,
				},
			);
			const project = organization?.projectV2;
			if (!project?.field?.id)
				throw new Error("Projet ou champ Status inaccessible.");
			for (const status of [
				...config.initialStatuses,
				...config.protectedStatuses,
				...config.stages.map((s) => s.status),
			]) {
				if (!project.field.options.some((o) => o.name === status))
					throw new Error(`Statut absent du projet : ${status}`);
			}
			return project;
		},
		async items(projectId, field) {
			const items = [];
			let cursor = null;
			do {
				const { node } = await graphql(
					`query($id: ID!, $field: String!, $cursor: String) {
					node(id: $id) { ... on ProjectV2 { items(first: 100, after: $cursor) {
						nodes { ${itemFields} } pageInfo { hasNextPage endCursor }
					} } }
				}`,
					{ id: projectId, field, cursor },
				);
				if (!node?.items) throw new Error("Liste des tickets inaccessible.");
				items.push(...node.items.nodes);
				cursor = nextCursor(node.items);
			} while (cursor);
			return items;
		},
		async item(id, field) {
			const { node } = await graphql(
				`query($id: ID!, $field: String!) {
				node(id: $id) { ... on ProjectV2Item { ${itemFields} } }
			}`,
				{ id, field },
			);
			return node;
		},
		async subIssues(id) {
			const issues = [];
			let cursor = null;
			do {
				const { node } = await graphql(
					`query($id: ID!, $cursor: String) {
						node(id: $id) { ... on Issue {
							subIssues(first: 100, after: $cursor) {
								nodes { id url } pageInfo { hasNextPage endCursor }
							}
						} }
					}`,
					{ id, cursor },
				);
				if (!node?.subIssues) throw new Error("Sous-issues inaccessibles.");
				issues.push(...node.subIssues.nodes);
				cursor = nextCursor(node.subIssues);
			} while (cursor);
			return issues;
		},

		async pullRequests(id) {
			const prs = [];
			let cursor = null;
			do {
				const { node } = await graphql(
					`query($id: ID!, $cursor: String) {
					node(id: $id) { ... on Issue {
						closedByPullRequestsReferences(first: 100, after: $cursor, includeClosedPrs: true) {
							nodes { ${prFields} } pageInfo { hasNextPage endCursor }
						}
					} }
				}`,
					{ id, cursor },
				);
				const connection = node?.closedByPullRequestsReferences;
				if (!connection) throw new Error("Liens des PR inaccessibles.");
				prs.push(...connection.nodes);
				cursor = nextCursor(connection);
			} while (cursor);
			return prs;
		},
		async contains(repository, ancestor, head) {
			if (ancestor === head) return true;
			const result = await github(
				`/repos/${repository}/compare/${ancestor}...${head}?per_page=1`,
			);
			if (!["ahead", "identical", "behind", "diverged"].includes(result.status))
				throw new Error("Comparaison GitHub invalide.");
			return result.status === "ahead" || result.status === "identical";
		},
		async update(project, itemId, status) {
			const option = project.field.options.find((o) => o.name === status);
			const data = await graphql(
				`
					mutation ($project: ID!, $item: ID!, $field: ID!, $option: String!) {
						updateProjectV2ItemFieldValue(
							input: {
								projectId: $project
								itemId: $item
								fieldId: $field
								value: { singleSelectOptionId: $option }
							}
						) {
							projectV2Item {
								id
							}
						}
					}
				`,
				{
					project: project.id,
					item: itemId,
					field: project.field.id,
					option: option.id,
				},
			);
			if (data.updateProjectV2ItemFieldValue?.projectV2Item?.id !== itemId)
				throw new Error("Mise à jour du statut non confirmée par GitHub.");
		},
	};
}

function nextCursor(connection) {
	if (!connection.pageInfo.hasNextPage) return null;
	if (!connection.pageInfo.endCursor)
		throw new Error("Pagination GitHub incomplète.");
	return connection.pageInfo.endCursor;
}

function eligibility(item, config) {
	if (item?.content?.__typename !== "Issue") return "not_issue";
	if (item.isArchived) return "archived";
	if (
		!Object.hasOwn(config.repositories, item.content.repository.nameWithOwner)
	)
		return "untracked_repository";
	const status = item.fieldValueByName?.name ?? null;
	if (config.protectedStatuses.includes(status)) return "protected_status";
	if (
		!config.initialStatuses.includes(status) &&
		!config.stages.some((stage) => stage.status === status)
	)
		return "unknown_status";
	return null;
}

function signature(prs) {
	return JSON.stringify(
		prs
			.map((pr) => [pr.url, pr.state, pr.baseRefName, pr.mergeCommit?.oid])
			.sort(),
	);
}

// Toutes les PR actives liées sont nécessaires. Une PR fermée sans fusion est
// abandonnée ; une PR de promotion ou un dépôt inconnu rend la preuve ambiguë.
function prEligibility(prs, config) {
	if (!prs.length) return "no_linked_pr";
	if (
		prs.some(
			(pr) =>
				config.repositories[pr.repository.nameWithOwner] !== pr.baseRefName,
		)
	)
		return "unsupported_pr";
	if (
		prs.some(
			(pr) =>
				pr.state !== "MERGED" ||
				!/^[a-f0-9]{40}$/i.test(pr.mergeCommit?.oid ?? ""),
		)
	)
		return "unmerged_pr";
	return null;
}

export async function syncBacklog({
	config,
	deployments,
	client,
	dryRun,
	log = () => {},
}) {
	const project = await client.project(config);
	const items = await client.items(project.id, config.field);
	const rows = [];
	let blocked = false;
	const comparisons = new Map();
	const contains = async (repo, ancestor, head) => {
		const key = JSON.stringify([repo, ancestor, head]);
		if (!comparisons.has(key))
			comparisons.set(key, await client.contains(repo, ancestor, head));
		return comparisons.get(key);
	};
	const successful = deployments
		.filter((d) => d.status === "success")
		.sort(
			(a, b) =>
				Date.parse(b.finishedAt ?? b.createdAt) -
				Date.parse(a.finishedAt ?? a.createdAt),
		);
	for (const item of items) {
		if (item?.content?.__typename !== "Issue" || item.content.subIssuesSummary?.total > 0) continue;
		const row = {
			issue: item.content.url,
			title: item.content.title,
			from: item.fieldValueByName?.name ?? null,
			to: null,
			outcome: "skipped",
			reason: eligibility(item, config),
			evidence: [],
		};
		try {
			if (blocked) row.reason = "access_blocked";
			if (!row.reason) {
				const prs = (await client.pullRequests(item.content.id)).filter(
					(pr) => pr.state !== "CLOSED",
				);
				row.reason = prEligibility(prs, config);
				if (!row.reason) {
					const currentRank = config.stages.findIndex(
						(s) => s.status === row.from,
					);
					for (
						let rank = config.stages.length - 1;
						rank > currentRank;
						rank--
					) {
						const stage = config.stages[rank];
						const evidence = [];
						for (const repository of new Set(
							prs.map((pr) => pr.repository.nameWithOwner),
						)) {
							const required = prs.filter(
								(pr) => pr.repository.nameWithOwner === repository,
							);
							// Les PR d'un dépôt doivent coexister dans UNE version réussie.
							for (const deployment of successful.filter(
								(d) =>
									d.repository === repository &&
									d.environment === stage.environment,
							)) {
								let included = true;
								for (const pr of required) {
									if (
										!(await contains(
											repository,
											pr.mergeCommit.oid,
											deployment.sha,
										))
									) {
										included = false;
										break;
									}
								}
								if (included) {
									evidence.push({
										repository,
										environment: stage.environment,
										sha: deployment.sha,
										finishedAt: deployment.finishedAt,
										services: deployment.services,
										pullRequests: required.map((pr) => ({
											url: pr.url,
											sha: pr.mergeCommit.oid,
										})),
									});
									break;
								}
							}
						}
						if (
							evidence.length ===
							new Set(prs.map((pr) => pr.repository.nameWithOwner)).size
						) {
							row.to = stage.status;
							row.evidence = evidence;
							break;
						}
					}
					if (!row.to) row.reason = "no_higher_proven_stage";
					else if (dryRun) row.outcome = "would_update";
					else {
						// Relire juste avant l'écriture pour respecter les modifications manuelles.
						const fresh = await client.item(item.id, config.field);
						const freshPrs =
							fresh?.content?.id === item.content.id &&
							!eligibility(fresh, config)
								? (await client.pullRequests(item.content.id)).filter(
										(pr) => pr.state !== "CLOSED",
									)
								: [];
						if (
							!fresh ||
							eligibility(fresh, config) ||
							fresh.fieldValueByName?.name !== row.from ||
							fresh.content.id !== item.content.id ||
							(fresh.content.subIssuesSummary?.total ?? 0) !== 0 ||
							signature(prs) !== signature(freshPrs)
						)
							row.reason = "changed_during_sync";
						else {
							await client.update(project, item.id, row.to);
							row.outcome = "updated";
						}
					}
				}
			}
		} catch (error) {
			row.outcome = "failed";
			row.reason = error.message;
			if (
				["FORBIDDEN", "INSUFFICIENT_SCOPES", "RATE_LIMITED"].includes(
					error.code,
				) ||
				[401, 403, 429].includes(error.status)
			)
				blocked = true;
		}
		rows.push(row);
		log(`backlog_${row.outcome}`, row);
	}
	// Traiter les parents après leurs enfants, y compris les parents imbriqués.
	const byIssue = new Map(items.filter((item) => item.content?.__typename === "Issue")
		.map((item) => [item.content.id, item]));
	const rowByIssue = new Map(rows.map((row) => [row.issue, row]));
	const visiting = new Set();
	async function processParent(item) {
		const existing = rowByIssue.get(item.content.url);
		if (existing) return existing;
		const row = {
			issue: item.content.url, title: item.content.title,
			from: item.fieldValueByName?.name ?? null, to: null,
			outcome: "skipped", reason: eligibility(item, config), evidence: [],
		};
		if (visiting.has(item.content.id)) throw new Error("Cycle de sous-issues détecté.");
		visiting.add(item.content.id);
		try {
			if (blocked) row.reason = "access_blocked";
			if (!row.reason) {
				const children = await client.subIssues(item.content.id);
				if (!children.length || children.length !== item.content.subIssuesSummary.total)
					row.reason = "sub_issues_changed";
				const childItems = children.map((child) => byIssue.get(child.id));
				if (!row.reason && childItems.some((child) => !child)) row.reason = "sub_issue_not_in_project";
				if (!row.reason) {
					for (const child of childItems) {
						if (child.content.subIssuesSummary?.total > 0) await processParent(child);
					}
					const ranks = childItems.map((child) => {
						const childRow = rowByIssue.get(child.content.url);
						if (!childRow || childRow.outcome === "failed" || eligibility(child, config)) return -1;
						const status = ["updated", "would_update"].includes(childRow.outcome) ? childRow.to : childRow.from;
						return config.stages.findIndex((stage) => stage.status === status);
					});
					const rank = Math.min(...ranks);
					const currentRank = config.stages.findIndex((stage) => stage.status === row.from);
					if (rank < 0) row.reason = "sub_issue_not_deployed";
					else if (rank <= currentRank) row.reason = "no_higher_proven_stage";
					else {
						row.to = config.stages[rank].status;
						row.evidence = children.map((child, index) => ({ issue: child.url, status: config.stages[ranks[index]].status }));
						if (dryRun) row.outcome = "would_update";
						else {
							const fresh = await client.item(item.id, config.field);
							const freshChildren = await client.subIssues(item.content.id);
							const sameChildren = JSON.stringify(children.map((c) => c.id).sort()) === JSON.stringify(freshChildren.map((c) => c.id).sort());
							let childrenValid = true;
							for (const child of childItems) {
								const freshChild = await client.item(child.id, config.field);
								if (!freshChild || freshChild.content?.id !== child.content.id || eligibility(freshChild, config) || config.stages.findIndex((stage) => stage.status === freshChild.fieldValueByName?.name) < rank) childrenValid = false;
							}
							if (!fresh || eligibility(fresh, config) || fresh.content.id !== item.content.id || fresh.fieldValueByName?.name !== row.from || fresh.content.subIssuesSummary?.total !== children.length || !sameChildren || !childrenValid) row.reason = "changed_during_sync";
							else { await client.update(project, item.id, row.to); row.outcome = "updated"; }
						}
					}
				}
			}
		} catch (error) {
			row.outcome = "failed"; row.reason = error.message;
			if (["FORBIDDEN", "INSUFFICIENT_SCOPES", "RATE_LIMITED"].includes(error.code) || [401, 403, 429].includes(error.status)) blocked = true;
		} finally { visiting.delete(item.content.id); }
		rows.push(row); rowByIssue.set(item.content.url, row);
		log(`backlog_${row.outcome}`, row);
		return row;
	}
	for (const item of items) {
		if (item.content?.__typename === "Issue" && item.content.subIssuesSummary?.total > 0) await processParent(item);
	}

	const summary = { updated: 0, would_update: 0, skipped: 0, failed: 0 };
	for (const row of rows) summary[row.outcome]++;
	return {
		project: { id: project.id, title: project.title },
		dryRun,
		summary,
		rows,
	};
}
