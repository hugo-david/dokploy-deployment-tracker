import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHttpServer } from "./server.mjs";
import { groupedDeployments, latestAttempts, sourceKey } from "./grouping.mjs";

const args = process.argv.slice(2);
const command = args.shift() ?? "serve";
if (!["serve", "sync"].includes(command) || args.includes("--help")) {
	console.log(
		"pnpm start | pnpm sync [--dry-run] [--since YYYY-MM-DD] [--target ID --deployment ID]",
	);
	process.exit(args.includes("--help") ? 0 : 1);
}
const options = new Map();
for (let index = 0; index < args.length; index++) {
	const option = args[index];
	if (options.has(option)) throw new Error(`Option répétée : ${option}`);
	if (option === "--dry-run") {
		options.set(option, true);
		continue;
	}
	if (!["--since", "--target", "--deployment"].includes(option))
		throw new Error(`Option inconnue : ${option}`);
	const value = args[++index];
	if (!value || value.startsWith("--"))
		throw new Error(`Valeur manquante : ${option}`);
	options.set(option, value);
}
const since = options.has("--since")
	? Date.parse(options.get("--since"))
	: undefined;
if (since !== undefined && !Number.isFinite(since))
	throw new Error("Date --since invalide.");
const targetId = options.get("--target");
const deploymentId = options.get("--deployment");
if (deploymentId && !targetId)
	throw new Error("--deployment nécessite --target.");
if (command === "serve" && options.size)
	throw new Error("Les filtres sont réservés à la commande sync.");
const dryRun = args.includes("--dry-run") || process.env.DRY_RUN === "true";
const statePath = resolve(process.env.STATE_FILE ?? "./data/state.json");
const dokployUrl = new URL(required("DOKPLOY_URL"));
const dokployKey = required("DOKPLOY_API_KEY");
const githubToken = dryRun ? "" : required("GITHUB_TOKEN");
const config = JSON.parse(
	await readFile(process.env.CONFIG_FILE ?? "./config.json", "utf8"),
);
if (!Array.isArray(config.targets) || !config.targets.length)
	throw new Error("Configurer au moins une cible.");
const identities = new Set();
const environments = new Set();
for (const [index, target] of config.targets.entries()) {
	const prefix = `config.json : targets[${index}]`;
	if (!target || typeof target !== "object" || Array.isArray(target)) {
		throw new Error(`${prefix} doit être un objet.`);
	}
	if (!["application", "compose"].includes(target.type)) {
		throw new Error(`${prefix}.type doit être "application" ou "compose".`);
	}
	if (
		typeof target.id !== "string" ||
		!target.id ||
		target.id.startsWith("REMPLACER")
	) {
		throw new Error(
			`${prefix}.id : remplacer la valeur d'exemple par l'identifiant réel du service Dokploy.`,
		);
	}
	if (typeof target.service !== "string" || !target.service) {
		throw new Error(
			`${prefix}.service : renseigner un nom de service, par exemple "api".`,
		);
	}
	if (
		typeof target.repository !== "string" ||
		!/^[\w.-]+\/[\w.-]+$/.test(target.repository)
	) {
		throw new Error(
			`${prefix}.repository doit être au format "owner/repository".`,
		);
	}
	if (typeof target.environment !== "string" || !target.environment) {
		throw new Error(
			`${prefix}.environment : renseigner le nom de l'environnement GitHub.`,
		);
	}
	const identity = `${target.type}:${target.id}`;
	const environment = `${target.repository}:${target.environment}:${target.service}`;
	if (identities.has(identity) || environments.has(environment)) {
		throw new Error(
			"Chaque cible doit avoir un identifiant et une combinaison dépôt/environnement/service distincts.",
		);
	}
	identities.add(identity);
	environments.add(environment);
	if (target.environmentUrl) new URL(target.environmentUrl);
}

const selectedTargets = targetId
	? config.targets.filter((target) => target.id === targetId)
	: config.targets;
if (!selectedTargets.length)
	throw new Error("Cible --target introuvable dans config.json.");

