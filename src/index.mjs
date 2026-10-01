import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHttpServer } from "./server.mjs";

const args = process.argv.slice(2);
const command = args.shift() ?? "serve";
if (!["serve", "sync"].includes(command) || args.includes("--help")) {
 console.log("pnpm start | pnpm sync [--dry-run] [--since YYYY-MM-DD] [--target ID --deployment ID]");
 process.exit(args.includes("--help") ? 0 : 1);
}
const options = new Map();
for (let index = 0; index < args.length; index++) {
 const option = args[index];
 if (options.has(option)) throw new Error(`Option répétée : ${option}`);
 if (option === "--dry-run") { options.set(option, true); continue; }
 if (!["--since", "--target", "--deployment"].includes(option)) throw new Error(`Option inconnue : ${option}`);
 const value = args[++index];
 if (!value || value.startsWith("--")) throw new Error(`Valeur manquante : ${option}`);
 options.set(option, value);
}
const since = options.has("--since") ? Date.parse(options.get("--since")) : undefined;
if (since !== undefined && !Number.isFinite(since)) throw new Error("Date --since invalide.");
const targetId = options.get("--target");
const deploymentId = options.get("--deployment");
if (deploymentId && !targetId) throw new Error("--deployment nécessite --target.");
if (command === "serve" && options.size) throw new Error("Les filtres sont réservés à la commande sync.");
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

const selectedTargets = targetId ? config.targets.filter((target) => target.id === targetId) : config.targets;
if (!selectedTargets.length) throw new Error("Cible --target introuvable dans config.json.");

let state = { version: 1, deployments: {} };
try {
	state = JSON.parse(await readFile(statePath, "utf8"));
	if (
		state.version !== 1 ||
		!state.deployments ||
		Array.isArray(state.deployments) ||
		typeof state.deployments !== "object"
	)
		throw new Error("Fichier d’état invalide.");
} catch (error) {
	if (error.code !== "ENOENT") throw error;
}
let queue = Promise.resolve();
let periodicPending = false;

function required(name) {
	const value = process.env[name];
	if (!value) throw new Error(`Variable ${name} manquante.`);
	return value;
}

function log(event, details = {}) {
	console.log(
		JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }),
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
	const temporary = `${statePath}.tmp`;
	await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
		mode: 0o600,
	});
	await rename(temporary, statePath);
}

function normalize(record) {
	const status = { done: "success", error: "failure", cancelled: "error" }[
		record.status
	];
	if (!status) return { skip: "Déploiement non terminé" };
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
	return { id: record.deploymentId, sha, status, createdAt, finishedAt };
}

async function remoteDeployments(target) {
	const deployments = new Map();
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
				payload?.tracker === "dokploy-deployment-tracker" &&
				payload.source === dokployUrl.origin &&
				payload.serviceId === target.id &&
				payload.serviceType === target.type
			) {
				deployments.set(payload.dokployDeploymentId, item);
			}
		}
		if (items.length < 100) return deployments;
	}
}

