#!/usr/bin/env python3
"""Build courses/catalog.json from courses/*/course.json and validate content.

Usage (from the project folder):
  python3 build_catalog.py

To add a course later: create courses/<id>/course.json in the same shape as the
existing ones and run this script. It writes the catalog and exits nonzero with
a report if any exercise is malformed.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
COURSES = ROOT / "courses"

KINDS = {
    "mcq": lambda ex: require(ex, ["options", "answer"]) and
        isinstance(ex["options"], list) and len(ex["options"]) >= 2 and
        isinstance(ex["answer"], int) and 0 <= ex["answer"] < len(ex["options"]),
    "input": lambda ex: require(ex, ["answers"]) and
        isinstance(ex["answers"], list) and len(ex["answers"]) >= 1 and
        all(isinstance(a, str) and a.strip() for a in ex["answers"]),
    "order": lambda ex: require(ex, ["items"]) and
        isinstance(ex["items"], list) and len(ex["items"]) >= 2 and
        len(set(ex["items"])) == len(ex["items"]),
    "md": lambda ex: require(ex, ["patterns", "solution"]) and
        isinstance(ex["patterns"], list) and len(ex["patterns"]) >= 1 and
        all(p.get("re") and p.get("m") for p in ex["patterns"]) and
        all(compiles(p["re"]) for p in ex["patterns"]),
    "sql": lambda ex: require(ex, ["db", "solution", "expected"]) and
        valid_db(ex["db"]) and valid_expected(ex["expected"]) and
        isinstance(ex["solution"], str) and ex["solution"].strip(),
}


def require(ex, fields):
    return all(f in ex and ex[f] is not None for f in fields)


def compiles(pattern):
    try:
        re.compile(pattern, re.MULTILINE)
        return True
    except re.error:
        return False


def valid_db(db):
    if not isinstance(db, list) or not db:
        return False
    for t in db:
        if not isinstance(t, dict):
            return False
        cols, rows = t.get("columns"), t.get("rows")
        if not isinstance(cols, list) or not cols or not isinstance(rows, list):
            return False
        for r in rows:
            if not isinstance(r, list) or len(r) != len(cols):
                return False
    return True


def valid_expected(exp):
    return isinstance(exp, dict) and isinstance(exp.get("columns"), list) and \
        isinstance(exp.get("rows"), list) and \
        all(isinstance(r, list) and len(r) == len(exp["columns"]) for r in exp["rows"])


def validate(course, path):
    errors = []
    cid = course.get("id") or path.parent.name
    if not course.get("title"):
        errors.append(f"{cid}: missing title")
    lessons = course.get("lessons")
    if not isinstance(lessons, list) or not lessons:
        errors.append(f"{cid}: no lessons")
        return errors, 0
    exercises = 0
    for li, lesson in enumerate(lessons):
        if not lesson.get("title"):
            errors.append(f"{cid} lesson {li + 1}: missing title")
        if not isinstance(lesson.get("body"), str) or not lesson["body"].strip():
            errors.append(f"{cid} lesson {li + 1}: missing body")
        exs = lesson.get("exercises")
        if not isinstance(exs, list) or not exs:
            errors.append(f"{cid} lesson {li + 1}: no exercises")
            continue
        exercises += len(exs)
        for ei, ex in enumerate(exs):
            where = f"{cid} lesson {li + 1} exercise {ei + 1}"
            kind = ex.get("type")
            if kind not in KINDS:
                errors.append(f"{where}: unknown type {kind!r}")
                continue
            if not (isinstance(ex.get("prompt"), str) and ex["prompt"].strip()):
                errors.append(f"{where}: missing prompt")
            if not KINDS[kind](ex):
                errors.append(f"{where}: malformed {kind} exercise")
    return errors, exercises


def main():
    entries = []
    problems = []
    for course_file in sorted(COURSES.glob("*/course.json")):
        course = json.loads(course_file.read_text(encoding="utf-8"))
        errors, exercises = validate(course, course_file)
        problems.extend(errors)
        course_id = course.get("id") or course_file.parent.name
        entries.append({
            "id": course_id,
            "title": course.get("title", course_id),
            "subtitle": course.get("subtitle", ""),
            "description": course.get("description", ""),
            "color": course.get("color", "#7b5cff"),
            "lessons": len(course.get("lessons", [])),
            "exercises": exercises,
            "path": f"courses/{course_id}/",
        })
    (COURSES / "catalog.json").write_text(
        json.dumps({"courses": entries}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"catalog: {len(entries)} course(s), "
          f"{sum(e['lessons'] for e in entries)} lessons, "
          f"{sum(e['exercises'] for e in entries)} exercises")
    if problems:
        print("\n".join(problems))
        sys.exit(1)


if __name__ == "__main__":
    main()