let state = { version: 2, groups: {}, sources: {} };
let legacyState;
try {
	const saved = await readFile(statePath, "utf8");
	state = JSON.parse(saved);
	if (
		state.version === 1 &&
		state.deployments &&
		typeof state.deployments === "object" &&
		!Array.isArray(state.deployments)
	) {
		legacyState = saved;
		const sources = {};
		for (const [key, record] of Object.entries(state.deployments)) {
			const [source, type, id, repository, environment] = JSON.parse(key);
			const target = config.targets.find(
				(target) =>
					target.type === type &&
					target.id === id &&
					target.repository === repository &&
					target.environment === environment,
			);
			if (!target || source !== dokployUrl.origin || !record.sha) continue;
			const identity = sourceKey(target, source);
			sources[identity] = latestAttempts([record], sources[identity]);
		}
		state = { version: 2, groups: {}, sources };
	}
	if (
		state.version !== 2 ||
		!state.groups ||
		!state.sources ||
		typeof state.groups !== "object" ||
		typeof state.sources !== "object" ||
		Array.isArray(state.groups) ||
		Array.isArray(state.sources)
	)
		throw new Error("Fichier d’état invalide.");
} catch (error) {
	if (error.code !== "ENOENT") throw error;
}
let queue = Promise.resolve();
let periodicPending = false;
let syncRequested = false;

function required(name) {
	const value = process.env[name];
	if (!value) throw new Error(`Variable ${name} manquante.`);
	return value;
}

function log(event, details = {}) {
	console.log(
		JSON.stringify({
			level: event.endsWith("failed") ? 50 : event === "skipped" ? 40 : 30,
			timestamp: new Date().toISOString(),
			event,
			...details,
		}),
	);
}

async function request(url, headers, body) {
	const response = await fetch(url, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			...headers,
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(30_000),
		redirect: "error",
	});
	// Ne pas journaliser les corps de réponse : ils peuvent contenir des données privées.
	if (!response.ok)
		throw new Error(`${new URL(url).pathname}: HTTP ${response.status}`);
	return response.json();
}

