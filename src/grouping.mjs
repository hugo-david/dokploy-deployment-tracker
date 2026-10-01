export function sourceKey(target, source) {
	return JSON.stringify([
		source,
		target.type,
		target.id,
		target.repository,
		target.environment,
	]);
}

/**
 * Conserve la dernière tentative de chaque service et commit, même si elle est encore en cours.
 * @param records - Historique Dokploy normalisé du service.
 * @param previous - Tentatives déjà conservées pour les commits sortis de l’historique Dokploy.
 * @returns Les dernières tentatives indexées par commit.
 */
export function latestAttempts(records, previous = {}) {
	const latest = { ...previous };
	for (const record of records) {
		const old = latest[record.sha];
		if (!old || Date.parse(record.createdAt) >= Date.parse(old.createdAt)) {
			latest[record.sha] = record;
		}
	}
	return latest;
}

/**
 * Regroupe les services attendus pour une version sans publier de statut intermédiaire.
 * @param targets - Services configurés dans un même dépôt et environnement.
 * @param sources - Dernières tentatives normalisées par service et commit.
 * @param source - Origine de l’instance Dokploy.
 * @returns Les versions avec leur résultat final, ou un résultat absent si incomplet.
 */
export function groupedDeployments(targets, sources, source) {
	const shas = new Set(
		targets.flatMap((target) =>
			Object.keys(sources[sourceKey(target, source)] ?? {}),
		),
	);
	return [...shas]
		.map((sha) => {
			const services = [...targets]
				.sort((a, b) => a.service.localeCompare(b.service))
				.map((target) => ({
					service: target.service,
					serviceId: target.id,
					serviceType: target.type,
					deployment: sources[sourceKey(target, source)]?.[sha] ?? null,
				}));
			const present = services.flatMap((service) =>
				service.deployment ? [service.deployment] : [],
			);
			const failed = present.some(
				(deployment) => deployment.status === "failure",
			);
			const succeeded = services.every(
				(service) => service.deployment?.status === "success",
			);
			const status = failed ? "failure" : succeeded ? "success" : null;
			const final = present.filter((deployment) => deployment.status);
			const finishedAt = final.length
				? final
						.map((deployment) => deployment.finishedAt ?? deployment.createdAt)
						.sort((a, b) => Date.parse(b) - Date.parse(a))[0]
				: null;
			const createdAt = present
				.map((deployment) => deployment.createdAt)
				.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
			return { sha, status, createdAt, finishedAt, services };
		})
		.sort(
			(a, b) =>
				Date.parse(a.finishedAt ?? a.createdAt) -
				Date.parse(b.finishedAt ?? b.createdAt),
		);
}
