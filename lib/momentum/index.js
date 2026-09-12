'use strict';
// Öffentliche API des Momentum-Kernmoduls ("Sichtbarer Fortschritt" -
// Erledigt-Moment, Tages-Serie, Wochen-Rückblick-Karte). Re-Export der
// Teile, die M2 (server.js-Wiring) sowie M3/M4/M5 (Web/iOS) über die
// REST-Schnittstelle konsumieren.
const { runMomentumMigrations, purgeMomentumOrphans } = require('./schema');
const { createMomentumRouter } = require('./routes');
const { applyTodoDoneChange, applyTopicDoneChange } = require('./completion');
const queries = require('./queries');

// Bequemer Einzelwert für den Wochenzähler, der additiv in die Antwort der
// BESTEHENDEN Routen `PUT /todos/:id` / `PUT /meetings/:mid/topics/:tid`
// eingebettet wird (siehe Architektur-Vertrag: kein Extra-Request für den
// Erledigt-Moment-Toast).
function weeklyCompletedCount(db, { userId, utcOffsetMinutes = 0, now = new Date() }) {
  const todayStr = queries.localDateStr(now, utcOffsetMinutes);
  const { startDate, endDate } = queries.weekBoundsForLocalDate(todayStr);
  return queries.weekCounts(db, userId, startDate, endDate).completedCount;
}

module.exports = {
  runMomentumMigrations,
  purgeMomentumOrphans,
  createMomentumRouter,
  applyTodoDoneChange,
  applyTopicDoneChange,
  weeklyCompletedCount,
  ...queries,
};