function github(path, body) {
	return request(
		`https://api.github.com${path}`,
		{
			Authorization: `Bearer ${githubToken}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2026-03-10",
			"User-Agent": "deployment-tracker",
		},
		body,
	);
}

async function saveState() {
	await mkdir(dirname(statePath), { recursive: true });
	if (legacyState) {
		try {
			await writeFile(`${statePath}.v1.bak`, legacyState, {
				flag: "wx",
				mode: 0o600,
			});
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		}
		legacyState = undefined;
	}
	const temporary = `${statePath}.tmp`;
	await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
		mode: 0o600,
	});
	await rename(temporary, statePath);
}

function normalize(record) {
	const status = { done: "success", error: "failure", cancelled: "failure" }[
		record.status
	];
	if (record.isPreviewDeployment) return { skip: "Preview ignorée" };
	if (typeof record.deploymentId !== "string" || !record.deploymentId) {
		throw new Error("Réponse Dokploy sans deploymentId.");
	}
	// Hash conservé par le webhook GitHub de Dokploy ; aucune résolution du HEAD actuel.
	const hash =
		typeof record.description === "string"
			? /\b(?:Hash|Commit):\s*([a-f0-9]{40})\b/i.exec(record.description)?.[1]
			: undefined;
	const sha = [record.commitSha, record.sha, hash].find(
		(value) => typeof value === "string" && /^[a-f0-9]{40}$/i.test(value),
	);
	if (!sha) return { skip: "Commit exact absent : import ignoré" };
	const createdAt = record.createdAt;
	const finishedAt = record.finishedAt || null;
	if (
		!Number.isFinite(Date.parse(createdAt)) ||
		(finishedAt && !Number.isFinite(Date.parse(finishedAt)))
	) {
		return { skip: "Date Dokploy invalide" };
	}
	return {
		id: record.deploymentId,
		sha: sha.toLowerCase(),
		status: status ?? null,
		createdAt,
		finishedAt,
	};
}

async function remoteDeployments(targets) {
	const deployments = new Map();
	const target = targets[0];
	for (let page = 1; ; page++) {
		const query = new URLSearchParams({
			environment: target.environment,
			per_page: "100",
			page: String(page),
		});
		const items = await github(
			`/repos/${target.repository}/deployments?${query}`,
		);
		if (!Array.isArray(items)) throw new Error("Réponse GitHub inattendue.");
		for (const item of items) {
			let payload = item.payload;
			if (typeof payload === "string") {
				try {
					payload = JSON.parse(payload);
				} catch {
					continue;
				}
			}
			if (
				payload?.tracker !== "dokploy-deployment-tracker" ||
				payload.source !== dokployUrl.origin
			)
				continue;
			const grouped = payload.mode === "environment-commit";
			const legacy = targets.some(
				(target) =>
					payload.serviceId === target.id &&
					payload.serviceType === target.type,
			);
			if (!grouped && !legacy) continue;
			const previous = deployments.get(item.sha);
			// Préférer une entrée regroupée, sinon reprendre l’ancienne entrée la plus ancienne.
			if (
				!previous ||
				(grouped && !previous.grouped) ||
				(grouped === previous.grouped && item.id < previous.id)
			) {
				deployments.set(item.sha, { ...item, grouped });
			}
		}
		if (items.length < 100) return deployments;
	}
}

async function sync() {
	const summary = {
		created: 0,
		updated: 0,
		recovered: 0,
		unchanged: 0,
		waiting: 0,
		skipped: 0,
		failed: 0,
		dryRun,
	};
	const environments = new Map();
	for (const target of selectedTargets) {
		const key = JSON.stringify([target.repository, target.environment]);
		// Un filtre sur un service sélectionne son environnement complet : ne jamais publier un succès partiel.
		environments.set(
			key,
			config.targets.filter(
				(candidate) =>
					candidate.repository === target.repository &&
					candidate.environment === target.environment,
			),
		);
	}
	for (const targets of environments.values()) {
		const target = targets[0];
		try {
			const sources = { ...state.sources };
			let selectedSha;
			for (const service of targets) {
				const endpoint =
					service.type === "application"
						? "deployment.all"
						: "deployment.allByCompose";
				const url = new URL(`/api/${endpoint}`, dokployUrl);
				url.searchParams.set(
					service.type === "application" ? "applicationId" : "composeId",
					service.id,
				);
				const records = await request(url, { "x-api-key": dokployKey });
				if (!Array.isArray(records))
					throw new Error("Réponse Dokploy inattendue : tableau attendu.");
				if (deploymentId && service.id === targetId) {
					const selected = records.find(
						(record) => record.deploymentId === deploymentId,
					);
					if (!selected)
						throw new Error(
							"Déploiement --deployment introuvable pour cette cible.",
						);
					const normalized = normalize(selected);
					if (normalized.skip) throw new Error(normalized.skip);
					selectedSha = normalized.sha;
				}
				const normalized = [];
				for (const record of records) {
					const deployment = normalize(record);
					if (deployment.skip) {
						summary.skipped++;
						log("skipped", {
							service: service.service,
							id: record.deploymentId,
							reason: deployment.skip,
						});
					} else normalized.push(deployment);
				}
				const key = sourceKey(service, dokployUrl.origin);
				sources[key] = latestAttempts(normalized, sources[key]);
			}
			if (!dryRun) {
				state.sources = sources;
				await saveState();
			}
			const remote = dryRun ? new Map() : await remoteDeployments(targets);
			for (const deployment of groupedDeployments(
				targets,
				sources,
				dokployUrl.origin,
			)) {
				if (selectedSha && deployment.sha !== selectedSha) continue;
				if (
					since !== undefined &&
					Date.parse(deployment.finishedAt ?? deployment.createdAt) < since
				)
					continue;
				if (!deployment.status) {
					summary.waiting++;
					continue;
				}
				const key = JSON.stringify([
					dokployUrl.origin,
					target.repository,
					target.environment,
					deployment.sha,
				]);
				const fingerprint = JSON.stringify(deployment);
				const previous = state.groups[key];
				if (previous?.fingerprint === fingerprint && previous.complete) {
					summary.unchanged++;
					continue;
				}
				try {
					if (dryRun) {
						log("would_sync", {
							environment: target.environment,
							...deployment,
						});
						continue;
					}
					const recovered = remote.get(deployment.sha);
					let githubId = previous?.githubId ?? recovered?.id;
					let created = false;
					if (!githubId) {
						const result = await github(
							`/repos/${target.repository}/deployments`,
							{
								ref: deployment.sha,
								environment: target.environment,
								task: "deploy",
								auto_merge: false,
								required_contexts: [],
								production_environment: targets.some(
									(target) => target.production === true,
								),
								description: `Dokploy · ${deployment.finishedAt}`,
								payload: {
									tracker: "dokploy-deployment-tracker",
									mode: "environment-commit",
									source: dokployUrl.origin,
									dokployCreatedAt: deployment.createdAt,
									dokployFinishedAt: deployment.finishedAt,
									services: deployment.services,
								},
							},
						);
						if (!Number.isInteger(result.id))
							throw new Error("GitHub n’a pas créé de déploiement.");
						githubId = result.id;
						created = true;
					}
					state.groups[key] = {
						...deployment,
						githubId,
						fingerprint,
						complete: false,
					};
					await saveState();
					const statuses = await github(
						`/repos/${target.repository}/deployments/${githubId}/statuses?per_page=1`,
					);
					if (!Array.isArray(statuses))
						throw new Error("Réponse des statuts GitHub inattendue.");
					const services = deployment.services
						.map(
							({ service, deployment }) =>
								`${service}:${deployment?.status ?? "absent/en cours"}`,
						)
						.join(" ");
					const description =
						`Dokploy ${deployment.finishedAt} · ${services}`.slice(0, 140);
					const changed =
						statuses[0]?.state !== deployment.status ||
						statuses[0]?.description !== description;
					if (changed) {
						// Ajouter un résultat à la même entrée ; aucune nouvelle ligne pour un redéploiement du commit.
						await github(
							`/repos/${target.repository}/deployments/${githubId}/statuses`,
							{
								state: deployment.status,
								description,
								auto_inactive: false,
								...(targets.find(
									(target) => target.service === "web" && target.environmentUrl,
								)?.environmentUrl
									? {
											environment_url: targets.find(
												(target) =>
													target.service === "web" && target.environmentUrl,
											).environmentUrl,
										}
									: {}),
							},
						);
					}
					state.groups[key].complete = true;
					await saveState();
					const event = created ? "created" : changed ? "updated" : "recovered";
					summary[event]++;
					log(event, {
						environment: target.environment,
						sha: deployment.sha,
						status: deployment.status,
						finishedAt: deployment.finishedAt,
						githubId,
					});
				} catch (error) {
					summary.failed++;
					log("import_failed", {
						environment: target.environment,
						sha: deployment.sha,
						message: error.message,
					});
				}
			}
		} catch (error) {
			summary.failed++;
			log("target_failed", {
				environment: target.environment,
				message: error.message,
			});
		}
	}
	log("sync_complete", summary);
	return summary;
}

function enqueueSync() {
	const operation = queue.then(sync);
	queue = operation.catch((error) =>
		log("sync_failed", { message: error.message }),
	);
	return operation;
}

if (command === "sync") {
	const result = await enqueueSync();
	process.exitCode = result.failed > 0 ? 1 : 0;
} else {
	const secret = required("WEBHOOK_SECRET");
	const interval = Number(process.env.SYNC_INTERVAL_SECONDS ?? 86400);
	const port = Number(process.env.PORT ?? 3000);
	if (
		!Number.isInteger(interval) ||
		interval < 0 ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65535
	) {
		throw new Error("PORT ou SYNC_INTERVAL_SECONDS invalide.");
	}
	let closing = false;
	const server = createHttpServer({
		secret,
		dryRun,
		onNotification: scheduleSync,
	});
	function scheduleSync() {
		if (closing) return;
		syncRequested = true;
		if (periodicPending) return;
		periodicPending = true;
		enqueueRequestedSyncs()
			.finally(() => {
				periodicPending = false;
			})
			.catch(() => {});
	}
	async function enqueueRequestedSyncs() {
		while (syncRequested && !closing) {
			syncRequested = false;
			await enqueueSync();
		}
	}
	const timer =
		interval > 0 ? setInterval(scheduleSync, interval * 1000) : undefined;
	server.addHook("onClose", async () => {
		closing = true;
		clearInterval(timer);
		await queue;
	});
	await server.listen({ port, host: "0.0.0.0" });
	log("listening", { port, dryRun });
	scheduleSync();
	let stopping = false;
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.once(signal, async () => {
			if (stopping) return;
			stopping = true;
			closing = true;
			clearInterval(timer);
			const timeout = setTimeout(() => process.exit(1), 35_000);
			timeout.unref();
			try {
				await server.close();
				process.exitCode = 0;
			} catch (error) {
				log("shutdown_failed", { message: error.message });
				process.exitCode = 1;
			} finally {
				clearTimeout(timeout);
			}
		});
	}
}
