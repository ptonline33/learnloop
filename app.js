/* Learnloop: courses of short lessons with interactive exercises.
 *
 * Data layout:
 *   courses/catalog.json          list of courses for the library
 *   courses/<id>/course.json     lessons with a markdown body and exercises
 *
 * Exercise kinds: mcq, input, order, md, sql.
 */
(() => {
  "use strict";

  const DONE_KEY = (c, l, e) => `learnloop:done:${c}:${l}:${e}`;
  const DONE_PREFIX = "learnloop:done:";
  const SYNC_CODE_KEY = "learnloop:sync-code";
  const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  const $ = (sel) => document.querySelector(sel);
  const els = {
    grid: $("#courseGrid"),
    library: $("#libraryView"),
    course: $("#courseView"),
    lesson: $("#lessonView"),
    courseTitle: $("#courseTitle"),
    courseDesc: $("#courseDesc"),
    courseBar: $("#courseBar"),
    courseProgressText: $("#courseProgressText"),
    lessonList: $("#lessonList"),
    lessonTitle: $("#lessonTitle"),
    lessonMeta: $("#lessonMeta"),
    lessonBody: $("#lessonBody"),
    exercises: $("#exercises"),
    prevLesson: $("#prevLesson"),
    nextLesson: $("#nextLesson"),
    lessonLabel: $("#lessonLabel"),
    lessonError: $("#lessonError"),
    home: $("#homeBtn"),
    progressPill: $("#progressPill"),
    toast: $("#toast"),
    syncBtn: $("#syncBtn"),
    syncPanel: $("#syncPanel"),
    syncInput: $("#syncInput"),
    syncNewBtn: $("#syncNewBtn"),
    syncStatus: $("#syncStatus"),
  };

  const state = {
    catalog: null,
    course: null,     // course.json of the open course
    courseId: "",
    lessonIndex: 0,
    lessonWasComplete: false,
    syncCode: "",
    syncTimer: null,
  };

  /* ---------- markdown rendering ---------- */

  function mdToHtml(text) {
    if (window.marked && marked.parse) return marked.parse(text);
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  /* ---------- progress ---------- */

  function isDone(courseId, lessonIndex, exIndex) {
    try { return !!localStorage.getItem(DONE_KEY(courseId, lessonIndex, exIndex)); } catch { return false; }
  }

  function setDone(courseId, lessonIndex, exIndex) {
    try { localStorage.setItem(DONE_KEY(courseId, lessonIndex, exIndex), "1"); } catch { /* ignore */ }
  }

  function readSummary(courseId) {
    try { return JSON.parse(localStorage.getItem(`learnloop:summary:${courseId}`)) || null; } catch { return null; }
  }

  function writeSummary(courseId, done, total) {
    try { localStorage.setItem(`learnloop:summary:${courseId}`, JSON.stringify({ done, total })); } catch { /* ignore */ }
  }

  /* ---------- cross-device sync (Vercel Blob via /api/progress) ---------- */

  function genCode() {
    let s = "";
    for (let i = 0; i < 6; i++) s += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0];
    return s;
  }
  function readCode() {
    try { return String(localStorage.getItem(SYNC_CODE_KEY) || "").trim().toUpperCase(); } catch { return ""; }
  }
  function writeCode(code) {
    try { localStorage.setItem(SYNC_CODE_KEY, String(code).toUpperCase()); } catch { /* ignore */ }
  }
  function ensureCode() {
    const existing = readCode();
    if (existing) return existing;
    const fresh = genCode();
    writeCode(fresh);
    return fresh;
  }
  function getAllLocalDone() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(DONE_PREFIX)) out.push(k.slice(DONE_PREFIX.length).toLowerCase());
      }
    } catch { /* ignore */ }
    return out.sort();
  }
  function applyDoneList(list) {
    if (!Array.isArray(list)) return;
    for (const id of list) {
      const m = String(id).toLowerCase().match(/^([a-z0-9-]+):(\d+):(\d+)$/);
      if (!m) continue;
      try { localStorage.setItem(DONE_KEY(m[1], Number(m[2]), Number(m[3])), "1"); } catch { /* ignore */ }
    }
  }
  function mergeDone(local, remote) {
    const set = new Set(local.map((x) => String(x).toLowerCase()));
    for (const x of remote || []) set.add(String(x).toLowerCase());
    return [...set].sort();
  }
  function setSyncStatus(text, ok) {
    if (!els.syncStatus) return;
    els.syncStatus.textContent = text;
    els.syncStatus.style.color = ok ? "var(--good)" : "var(--muted)";
    if (els.syncBtn) els.syncBtn.textContent = `SYNC ${state.syncCode || "······"}`;
    if (els.syncInput) els.syncInput.value = state.syncCode;
  }
  function recomputeSummaries() {
    const local = getAllLocalDone();
    const counts = {};
    for (const id of local) {
      const m = id.match(/^([a-z0-9-]+):\d+:\d+$/);
      if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
    }
    if (state.catalog) {
      for (const c of state.catalog) {
        const total = c.exercises || 0;
        const done = Math.min(total, counts[c.id] || 0);
        writeSummary(c.id, done, total);
      }
    } else {
      for (const [cid, done] of Object.entries(counts)) {
        const s = readSummary(cid) || { done: 0, total: 0 };
        writeSummary(cid, done, s.total || 0);
      }
    }
    // refresh visible views without full reload
    if (state.catalog) {
      if (!els.library.hidden) renderLibrary(state.catalog);
    }
    if (state.course) {
      updateCourseProgress();
      renderLessonList();
    }
  }
  async function fetchRemoteProgress(code) {
    try {
      const res = await fetch(`/api/progress?code=${encodeURIComponent(code)}`, { cache: "no-store" });
      if (!res.ok) return [];
      const json = await res.json();
      return Array.isArray(json.done) ? json.done : [];
    } catch { return []; }
  }
  async function pushRemoteNow() {
    const code = state.syncCode || ensureCode();
    if (!code) return;
    try {
      const done = getAllLocalDone();
      const res = await fetch("/api/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, done }),
        cache: "no-store",
      });
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json.done)) {
          applyDoneList(json.done);
          recomputeSummaries();
        }
        setSyncStatus(`Synced · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ✓`, true);
      } else {
        setSyncStatus("Sync unavailable · saved locally", false);
      }
    } catch {
      setSyncStatus("Offline · saved locally", false);
    }
  }
  function queuePush() {
    if (state.syncTimer) clearTimeout(state.syncTimer);
    state.syncTimer = setTimeout(() => { void pushRemoteNow(); }, 800);
  }
  async function pullAndMerge() {
    const code = state.syncCode;
    const remote = await fetchRemoteProgress(code);
    if (!remote.length && !getAllLocalDone().length) {
      setSyncStatus(`Code ${code} · saved locally`, true);
      return;
    }
    const merged = mergeDone(getAllLocalDone(), remote);
    applyDoneList(merged);
    recomputeSummaries();
    // push union back so server has everything
    await pushRemoteNow();
  }

  function lessonDoneCount(course, lessonIndex) {
    return lessonIndex < course.lessons.length
      ? course.lessons[lessonIndex].exercises.filter((_, i) => isDone(course.id, lessonIndex, i)).length
      : 0;
  }

  function courseDoneCount(course) {
    return course.lessons.reduce((sum, _, li) => sum + lessonDoneCount(course, li), 0);
  }

  function courseTotals(course) {
    const exercises = course.lessons.reduce((s, l) => s + l.exercises.length, 0);
    return { lessons: course.lessons.length, exercises };
  }

  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { els.toast.hidden = true; }, 3200);
  }

  function showView(name) {
    els.library.hidden = name !== "library";
    els.course.hidden = name !== "course";
    els.lesson.hidden = name !== "lesson";
    els.home.hidden = name === "library";
    els.progressPill.hidden = name === "library";
  }

  /* ---------- library ---------- */

  async function loadCatalog() {
    if (state.catalog) return state.catalog;
    const res = await fetch("courses/catalog.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("Could not load the course catalog.");
    state.catalog = (await res.json()).courses;
    return state.catalog;
  }

  function renderLibrary(courses) {
    els.grid.textContent = "";
    if (!courses.length) {
      els.grid.innerHTML = '<p class="muted">No courses yet. Add a JSON file under courses/ and run build_catalog.py.</p>';
      return;
    }
    for (const c of courses) {
      const card = document.createElement("article");
      card.className = "card";
      card.tabIndex = 0;
      card.style.setProperty("--glow", c.color);

      const tile = document.createElement("div");
      tile.className = "card-tile";
      tile.style.setProperty("--c1", c.color);
      tile.style.setProperty("--c2", "#1b1140");
      const glyph = document.createElement("span");
      glyph.className = "glyph";
      glyph.textContent = (c.title.replace(/^(Learn|Basics of)\s+/i, "")[0] || "?").toUpperCase();
      tile.append(glyph);

      const body = document.createElement("div");
      body.className = "card-body";
      const h3 = document.createElement("h3");
      h3.textContent = c.title;
      const desc = document.createElement("p");
      desc.textContent = c.description || "";
      const meta = document.createElement("div");
      meta.className = "card-meta";
      meta.textContent = `${c.lessons} lessons \u00b7 ${c.exercises} exercises`;
      const bar = document.createElement("div");
      bar.className = "bar";
      const fill = document.createElement("div");
      bar.append(fill);
      const barText = document.createElement("div");
      barText.className = "bar-text";
      body.append(h3, desc, meta, bar, barText);

      const summary = readSummary(c.id);
      const pct = summary ? Math.round((summary.done / (summary.total || c.exercises || 1)) * 100) : 0;
      fill.style.width = `${pct}%`;
      barText.textContent = pct === 0 ? "Start learning" : `${pct}% complete`;

      card.append(tile, body);
      const open = () => { location.hash = `#/course/${encodeURIComponent(c.id)}`; };
      card.addEventListener("click", open);
      card.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
      els.grid.append(card);
    }
  }

  /* ---------- course page ---------- */

  async function openCourse(id) {
    showView("course");
    els.lessonError.hidden = true;
    try {
      const catalog = await loadCatalog();
      const entry = catalog.find((c) => c.id === id);
      if (!entry) throw new Error("That course is not in the catalog.");

      const res = await fetch(`${entry.path}course.json`, { cache: "no-cache" });
      if (!res.ok) throw new Error("Could not load this course.");
      state.course = await res.json();
      state.course.id = id;
      state.courseId = id;

      els.courseTitle.textContent = state.course.title;
      els.courseDesc.textContent = state.course.description || "";
      updateCourseProgress();
      renderLessonList();
    } catch (err) {
      console.error(err);
      els.courseTitle.textContent = "Could not open this course";
      els.courseDesc.textContent = "";
      els.lessonList.textContent = "";
      els.lessonError.textContent = err.message || String(err);
      els.lessonError.hidden = false;
    }
  }

  function updateCourseProgress() {
    const course = state.course;
    if (!course) return;
    const totals = courseTotals(course);
    const done = courseDoneCount(course);
    const pct = totals.exercises ? Math.round((done / totals.exercises) * 100) : 0;
    els.courseBar.style.width = `${pct}%`;
    els.courseProgressText.textContent =
      `${done} of ${totals.exercises} exercises \u00b7 ${pct}%`;
    els.progressPill.textContent = `${pct}%`;
  }

  function renderLessonList() {
    const course = state.course;
    els.lessonList.textContent = "";
    course.lessons.forEach((lesson, i) => {
      const done = lessonDoneCount(course, i);
      const complete = done === lesson.exercises.length;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "lesson-row";
      row.style.setProperty("--c1", course.color || "#7b5cff");
      row.style.setProperty("--c2", "#1b1140");

      const num = document.createElement("span");
      num.className = "lesson-num";
      num.textContent = String(i + 1);

      const info = document.createElement("span");
      info.className = "info";
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = lesson.title;
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = complete ? "Complete" : `${done}/${lesson.exercises.length} exercises done`;
      info.append(title, sub);

      const badge = document.createElement("span");
      badge.className = "lesson-done";
      badge.textContent = complete ? "\u2713 Complete" : "";

      row.append(num, info, badge);
      row.addEventListener("click", () => {
        location.hash = `#/course/${encodeURIComponent(course.id)}/${i}`;
      });
      els.lessonList.append(row);
    });
  }

  /* ---------- lesson page ---------- */

  function openLesson(index) {
    const course = state.course;
    if (!course || index < 0 || index >= course.lessons.length) return;
    state.lessonIndex = index;
    const lesson = course.lessons[index];

    showView("lesson");
    els.lessonError.hidden = true;
    els.lessonTitle.textContent = `${index + 1}. ${lesson.title}`;
    els.lessonBody.innerHTML = mdToHtml(lesson.body || "");
    els.lessonMeta.textContent = `${lesson.exercises.length} exercises`;

    state.lessonWasComplete = lessonDoneCount(course, index) === lesson.exercises.length;

    els.exercises.textContent = "";
    lesson.exercises.forEach((ex, i) => {
      els.exercises.append(renderExercise(course, index, ex, i));
    });

    els.prevLesson.disabled = index <= 0;
    els.nextLesson.disabled = index >= course.lessons.length - 1;
    els.lessonLabel.textContent = `Lesson ${index + 1} of ${course.lessons.length}`;
    window.scrollTo(0, 0);
  }

  function renderExercise(course, lessonIndex, ex, i) {
    const root = document.createElement("div");
    root.className = "exercise" + (isDone(course.id, lessonIndex, i) ? " done" : "");
    root.dataset.kind = ex.type;

    const head = document.createElement("div");
    head.className = "ex-head";
    const num = document.createElement("span");
    num.className = "ex-num";
    num.textContent = String(i + 1);
    const tag = document.createElement("span");
    tag.className = "ex-tag";
    tag.textContent = {
      mcq: "Multiple choice",
      input: "Type the answer",
      order: "Put in order",
      md: "Markdown editor",
      sql: "SQL editor",
    }[ex.type] || "Exercise";
    const check = document.createElement("span");
    check.className = "ex-check";
    check.textContent = root.classList.contains("done") ? "\u2713 Done" : "";
    head.append(num, tag, check);

    const prompt = document.createElement("p");
    prompt.className = "ex-prompt";
    prompt.innerHTML = mdToHtml(ex.prompt);

    const body = document.createElement("div");
    body.className = "ex-body";

    const feedback = document.createElement("p");
    feedback.className = "ex-feedback";

    const ctx = {
      root, feedback, body, ex,
      complete(ok, message) {
        feedback.textContent = message;
        feedback.classList.toggle("ok", ok);
        feedback.classList.toggle("bad", !ok);
        if (!ok) return;
        if (!root.classList.contains("done")) {
          root.classList.add("done");
          setDone(course.id, lessonIndex, i);
          check.textContent = "\u2713 Done";
          updateCourseProgress();
          const summary = readSummary(course.id) || { done: 0, total: courseTotals(course).exercises };
          summary.done += 1;
          summary.total = courseTotals(course).exercises;
          writeSummary(course.id, summary.done, summary.total);
          queuePush();
          const lesson = course.lessons[lessonIndex];
          if (lessonDoneCount(course, lessonIndex) === lesson.exercises.length &&
              !state.lessonWasComplete) {
            state.lessonWasComplete = true;
            toast("Lesson complete! On to the next one.");
          }
        }
      },
    };

    if (ex.type === "mcq") buildMCQ(ctx);
    else if (ex.type === "input") buildInput(ctx);
    else if (ex.type === "order") buildOrder(ctx);
    else if (ex.type === "md") buildMarkdown(ctx);
    else if (ex.type === "sql") buildSQL(ctx);
    else {
      feedback.textContent = "Unknown exercise type.";
      feedback.classList.add("bad");
    }

    if (ex.hint) {
      const hintBtn = document.createElement("button");
      hintBtn.type = "button";
      hintBtn.className = "hint-btn";
      hintBtn.textContent = "Show hint";
      const hint = document.createElement("p");
      hint.className = "hint-text";
      hint.hidden = true;
      hint.textContent = ex.hint;
      hintBtn.addEventListener("click", () => {
        hint.hidden = !hint.hidden;
        hintBtn.textContent = hint.hidden ? "Show hint" : "Hide hint";
      });
      body.append(hintBtn, hint);
    }

    root.append(head, prompt, body, feedback);
    return root;
  }

  /* ---------- exercise: multiple choice ---------- */

  function buildMCQ(ctx) {
    const { ex, body } = ctx;
    let solved = ctx.root.classList.contains("done");
    ex.options.forEach((opt, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "opt";
      btn.dataset.i = String(i);
      btn.textContent = opt;
      if (solved) {
        btn.disabled = true;
        if (i === ex.answer) btn.classList.add("correct");
      }
      btn.addEventListener("click", () => {
        if (solved) return;
        if (i === ex.answer) {
          solved = true;
          body.querySelectorAll(".opt").forEach((b) => {
            b.disabled = true;
            b.classList.remove("wrong");
          });
          btn.classList.add("correct");
          ctx.complete(true, "Correct! " + (ex.explain || ""));
        } else {
          btn.classList.add("wrong");
          ctx.complete(false, "Not quite. Try another answer." + (ex.explain ? "" : ""));
        }
      });
      body.append(btn);
    });
  }

  /* ---------- exercise: type the answer ---------- */

  function normText(s) {
    return s.trim().replace(/\s+/g, " ");
  }

  function buildInput(ctx) {
    const { ex, body } = ctx;
    const row = document.createElement("div");
    row.className = "answer-row";
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "Type your answer\u2026";
    input.setAttribute("aria-label", "Your answer");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "check-btn";
    btn.textContent = "Check";
    row.append(input, btn);
    body.append(row);

    const check = () => {
      const given = normText(input.value);
      if (!given) {
        ctx.complete(false, "Type an answer first.");
        return;
      }
      const match = ex.answers.some((a) => {
        const want = normText(a);
        return ex.caseSensitive ? given === want : given.toLowerCase() === want.toLowerCase();
      });
      if (match) ctx.complete(true, "Correct! " + (ex.explain || ""));
      else ctx.complete(false, "Not quite. Check your answer and try again.");
    };
    btn.addEventListener("click", check);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") check(); });
    if (ctx.root.classList.contains("done")) input.disabled = true;
  }

  /* ---------- exercise: put in order ---------- */

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function buildOrder(ctx) {
    const { ex, body } = ctx;
    const done = ctx.root.classList.contains("done");

    const pool = document.createElement("div");
    pool.className = "order-pool";
    const tray = document.createElement("div");
    tray.className = "order-tray";
    const actions = document.createElement("div");
    actions.className = "ex-actions";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "reset-btn";
    reset.textContent = "Reset";
    actions.append(reset);
    body.append(tray, pool, actions);

    const chosen = [];
    const items = ex.items;

    const renderPool = () => {
      pool.textContent = "";
      if (done) return;
      shuffle(items.map((_, i) => i)).forEach((i) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "opt";
        btn.dataset.i = String(i);
        btn.textContent = items[i];
        btn.addEventListener("click", () => {
          chosen.push(i);
          btn.remove();
          const placed = document.createElement("span");
          placed.className = "placed";
          placed.textContent = `${chosen.length}. ${items[i]}`;
          tray.append(placed);
          if (chosen.length === items.length) evaluate();
        });
        pool.append(btn);
      });
    };

    const evaluate = () => {
      const correct = chosen.every((v, i) => v === i);
      tray.classList.add(correct ? "ok" : "bad");
      if (correct) {
        pool.textContent = "";
        ctx.complete(true, "Correct! " + (ex.explain || ""));
      } else {
        ctx.complete(false, "That order is not right. Press Reset and try again.");
      }
    };

    reset.addEventListener("click", () => {
      chosen.length = 0;
      tray.textContent = "";
      tray.classList.remove("ok", "bad");
      renderPool();
    });

    if (done) {
      items.forEach((item, i) => {
        const placed = document.createElement("span");
        placed.className = "placed";
        placed.textContent = `${i + 1}. ${item}`;
        tray.append(placed);
      });
      tray.classList.add("ok");
      ctx.feedback.textContent = "Already completed.";
    } else {
      renderPool();
    }
  }

  /* ---------- exercise: markdown editor ---------- */

  function buildMarkdown(ctx) {
    const { ex, body } = ctx;
    const done = ctx.root.classList.contains("done");

    const ta = document.createElement("textarea");
    ta.value = done ? ex.solution : (ex.starter || "");
    ta.spellcheck = false;
    ta.setAttribute("aria-label", "Markdown editor");
    const preview = document.createElement("div");
    preview.className = "md-preview";
    const actions = document.createElement("div");
    actions.className = "ex-actions";
    const check = document.createElement("button");
    check.type = "button";
    check.className = "check-btn";
    check.textContent = "Check";
    actions.append(check);
    body.append(ta, preview, actions);

    const render = () => {
      const src = ta.value.trim();
      preview.innerHTML = src ? mdToHtml(src) : '<p class="empty">The rendered preview appears here as you type.</p>';
    };
    ta.addEventListener("input", render);
    render();

    check.addEventListener("click", () => {
      const src = ta.value;
      if (!src.trim()) {
        ctx.complete(false, "Write some Markdown first.");
        return;
      }
      const missed = ex.patterns.filter((p) => !new RegExp(p.re, "m").test(src));
      if (missed.length) {
        ctx.complete(false, "Almost. Still missing: " + missed.map((p) => p.m).join("; "));
      } else {
        ctx.complete(true, "Correct! " + (ex.explain || ""));
      }
    });
  }

  /* ---------- exercise: SQL editor ---------- */

  const SQL = (() => {
    const AGGS = new Set(["COUNT", "SUM", "AVG", "MIN", "MAX"]);

    function tokenize(sql) {
      const toks = [];
      let i = 0;
      while (i < sql.length) {
        const c = sql[i];
        if (/\s/.test(c)) { i++; continue; }
        if (c === ";") { i++; continue; }
        if (c === "'") {
          let j = i + 1, s = "";
          while (j < sql.length && sql[j] !== "'") s += sql[j++];
          if (j >= sql.length) throw new Error("A text value is missing its closing quote.");
          toks.push({ t: "str", v: s });
          i = j + 1;
          continue;
        }
        if (/[0-9]/.test(c)) {
          let j = i, s = "";
          while (j < sql.length && /[0-9.]/.test(sql[j])) s += sql[j++];
          toks.push({ t: "num", v: parseFloat(s) });
          i = j;
          continue;
        }
        if (/[A-Za-z_]/.test(c)) {
          let j = i, s = "";
          while (j < sql.length && /[A-Za-z0-9_.]/.test(sql[j])) s += sql[j++];
          toks.push({ t: "id", v: s });
          i = j;
          continue;
        }
        const two = sql.slice(i, i + 2);
        if (two === ">=" || two === "<=" || two === "!=" || two === "<>") {
          toks.push({ t: "op", v: two === "<>" ? "!=" : two });
          i += 2;
          continue;
        }
        if (c === "=" || c === "<" || c === ">") { toks.push({ t: "op", v: c }); i++; continue; }
        if (c === "(") { toks.push({ t: "lp" }); i++; continue; }
        if (c === ")") { toks.push({ t: "rp" }); i++; continue; }
        if (c === ",") { toks.push({ t: "comma" }); i++; continue; }
        if (c === "*") { toks.push({ t: "star" }); i++; continue; }
        throw new Error(`I don't understand the character "${c}".`);
      }
      return toks;
    }

    function parse(sql) {
      const toks = tokenize(sql);
      let p = 0;
      const peek = () => toks[p];
      const atKw = (w) => { const t = toks[p]; return !!t && t.t === "id" && t.v.toUpperCase() === w; };
      const eatKw = (w) => { if (!atKw(w)) throw new Error(`Expected the keyword ${w}.`); p++; };
      const next = () => toks[p++];
      const expect = (t, what) => {
        const tok = next();
        if (!tok || tok.t !== t) throw new Error(`Expected ${what}.`);
        return tok;
      };

      eatKw("SELECT");
      const select = [];
      for (;;) {
        if (peek() && peek().t === "star") {
          next();
          select.push({ kind: "star" });
        } else {
          const name = expect("id", "a column name").v;
          if (peek() && peek().t === "lp") {
            next();
            const fn = name.toUpperCase();
            if (!AGGS.has(fn)) throw new Error(`${name}() is not a function I support here.`);
            let arg = "*";
            if (peek() && peek().t === "star") {
              next();
            } else if (peek() && peek().t === "id") {
              arg = next().v;
            }
            expect("rp", "a closing parenthesis");
            select.push({ kind: "agg", fn, arg });
          } else {
            select.push({ kind: "col", name });
          }
        }
        if (peek() && peek().t === "comma") { next(); continue; }
        break;
      }

      eatKw("FROM");
      const from = expect("id", "a table name").v;
      const joins = [];
      while (atKw("JOIN")) {
        p++;
        const table = expect("id", "a table name after JOIN").v;
        eatKw("ON");
        joins.push({ table, on: parseOr() });
      }
      let where = null;
      if (atKw("WHERE")) { p++; where = parseOr(); }
      let orderBy = null;
      if (atKw("ORDER")) {
        p++;
        eatKw("BY");
        const col = expect("id", "a column name after ORDER BY").v;
        let dir = "ASC";
        if (atKw("ASC") || atKw("DESC")) dir = next().v.toUpperCase();
        orderBy = { col, dir };
      }
      let limit = null;
      if (atKw("LIMIT")) { p++; limit = expect("num", "a number after LIMIT").v; }
      if (p < toks.length) throw new Error(`Unexpected "${toks[p].v}" after the end of the query.`);

      return { select, from, joins, where, orderBy, limit };

      function parseOr() {
        let left = parseAnd();
        while (atKw("OR")) { p++; left = { op: "OR", l: left, r: parseAnd() }; }
        return left;
      }
      function parseAnd() {
        let left = parseNot();
        while (atKw("AND")) { p++; left = { op: "AND", l: left, r: parseNot() }; }
        return left;
      }
      function parseNot() {
        if (atKw("NOT")) { p++; return { op: "NOT", e: parseNot() }; }
        if (peek() && peek().t === "lp") {
          p++;
          const e = parseOr();
          expect("rp", "a closing parenthesis");
          return e;
        }
        return parseCmp();
      }
      function parseCmp() {
        const l = parseOperand();
        const tok = next();
        if (!tok || tok.t !== "op") throw new Error("Expected a comparison like =, >, or <.");
        const r = parseOperand();
        return { op: "CMP", cmp: tok.v, l, r };
      }
      function parseOperand() {
        const tok = next();
        if (!tok) throw new Error("The condition ends too early.");
        if (tok.t === "num" || tok.t === "str") return { kind: "lit", v: tok.v };
        if (tok.t === "id") return { kind: "col", name: tok.v };
        throw new Error("Expected a value or a column name in the condition.");
      }
    }

    function run(db, sql) {
      const ast = parse(sql);

      const table = (name) => {
        const t = db.find((t) => t.name.toLowerCase() === name.toLowerCase());
        if (!t) throw new Error(`There is no table called "${name}".`);
        return t;
      };
      const base = table(ast.from);

      const slots = [];
      const colIndex = new Map();
      const register = (tname, cols) => cols.forEach((c) => {
        slots.push({ tname, col: c });
        colIndex.set(`${tname}.${c}`.toLowerCase(), slots.length - 1);
        const plain = c.toLowerCase();
        if (!colIndex.has(plain)) colIndex.set(plain, slots.length - 1);
      });
      const lookup = (name) => {
        const k = name.toLowerCase();
        if (colIndex.has(k)) return colIndex.get(k);
        throw new Error(`There is no column called "${name}".`);
      };

      register(base.name, base.columns);
      let rows = base.rows.map((r) => r.slice());
      for (const j of ast.joins) {
        const jt = table(j.table);
        register(jt.name, jt.columns);
        const joined = [];
        for (const cur of rows) {
          for (const jr of jt.rows) {
            const combined = cur.concat(jr);
            if (evalCond(j.on, combined)) joined.push(combined);
          }
        }
        rows = joined;
      }

      function evalOperand(n, r) {
        return n.kind === "lit" ? n.v : r[lookup(n.name)];
      }
      function evalCond(n, r) {
        if (n.op === "AND") return evalCond(n.l, r) && evalCond(n.r, r);
        if (n.op === "OR") return evalCond(n.l, r) || evalCond(n.r, r);
        if (n.op === "NOT") return !evalCond(n.e, r);
        const a = evalOperand(n.l, r), b = evalOperand(n.r, r);
        switch (n.cmp) {
          case "=": return a === b;
          case "!=": return a !== b;
          case "<": return a < b;
          case ">": return a > b;
          case "<=": return a <= b;
          case ">=": return a >= b;
        }
        return false;
      }

      if (ast.where) rows = rows.filter((r) => evalCond(ast.where, r));

      if (ast.orderBy) {
        const idx = lookup(ast.orderBy.col);
        const desc = ast.orderBy.dir === "DESC";
        rows = rows.slice().sort((a, b) => {
          const x = a[idx], y = b[idx];
          const c = x < y ? -1 : x > y ? 1 : 0;
          return desc ? -c : c;
        });
      }

      const starOnly = ast.select.some((s) => s.kind === "star");
      if (starOnly && ast.select.length !== 1) {
        throw new Error("Use * on its own, not mixed with column names.");
      }

      let outCols, outRows;
      if (starOnly) {
        outCols = slots.map((s) => s.col);
        outRows = rows.map((r) => slots.map((_, i) => r[i]));
      } else if (ast.select.some((s) => s.kind === "agg")) {
        if (ast.select.some((s) => s.kind === "col")) {
          throw new Error("Mixing plain columns with functions is not supported here.");
        }
        const aggValue = (s) => {
          if (s.fn === "COUNT" && s.arg === "*") return rows.length;
          const idx = lookup(s.arg);
          const vals = rows.map((r) => r[idx]).filter((v) => v !== null && v !== undefined);
          if (s.fn === "COUNT") return vals.length;
          if (!vals.length) return null;
          if (s.fn === "SUM") return vals.reduce((a, b) => a + b, 0);
          if (s.fn === "AVG") return vals.reduce((a, b) => a + b, 0) / vals.length;
          if (s.fn === "MIN") return Math.min(...vals);
          return Math.max(...vals);
        };
        outCols = ast.select.map((s) => `${s.fn}(${s.arg})`);
        outRows = [ast.select.map(aggValue)];
      } else {
        const idxs = ast.select.map((s) => lookup(s.name));
        outCols = ast.select.map((s) => s.name.split(".").pop());
        outRows = rows.map((r) => idxs.map((i) => r[i]));
      }

      if (ast.limit !== null) outRows = outRows.slice(0, ast.limit);
      return { columns: outCols, rows: outRows };
    }

    return { run, parse, tokenize };
  })();

  function rowKey(r) {
    return r.map((v) => (typeof v === "number" ? "n:" + (+v.toFixed(6)) : "s:" + String(v))).join("\u0001");
  }

  function sameResult(got, exp, ordered) {
    const colsOk = got.columns.length === exp.columns.length &&
      got.columns.every((c, i) => c.toLowerCase().trim() === exp.columns[i].toLowerCase().trim());
    if (!colsOk) return { ok: false, why: "The columns don't match. Check which columns you asked for." };
    const a = got.rows.map(rowKey);
    const b = exp.rows.map(rowKey);
    const ok = ordered
      ? a.join("|") === b.join("|")
      : a.slice().sort().join("|") === b.slice().sort().join("|");
    return ok
      ? { ok: true }
      : { ok: false, why: "The rows don't match yet. Check your filter, sort order, or values." };
  }

  function buildSQL(ctx) {
    const { ex, body } = ctx;
    const done = ctx.root.classList.contains("done");

    const ta = document.createElement("textarea");
    ta.value = done ? ex.solution : (ex.starter || "SELECT ");
    ta.spellcheck = false;
    ta.setAttribute("aria-label", "SQL editor");
    const actions = document.createElement("div");
    actions.className = "ex-actions";
    const run = document.createElement("button");
    run.type = "button";
    run.className = "run-btn";
    run.textContent = "Run";
    actions.append(run);

    const schema = document.createElement("details");
    schema.className = "sql-schema";
    const summary = document.createElement("summary");
    summary.textContent = "Show tables";
    schema.append(summary);
    ex.db.forEach((t) => {
      const line = document.createElement("div");
      line.className = "table-line";
      line.textContent = `${t.name}(${t.columns.join(", ")}) \u00b7 ${t.rows.length} rows`;
      schema.append(line);
    });

    const result = document.createElement("div");
    result.className = "sql-result";
    body.append(ta, actions, schema, result);

    const renderResult = (out) => {
      result.textContent = "";
      if (!out.columns.length || (!out.rows.length && out.rows.constructor !== Array)) {
        result.innerHTML = '<p class="muted">No rows returned.</p>';
        return;
      }
      const table = document.createElement("table");
      const thead = document.createElement("tr");
      out.columns.forEach((c) => {
        const th = document.createElement("th");
        th.textContent = c;
        thead.append(th);
      });
      table.append(thead);
      out.rows.forEach((r) => {
        const tr = document.createElement("tr");
        r.forEach((v) => {
          const td = document.createElement("td");
          td.textContent = v === null || v === undefined ? "NULL" : String(v);
          if (v === null || v === undefined) td.className = "empty-cell";
          tr.append(td);
        });
        table.append(tr);
      });
      result.append(table);
      if (!out.rows.length) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = "No rows returned.";
        result.append(empty);
      }
    };

    const doRun = () => {
      const src = ta.value.trim();
      if (!src) {
        ctx.complete(false, "Write a query first.");
        return;
      }
      let out;
      try {
        out = SQL.run(ex.db, src);
      } catch (err) {
        result.textContent = "";
        ctx.complete(false, "SQL error: " + err.message);
        return;
      }
      renderResult(out);
      const check = sameResult(out, ex.expected, !!ex.ordered);
      if (check.ok) ctx.complete(true, "Correct! " + (ex.explain || ""));
      else ctx.complete(false, check.why);
    };
    run.addEventListener("click", doRun);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) doRun();
    });

    if (done) doRun();
  }

  /* ---------- routing ---------- */

  async function route() {
    const courseMatch = location.hash.match(/^#\/course\/([^/]+)(?:\/(\d+))?$/);
    if (courseMatch) {
      const id = decodeURIComponent(courseMatch[1]);
      if (!state.course || state.courseId !== id) {
        await openCourse(id);
      }
      if (courseMatch[2] !== undefined) {
        openLesson(Number(courseMatch[2]));
      } else {
        showView("course");
        updateCourseProgress();
        renderLessonList();
      }
      return;
    }
    showView("library");
    document.title = "Learnloop";
    state.course = null;
    state.courseId = "";
    try {
      renderLibrary(await loadCatalog());
    } catch (err) {
      els.grid.textContent = "";
      const p = document.createElement("p");
      p.className = "error";
      p.textContent = err.message;
      els.grid.append(p);
    }
  }

  function initSyncUI() {
    state.syncCode = ensureCode();
    setSyncStatus(`Code ${state.syncCode} · synced`, true);
    if (els.syncBtn) els.syncBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (els.syncPanel) els.syncPanel.hidden = !els.syncPanel.hidden;
    });
    document.addEventListener("click", (e) => {
      if (els.syncPanel && !els.syncPanel.hidden && !els.syncPanel.contains(e.target) && e.target !== els.syncBtn) {
        els.syncPanel.hidden = true;
      }
    });
    const applyCode = async (code) => {
      const clean = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
      if (clean.length !== 6) { setSyncStatus("Code must be 6 characters", false); return; }
      writeCode(clean);
      state.syncCode = clean;
      setSyncStatus(`Switching to ${clean}…`, true);
      await pullAndMerge();
      toast("Sync updated");
    };
    if (els.syncInput) {
      els.syncInput.addEventListener("change", () => { void applyCode(els.syncInput.value); });
      els.syncInput.addEventListener("keydown", (e) => { if (e.key === "Enter") void applyCode(els.syncInput.value); });
    }
    if (els.syncNewBtn) els.syncNewBtn.addEventListener("click", () => { void applyCode(genCode()); });
    // initial pull (non-blocking)
    void pullAndMerge();
  }

  function init() {
    initSyncUI();
    els.home.addEventListener("click", () => { location.hash = "#/"; });
    els.prevLesson.addEventListener("click", () => {
      if (state.lessonIndex > 0) {
        location.hash = `#/course/${encodeURIComponent(state.courseId)}/${state.lessonIndex - 1}`;
      }
    });
    els.nextLesson.addEventListener("click", () => {
      if (state.course && state.lessonIndex < state.course.lessons.length - 1) {
        location.hash = `#/course/${encodeURIComponent(state.courseId)}/${state.lessonIndex + 1}`;
      }
    });
    window.addEventListener("hashchange", route);
    route();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW failed", err));
    }

    window.learnloop = { runSQL: SQL.run };
  }

  init();
})();
