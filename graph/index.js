'use strict';
// Barrel: die eigentliche Implementierung liegt in queries.js (DB-Zugriff,
// pure Kanten-/Knotenaufbau) und routes.js (Express-Registrierung), aus
// dem vormals monolithischen graph/index.js extrahiert (Arbeit zur
// Lesbarkeit/Wartbarkeit) - Verhalten und externer Vertrag (Funktions-
// signatur `graphRoutes(app, ctx)` + `.GRAPH_MAX_NODES`) unveraendert.
module.exports = require('./routes');