async function sync() {
	const summary = { imported: 0, unchanged: 0, skipped: 0, failed: 0, dryRun };
	for (const target of selectedTargets) {
		try {
			const endpoint =
				target.type === "application"
					? "deployment.all"
					: "deployment.allByCompose";
			const url = new URL(`/api/${endpoint}`, dokployUrl);
			url.searchParams.set(
				target.type === "application" ? "applicationId" : "composeId",
				target.id,
			);
			const records = await request(url, { "x-api-key": dokployKey });
			if (!Array.isArray(records))
				throw new Error("Réponse Dokploy inattendue : tableau attendu.");
			if (deploymentId && !records.some((record) => record.deploymentId === deploymentId))
                throw new Error("Déploiement --deployment introuvable pour cette cible.");
            const remote = dryRun ? new Map() : await remoteDeployments(target);
			records.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
			for (const record of records) {
                if (deploymentId && record.deploymentId !== deploymentId) continue;
				if (
					since !== undefined &&
					Date.parse(record.finishedAt || record.createdAt) < since
				)
					continue;
				const deployment = normalize(record);
				if (deployment.skip) {
					summary.skipped++;
					log("skipped", {
						service: target.service,
						id: record.deploymentId,
						reason: deployment.skip,
					});
					continue;
				}
				const key = JSON.stringify([
					dokployUrl.origin,
					target.type,
					target.id,
					target.repository,
					target.environment,
					deployment.id,
				]);
				const previous = state.deployments[key];
				const fingerprint = JSON.stringify([
					deployment.sha,
					deployment.status,
					deployment.createdAt,
					deployment.finishedAt,
				]);
				if (previous?.fingerprint === fingerprint && previous.complete) {
					summary.unchanged++;
					continue;
				}
				try {
					if (dryRun) {
						log("would_import", {
							service: target.service,
							environment: target.environment,
							...deployment,
						});
						summary.imported++;
						continue;
					}
					const recovered = remote.get(deployment.id);
					let githubId = previous?.githubId ?? recovered?.id;
					if (recovered && recovered.sha !== deployment.sha)
						throw new Error(
							"Commit différent dans le déploiement GitHub existant.",
						);
					if (!githubId) {
						const created = await github(
							`/repos/${target.repository}/deployments`,
							{
								ref: deployment.sha,
								environment: target.environment,
								task: `deploy:${target.service}`,
								auto_merge: false,
								required_contexts: [],
								production_environment: target.production === true,
								description:
									`${target.service} · Dokploy · ${deployment.finishedAt ?? deployment.createdAt}`.slice(
										0,
										140,
									),
								payload: {
									tracker: "dokploy-deployment-tracker",
									source: dokployUrl.origin,
									serviceId: target.id,
									serviceType: target.type,
									dokployDeploymentId: deployment.id,
									dokployCreatedAt: deployment.createdAt,
									dokployFinishedAt: deployment.finishedAt,
									service: target.service,
								},
							},
						);
						if (!Number.isInteger(created.id))
							throw new Error("GitHub n’a pas créé de déploiement.");
						githubId = created.id;
					}
					state.deployments[key] = {
						...deployment,
						githubId,
						fingerprint,
						complete: false,
					};
					await saveState();
					const statuses = await github(
						`/repos/${target.repository}/deployments/${githubId}/statuses?per_page=1`,
					);
					const description =
						`Dokploy ${deployment.status} · ${deployment.finishedAt ?? deployment.createdAt}`.slice(
							0,
							140,
						);
					if (!Array.isArray(statuses))
						throw new Error("Réponse des statuts GitHub inattendue.");
					if (
						statuses[0]?.state !== deployment.status ||
						statuses[0]?.description !== description
					) {
						await github(
							`/repos/${target.repository}/deployments/${githubId}/statuses`,
							{
								state: deployment.status,
								description,
								// Un import ancien ne doit pas désactiver une livraison récente.
								auto_inactive: false,
								...(target.environmentUrl
									? { environment_url: target.environmentUrl }
									: {}),
							},
						);
					}
					state.deployments[key].complete = true;
					await saveState();
					summary.imported++;
					log("imported", {
						service: target.service,
						environment: target.environment,
						...deployment,
						githubId,
					});
				} catch (error) {
					summary.failed++;
					log("import_failed", {
						service: target.service,
						id: deployment.id,
						message: error.message,
					});
				}
			}
		} catch (error) {
			summary.failed++;
			log("target_failed", { service: target.service, message: error.message });
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
	const interval = Number(process.env.SYNC_INTERVAL_SECONDS ?? 300);
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
	const server = createHttpServer({ secret, dryRun, onNotification: scheduleSync });
	function scheduleSync() {
		if (closing || periodicPending) return;
		periodicPending = true;
		enqueueSync()
			.finally(() => {
				periodicPending = false;
			})
			.catch(() => {});
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
