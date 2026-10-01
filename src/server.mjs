import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";

export function createHttpServer({ secret, dryRun, onNotification }) {
	const server = Fastify({
		bodyLimit: 65_536,
		requestTimeout: 15_000,
		logger: {
			redact: ["req.headers.authorization"],
		},
	});
	const expected = Buffer.from(`Bearer ${secret}`);

	server.get("/health", async () => ({ ok: true, dryRun }));

	server.post("/webhooks/dokploy", {
		onRequest: async (request, reply) => {
			const actual = Buffer.from(request.headers.authorization ?? "");
			if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
				return reply.code(401).send({ error: "Unauthorized" });
			}
		},
		schema: {
			body: { type: "object", additionalProperties: true },
		},
	}, async (request, reply) => {
		const { type, status } = request.body;
		if (type !== "build" || !["success", "error"].includes(status)) {
			return { ignored: true, reason: "Test or unsupported notification" };
		}
		// L’API Dokploy fournit les données ; la notification réveille la synchronisation.
		onNotification();
		return reply.code(202).send({ accepted: true });
	});

	server.setErrorHandler((error, request, reply) => {
		const status = error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
		if (status === 500) request.log.error({ err: error }, "Erreur du serveur HTTP");
		const messages = {
			400: "Invalid JSON or payload",
			413: "Payload too large",
			415: "Content-Type must be application/json",
		};
		return reply.code(status).send({ error: messages[status] ?? "Internal server error" });
	});
	server.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "Not found" }));
	return server;
}
