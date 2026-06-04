/* =============================================================================
 * MA Study Engine  (ma-prep)
 * Pure logic only — NO DOM, NO Firebase. Same engine runs in the browser and in
 * Node for verification. This is the single source of scoring / weak-area truth.
 *
 * Design rules baked in (from the spec):
 *   - Store RAW facts (marksAwarded / marksAvailable). NEVER store a %.
 *   - Compute every derived number on READ.
 *   - Multi-response = all-or-nothing.
 *   - Skipped / unattempted = 0 marks.
 *   - Weak-area % = Σ marksAwarded / Σ marksAvailable within a subTopic.
 *   - Re-attempts: keep ALL history; Latest / Average toggle on read.
 *   - RAG: red < 50, amber 50–65, green > 65.
 *   - min-attempts guard = 2.
 *   - MA pace target = 1.2 min / mark.
 *   - schemaVersion on every record + migrate-on-read.
 * ===========================================================================*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MAEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCHEMA_VERSION = 1;
  var PACE_MIN_PER_MARK = 1.2;
  var RAG_RED = 50;     // below this = red
  var RAG_GREEN = 65;   // above this = green; between = amber
  var MIN_ATTEMPTS = 2; // guard

  var MODES = ['practice', 'chapter_test', 'multi_chapter_test', 'mock'];

  // ---------------------------------------------------------------------------
  // Migration (migrate-on-read). v0/undefined -> v1. Future bumps slot in here.
  // ---------------------------------------------------------------------------
  function migrateQuestion(q) {
    if (!q) return q;
    var out = Object.assign({}, q);
    if (out.schemaVersion == null) out.schemaVersion = 1;
    // (no field renames yet; placeholder for future versions)
    out.schemaVersion = SCHEMA_VERSION;
    return out;
  }

  function migrateAttempt(a) {
    if (!a) return a;
    var out = Object.assign({}, a);
    if (out.schemaVersion == null) out.schemaVersion = 1;
    if (out.partId === undefined) out.partId = null;
    if (out.yourWorking === undefined) out.yourWorking = '';
    out.schemaVersion = SCHEMA_VERSION;
    return out;
  }

  // ---------------------------------------------------------------------------
  // Low-level graders
  // ---------------------------------------------------------------------------
  function _setsEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    var sa = a.slice().sort(), sb = b.slice().sort();
    for (var i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
    return true;
  }

  function gradeMcq(correctAnswer, picked) {
    return picked != null && picked === correctAnswer;
  }

  // all-or-nothing: every correct option, and nothing else
  function gradeMulti(correctOptions, selected) {
    return _setsEqual(correctOptions || [], selected || []);
  }

  function gradeNumber(numAns, tol, value) {
    if (value == null || isNaN(value)) return false;
    var t = (tol == null) ? 0 : Math.abs(tol);
    return Math.abs(Number(value) - Number(numAns)) <= t;
  }

  /**
   * Grade a single scorable unit (an OT question OR one MTQ part).
   * unit: { questionType, marks, correctAnswer | correctOptions | numAns,tol }
   * response: { answer } | { selected:[] } | { value } | null/undefined (=skip)
   * Returns { marksAwarded, marksAvailable, correct, skipped }
   */
  function gradeUnit(unit, response) {
    var available = Number(unit.marks) || 0;
    var skipped = response == null ||
      (response.answer == null && response.value == null &&
       (!response.selected || response.selected.length === 0));
    var correct = false;

    if (!skipped) {
      switch (unit.questionType) {
        case 'mcq':
          correct = gradeMcq(unit.correctAnswer, response.answer); break;
        case 'multi':
          correct = gradeMulti(unit.correctOptions, response.selected); break;
        case 'number':
          correct = gradeNumber(unit.numAns, unit.tol, response.value); break;
        default:
          correct = false;
      }
    }
    return {
      marksAwarded: correct ? available : 0,
      marksAvailable: available,
      correct: correct,
      skipped: skipped
    };
  }

  /**
   * Score a whole question. For OT -> 1 result. For MTQ -> 1 result PER PART.
   * Each result is shaped ready to become an attempt record.
   * responses for MTQ: { partId: response } map.
   */
  function scoreQuestion(question, response) {
    var q = migrateQuestion(question);
    if (q.questionType === 'mtq') {
      var map = response || {};
      return (q.parts || []).map(function (part) {
        var r = map[part.id];
        var g = gradeUnit(part, r);
        return {
          questionId: q.id,
          partId: part.id,
          syllabusArea: q.syllabusArea,
          subTopic: part.subTopic,
          marksAwarded: g.marksAwarded,
          marksAvailable: g.marksAvailable,
          correct: g.correct,
          skipped: g.skipped
        };
      });
    }
    var gg = gradeUnit(q, response);
    return [{
      questionId: q.id,
      partId: null,
      syllabusArea: q.syllabusArea,
      subTopic: q.subTopic,
      marksAwarded: gg.marksAwarded,
      marksAvailable: gg.marksAvailable,
      correct: gg.correct,
      skipped: gg.skipped
    }];
  }

  /** Build a persistable attempt record from a score result + context. */
  function buildAttempt(scoreResult, ctx) {
    ctx = ctx || {};
    return migrateAttempt({
      questionId: scoreResult.questionId,
      partId: scoreResult.partId,
      syllabusArea: scoreResult.syllabusArea,
      subTopic: scoreResult.subTopic,
      marksAwarded: scoreResult.marksAwarded,
      marksAvailable: scoreResult.marksAvailable,
      mode: ctx.mode || 'practice',
      testId: ctx.testId || null,
      timeSpentSec: ctx.timeSpentSec || 0,
      yourWorking: ctx.yourWorking || '',
      timestamp: ctx.timestamp || Date.now()
    });
  }

  // ---------------------------------------------------------------------------
  // RAG
  // ---------------------------------------------------------------------------
  function rag(pct) {
    if (pct == null) return 'none';
    if (pct < RAG_RED) return 'red';
    if (pct > RAG_GREEN) return 'green';
    return 'amber';
  }

  // ---------------------------------------------------------------------------
  // Read-side analytics
  // ---------------------------------------------------------------------------
  function _filterMode(attempts, mode) {
    if (!mode || mode === 'combined') return attempts.slice();
    return attempts.filter(function (a) { return a.mode === mode; });
  }

  // For "Latest": keep only the most recent attempt per (questionId|partId).
  function _latestPerUnit(attempts) {
    var byKey = {};
    attempts.forEach(function (a) {
      var k = a.questionId + '::' + (a.partId == null ? '_' : a.partId);
      if (!byKey[k] || a.timestamp > byKey[k].timestamp) byKey[k] = a;
    });
    return Object.keys(byKey).map(function (k) { return byKey[k]; });
  }

  /**
   * Weak areas, ranked worst-first.
   * opts: { mode, latest(bool), minAttempts }
   * Returns [{ subTopic, syllabusArea, awarded, available, pct, rag,
   *            attempts, insufficient }]
   */
  function weakAreas(attempts, opts) {
    opts = opts || {};
    var minA = opts.minAttempts == null ? MIN_ATTEMPTS : opts.minAttempts;
    // RAW pool drives the evidence count (min-2 guard + displayed attempts).
    var raw = _filterMode(migrateAll(attempts, migrateAttempt), opts.mode);
    // SCORING pool drives the % (Latest collapses re-attempts to the newest per unit).
    var scoring = opts.latest ? _latestPerUnit(raw) : raw;

    var bySub = {};
    function ensure(a) {
      var s = a.subTopic;
      if (!bySub[s]) bySub[s] = { subTopic: s, syllabusArea: a.syllabusArea, awarded: 0, available: 0, attempts: 0 };
      return bySub[s];
    }
    raw.forEach(function (a) { ensure(a).attempts += 1; });           // evidence count
    scoring.forEach(function (a) {                                    // marks for %
      var r = ensure(a);
      r.awarded += Number(a.marksAwarded) || 0;
      r.available += Number(a.marksAvailable) || 0;
    });

    var rows = Object.keys(bySub).map(function (s) {
      var r = bySub[s];
      var insufficient = r.attempts < minA;
      var pct = r.available > 0 ? (r.awarded / r.available) * 100 : null;
      return {
        subTopic: r.subTopic,
        syllabusArea: r.syllabusArea,
        awarded: r.awarded,
        available: r.available,
        attempts: r.attempts,
        pct: insufficient ? null : pct,
        rag: insufficient ? 'none' : rag(pct),
        insufficient: insufficient
      };
    });

    // worst-first; insufficient pushed to the bottom
    rows.sort(function (a, b) {
      if (a.insufficient !== b.insufficient) return a.insufficient ? 1 : -1;
      return (a.pct == null ? 999 : a.pct) - (b.pct == null ? 999 : b.pct);
    });
    return rows;
  }

  /** Worst RAG-red subTopic with >= minAttempts (for "Next weakest -> drill"). */
  function nextWeakest(attempts, opts) {
    var rows = weakAreas(attempts, opts);
    for (var i = 0; i < rows.length; i++) {
      if (!rows[i].insufficient && rows[i].rag === 'red') return rows[i];
    }
    // fall back to worst rated subtopic if no red
    for (var j = 0; j < rows.length; j++) if (!rows[j].insufficient) return rows[j];
    return null;
  }

  /** Time per mark (minutes) vs the 1.2 target. opts: { mode } */
  function timePerMark(attempts, opts) {
    opts = opts || {};
    var pool = _filterMode(migrateAll(attempts, migrateAttempt), opts.mode);
    var sec = 0, marks = 0;
    pool.forEach(function (a) {
      sec += Number(a.timeSpentSec) || 0;
      marks += Number(a.marksAvailable) || 0;
    });
    if (marks === 0) return { minPerMark: null, target: PACE_MIN_PER_MARK, rag: 'none' };
    var mpm = (sec / 60) / marks;
    // timing RAG: faster than target = green, within 20% = amber, slower = red
    var tRag = mpm <= PACE_MIN_PER_MARK ? 'green'
             : mpm <= PACE_MIN_PER_MARK * 1.2 ? 'amber' : 'red';
    return { minPerMark: mpm, target: PACE_MIN_PER_MARK, rag: tRag, totalSec: sec, totalMarks: marks };
  }

  /** Overall score % across a (possibly filtered) attempt set. */
  function overallScore(attempts, opts) {
    opts = opts || {};
    var pool = _filterMode(migrateAll(attempts, migrateAttempt), opts.mode);
    if (opts && opts.latest) pool = _latestPerUnit(pool);
    var awarded = 0, available = 0;
    pool.forEach(function (a) { awarded += +a.marksAwarded || 0; available += +a.marksAvailable || 0; });
    return available > 0 ? (awarded / available) * 100 : null;
  }

  /** Practice vs mock gap per subTopic (answers "weak generally vs under timing"). */
  function practiceVsMockGap(attempts) {
    var p = {}, m = {};
    migrateAll(attempts, migrateAttempt).forEach(function (a) {
      var bucket = a.mode === 'mock' ? m : (a.mode === 'practice' ? p : null);
      if (!bucket) return;
      if (!bucket[a.subTopic]) bucket[a.subTopic] = { awarded: 0, available: 0 };
      bucket[a.subTopic].awarded += +a.marksAwarded || 0;
      bucket[a.subTopic].available += +a.marksAvailable || 0;
    });
    var subs = {};
    Object.keys(p).forEach(function (s) { subs[s] = true; });
    Object.keys(m).forEach(function (s) { subs[s] = true; });
    return Object.keys(subs).map(function (s) {
      var pp = p[s] && p[s].available ? (p[s].awarded / p[s].available) * 100 : null;
      var mm = m[s] && m[s].available ? (m[s].awarded / m[s].available) * 100 : null;
      return { subTopic: s, practicePct: pp, mockPct: mm, gap: (pp != null && mm != null) ? (pp - mm) : null };
    });
  }

  function migrateAll(arr, fn) { return (arr || []).map(fn); }

  // ---------------------------------------------------------------------------
  // Question validation (the spec's verification list, item 7)
  // ---------------------------------------------------------------------------
  function validateQuestion(q, taxonomyIndex) {
    var errs = [];
    if (!q || !q.id) { errs.push('missing id'); return errs; }
    var tag = '[' + q.id + '] ';

    if (taxonomyIndex) {
      if (!taxonomyIndex.areas[q.syllabusArea]) errs.push(tag + 'unknown syllabusArea: ' + q.syllabusArea);
    }

    if (q.questionType === 'mtq') {
      if (!Array.isArray(q.parts) || q.parts.length === 0) errs.push(tag + 'mtq has no parts');
      var sum = 0;
      (q.parts || []).forEach(function (p, i) {
        var ptag = tag + 'part ' + (p.id || i) + ': ';
        sum += Number(p.marks) || 0;
        if (!p.id) errs.push(ptag + 'missing part id');
        if (!p.subTopic) errs.push(ptag + 'missing subTopic');
        if (taxonomyIndex && p.subTopic && !taxonomyIndex.subTopics[p.subTopic])
          errs.push(ptag + 'unknown subTopic: ' + p.subTopic);
        if (!p.modelAnswer) errs.push(ptag + 'missing modelAnswer');
        errs = errs.concat(_validateAnswerShape(p, ptag));
      });
      if (sum !== Number(q.marks)) errs.push(tag + 'part marks (' + sum + ') != question marks (' + q.marks + ')');
    } else {
      if (!q.subTopic) errs.push(tag + 'missing subTopic');
      if (taxonomyIndex && q.subTopic && !taxonomyIndex.subTopics[q.subTopic])
        errs.push(tag + 'unknown subTopic: ' + q.subTopic);
      var layers = ['explanationLayer1', 'workingShown', 'explanationLayer3',
                    'examinerNote', 'teacherCommentary', 'advancedContext'];
      layers.forEach(function (L) {
        if (!q[L] || String(q[L]).trim() === '') errs.push(tag + 'missing explanation layer: ' + L);
      });
      errs = errs.concat(_validateAnswerShape(q, tag));
    }
    return errs;
  }

  function _validateAnswerShape(u, tag) {
    var errs = [];
    if (u.questionType === 'mcq') {
      var correctOpts = (u.options || []).filter(function (o) { return o.correct; });
      if (correctOpts.length !== 1) errs.push(tag + 'mcq must have exactly one correct option (has ' + correctOpts.length + ')');
      else if (correctOpts[0].letter !== u.correctAnswer) errs.push(tag + 'mcq correctAnswer (' + u.correctAnswer + ') != marked-correct option (' + correctOpts[0].letter + ')');
    } else if (u.questionType === 'multi') {
      if (!Array.isArray(u.correctOptions)) errs.push(tag + 'multi missing correctOptions');
      if (u.correctOptions && u.expectedSelectCount !== u.correctOptions.length)
        errs.push(tag + 'multi expectedSelectCount (' + u.expectedSelectCount + ') != correctOptions.length (' + (u.correctOptions || []).length + ')');
      var marked = (u.options || []).filter(function (o) { return o.correct; }).map(function (o) { return o.letter; });
      if (u.correctOptions && !_setsEqual(marked, u.correctOptions))
        errs.push(tag + 'multi marked-correct options != correctOptions');
    } else if (u.questionType === 'number') {
      if (u.numAns == null || isNaN(u.numAns)) errs.push(tag + 'number missing numAns');
      if (u.tol == null || isNaN(u.tol)) errs.push(tag + 'number missing tol');
    }
    return errs;
  }

  function buildTaxonomyIndex(taxonomy) {
    var areas = {}, subTopics = {};
    (taxonomy.syllabusAreas || []).forEach(function (a) {
      areas[a.area] = true;
      (a.subTopics || []).forEach(function (s) { subTopics[s] = a.area; });
    });
    return { areas: areas, subTopics: subTopics };
  }

  // ---------------------------------------------------------------------------
  // Backup / restore (serialise ENTIRE attempt history, not one test)
  // ---------------------------------------------------------------------------
  function serializeBackup(db) {
    return JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      exportedAt: Date.now(),
      questions: db.questions || [],
      attempts: db.attempts || [],
      meta: db.meta || {}
    });
  }

  function restoreBackup(json) {
    var obj = typeof json === 'string' ? JSON.parse(json) : json;
    return {
      questions: migrateAll(obj.questions, migrateQuestion),
      attempts: migrateAll(obj.attempts, migrateAttempt),
      meta: obj.meta || {}
    };
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    PACE_MIN_PER_MARK: PACE_MIN_PER_MARK,
    RAG_RED: RAG_RED, RAG_GREEN: RAG_GREEN, MIN_ATTEMPTS: MIN_ATTEMPTS, MODES: MODES,
    migrateQuestion: migrateQuestion,
    migrateAttempt: migrateAttempt,
    gradeMcq: gradeMcq, gradeMulti: gradeMulti, gradeNumber: gradeNumber,
    gradeUnit: gradeUnit,
    scoreQuestion: scoreQuestion,
    buildAttempt: buildAttempt,
    rag: rag,
    weakAreas: weakAreas,
    nextWeakest: nextWeakest,
    timePerMark: timePerMark,
    overallScore: overallScore,
    practiceVsMockGap: practiceVsMockGap,
    validateQuestion: validateQuestion,
    buildTaxonomyIndex: buildTaxonomyIndex,
    serializeBackup: serializeBackup,
    restoreBackup: restoreBackup
  };
});
